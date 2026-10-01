#!/usr/bin/python3
"""Trusted IRSA-003 decision boundary reference implementation.

The supported entrypoint is the independently provisioned static bootstrap,
which remains this process's parent and starts Python with a complete
environment replacement. Disposable tests patch only the fixed policy path;
they do not prove host provisioning.
"""

import argparse
import datetime
import hashlib
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import selectors
import signal
import time
import resource
import shlex


DEFAULT_TRUST_POLICY_PATH = "/etc/linmas/irsa003/trust-policy.json"
POLICY_SCHEMA_VERSION = 2
DIAGNOSTIC_KIND = "irsa003-collection-diagnostic-v2"
CLEAN_KIND = "irsa003-clean-acceptance-v2"
CONSUMPTION_KIND = "irsa003-synchronous-consumption-v1"
CHILD_ENVIRONMENT_POLICY = "bubblewrap-minimal-mount-worker-v2"
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
MAX_WORKSPACE_BYTES = 256 * 1024 * 1024
MAX_WORKSPACE_SCAN_ATTEMPTS = 3
MAX_WORKSPACE_SCAN_SECONDS = 1.0
MAX_ARCHIVE_MEMBERS = 20000
MAX_TIMEOUT_SECONDS = 120
FINALIZING = False
BOOTSTRAP_PID = None


class Cancelled(BaseException):
    pass


def on_cancel(signum, frame):
    if not FINALIZING:
        raise Cancelled(signum)


def final_acceptance_gate():
    """Bootstrap serializes queued cancellation before the final decision.

    Grant is the linearization point; output/marker IO must still succeed.
    Termination after grant is deferred; failures never report acceptance.
    """
    global FINALIZING
    if FINALIZING:
        return
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGUSR2})
    os.kill(BOOTSTRAP_PID, signal.SIGUSR1)
    received = signal.sigtimedwait({signal.SIGUSR2}, 3)
    if received is None or received.si_pid != BOOTSTRAP_PID:
        fail("bootstrap final acceptance gate was not granted")
    FINALIZING = True

VALID_MODES = frozenset(("collect", "clean", "consume"))
BOOTSTRAP_ENVIRONMENT = {
    "PATH": "/usr/bin:/bin",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "LINMAS_IRSA003_BOOTSTRAP": "static-empty-environment-v1",
}


def fail(message):
    raise RuntimeError(message)


def canonical_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def sha256_file(file_path):
    digest = hashlib.sha256()
    with open(file_path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_keys(value, expected, label):
    if not isinstance(value, dict) or set(value) != set(expected):
        fail(f"{label} schema is not exact")


def absolute_path(value, label):
    if not isinstance(value, str) or not os.path.isabs(value) or "\x00" in value:
        fail(f"{label} must be an absolute path")
    return os.path.abspath(value)


def path_inside(parent, candidate):
    parent_real = os.path.realpath(parent)
    candidate_real = os.path.realpath(candidate)
    return candidate_real == parent_real or candidate_real.startswith(parent_real + os.sep)


def mode_from_policy(value, label):
    if not isinstance(value, str) or not value.isdigit() or len(value) not in (3, 4):
        fail(f"{label} mode is invalid")
    mode = int(value, 8)
    if mode & 0o022:
        fail(f"{label} policy permits group/world writes")
    return mode


def assert_path_ancestors(file_path, label, trust_owner_uid):
    absolute = os.path.abspath(file_path)
    current = os.path.sep
    for component in [part for part in absolute.split(os.path.sep) if part][:-1]:
        current = os.path.join(current, component)
        try:
            item = os.lstat(current)
        except OSError as error:
            fail(f"{label} ancestor is unavailable: {error}")
        if stat.S_ISLNK(item.st_mode) or not stat.S_ISDIR(item.st_mode):
            fail(f"{label} has a non-directory or symlink ancestor")
        root_sticky = item.st_uid == 0 and bool(item.st_mode & stat.S_ISVTX)
        if item.st_uid not in (0, trust_owner_uid) or ((item.st_mode & 0o022) and not root_sticky):
            fail(f"{label} ancestor ownership/writeability is unsafe")


def regular_file_identity(file_path, label, expected_owner=None, expected_mode=None, trust_owner_uid=None):
    absolute = absolute_path(file_path, label)
    if trust_owner_uid is not None:
        assert_path_ancestors(absolute, label, trust_owner_uid)
    try:
        item = os.lstat(absolute)
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    if stat.S_ISLNK(item.st_mode) or not stat.S_ISREG(item.st_mode):
        fail(f"{label} must be a regular non-symlink file")
    if expected_owner is not None and item.st_uid != expected_owner:
        fail(f"{label} owner does not match the trust policy")
    if item.st_mode & 0o022:
        fail(f"{label} is group/world writable")
    if expected_mode is not None and stat.S_IMODE(item.st_mode) != expected_mode:
        fail(f"{label} mode does not match the trust policy")
    return {
        "path": absolute,
        "bytes": item.st_size,
        "sha256": sha256_file(absolute),
        "ownerUid": item.st_uid,
        "mode": format(stat.S_IMODE(item.st_mode), "04o"),
    }


def regular_directory(file_path, label, expected_owner=None, expected_mode=None, trust_owner_uid=None):
    absolute = absolute_path(file_path, label)
    if trust_owner_uid is not None:
        assert_path_ancestors(absolute, label, trust_owner_uid)
    try:
        item = os.lstat(absolute)
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    if stat.S_ISLNK(item.st_mode) or not stat.S_ISDIR(item.st_mode):
        fail(f"{label} must be a regular non-symlink directory")
    if expected_owner is not None and item.st_uid != expected_owner:
        fail(f"{label} owner does not match the trust policy")
    if item.st_mode & 0o022:
        fail(f"{label} is group/world writable")
    if expected_mode is not None and stat.S_IMODE(item.st_mode) != expected_mode:
        fail(f"{label} mode does not match the trust policy")
    return item


def validate_identity_spec(spec, label, trust_owner_uid, observed_version=None):
    keys = {"path", "bytes", "sha256", "ownerUid", "mode"}
    if observed_version is not None:
        keys.add("version")
    require_keys(spec, keys, label)
    actual = regular_file_identity(
        spec["path"], label, spec["ownerUid"], mode_from_policy(spec["mode"], label), trust_owner_uid
    )
    for field in ("path", "bytes", "sha256", "ownerUid", "mode"):
        if actual[field] != spec[field]:
            fail(f"{label} {field} does not match the trust policy")
    if observed_version is not None and spec["version"] != observed_version:
        fail(f"{label} version does not match the trust policy")
    return actual


def validate_inventory(spec, label, trust_owner_uid):
    require_keys(spec, {"root", "ownerUid", "fileCount", "implementationSha256", "files"}, label)
    root = absolute_path(spec["root"], f"{label} root")
    regular_directory(root, f"{label} root", spec["ownerUid"], trust_owner_uid=trust_owner_uid)
    expected = {}
    for entry in spec["files"]:
        require_keys(entry, {"path", "bytes", "sha256"}, f"{label} entry")
        relative = entry["path"]
        if (
            not isinstance(relative, str)
            or not relative
            or os.path.isabs(relative)
            or "\\" in relative
            or any(part in ("", ".", "..") for part in relative.split("/"))
            or relative in expected
        ):
            fail(f"{label} inventory path is unsafe")
        expected[relative] = entry
    actual = {}
    for current_root, directories, names in os.walk(root, topdown=True, followlinks=False):
        directories.sort()
        names.sort()
        for directory in directories:
            item = os.lstat(os.path.join(current_root, directory))
            if stat.S_ISLNK(item.st_mode) or not stat.S_ISDIR(item.st_mode) or item.st_uid != spec["ownerUid"] or item.st_mode & 0o022:
                fail(f"{label} directory authority is unsafe")
        for name in names:
            file_path = os.path.join(current_root, name)
            item = os.lstat(file_path)
            if stat.S_ISLNK(item.st_mode) or not stat.S_ISREG(item.st_mode) or item.st_uid != spec["ownerUid"] or item.st_mode & 0o022:
                fail(f"{label} file authority is unsafe")
            relative = os.path.relpath(file_path, root).replace(os.sep, "/")
            actual[relative] = {"path": relative, "bytes": item.st_size, "sha256": sha256_file(file_path)}
    ordered = [actual[key] for key in sorted(actual)]
    material = {"schemaVersion": 1, "files": ordered}
    if set(actual) != set(expected) or any(actual[key] != expected[key] for key in actual):
        fail(f"{label} inventory is incomplete or stale")
    if spec["fileCount"] != len(ordered) or spec["implementationSha256"] != sha256_bytes(canonical_bytes(material)):
        fail(f"{label} implementation identity is stale")
    return {
        "root": root,
        "ownerUid": spec["ownerUid"],
        "fileCount": len(ordered),
        "implementationSha256": spec["implementationSha256"],
    }


def parse_timestamp(value, label):
    if not isinstance(value, str):
        fail(f"{label} is invalid")
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        fail(f"{label} is invalid")
    if parsed.tzinfo is None:
        fail(f"{label} must include a timezone")
    return parsed


def load_policy(policy_path):
    policy_identity = regular_file_identity(policy_path, "trust policy")
    try:
        with open(policy_path, "rb") as handle:
            policy_bytes = handle.read()
        policy = json.loads(policy_bytes.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"trust policy is invalid: {error}")
    expected = {
        "schemaVersion", "policyId", "trustOwnerUid", "workerUid", "workerGid",
        "candidateRoot", "artifactRoot", "temporaryRoot", "outputRoot", "timeoutSeconds",
        "request", "authorizedRevision", "bootstrap", "launcher", "python", "node",
        "git", "bubblewrap", "npm", "verifier", "workerRuntime",
    }
    require_keys(policy, expected, "trust policy")
    if policy["schemaVersion"] != POLICY_SCHEMA_VERSION:
        fail("trust policy schemaVersion is invalid")
    owner = policy["trustOwnerUid"]
    if not isinstance(owner, int) or owner < 0 or policy_identity["ownerUid"] != owner:
        fail("trust policy owner is not anchored independently")
    assert_path_ancestors(policy_path, "trust policy", owner)
    if os.geteuid() != owner:
        fail("trusted parent effective UID does not match the trust owner")
    if (
        not isinstance(policy["workerUid"], int)
        or not isinstance(policy["workerGid"], int)
        or policy["workerUid"] in (0, owner)
        or policy["workerGid"] < 0
    ):
        fail("worker identity is not separated from root and trust owner")
    if not isinstance(policy["timeoutSeconds"], int) or not 0 < policy["timeoutSeconds"] <= MAX_TIMEOUT_SECONDS:
        fail("trust policy timeout is invalid")
    request = policy["request"]
    require_keys(request, {"id", "mode", "notBefore", "expiresAt", "acceptance"}, "authorized request")
    if not isinstance(request["id"], str) or len(request["id"]) < 16 or request["mode"] not in ("collect", "clean"):
        fail("authorized request identity or mode is invalid")
    now = datetime.datetime.now(datetime.timezone.utc)
    if not parse_timestamp(request["notBefore"], "request notBefore") <= now <= parse_timestamp(request["expiresAt"], "request expiresAt"):
        fail("authorized request is not currently valid")
    revision = policy["authorizedRevision"]
    require_keys(revision, {"commit", "tree"}, "authorized revision")
    if (
        not isinstance(revision["commit"], str) or len(revision["commit"]) != 40
        or not isinstance(revision["tree"], str) or len(revision["tree"]) != 40
    ):
        fail("authorized revision must bind a full commit and tree")
    policy["_bytes"] = policy_bytes
    policy["_identity"] = policy_identity
    return policy


def clean_environment(workspace):
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": workspace,
        "TMPDIR": workspace,
        "TMP": workspace,
        "TEMP": workspace,
        "XDG_CONFIG_HOME": workspace,
        "XDG_CACHE_HOME": workspace,
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_OPTIONAL_LOCKS": "0",
    }


def workspace_bytes(root, deadline=None):
    """Complete a bounded scan, or reject churn/error/observed excess.

    Polling is neither an atomic filesystem snapshot nor a disk quota. An
    incomplete scan is discarded in full, never interpreted as zero usage.
    Directory descriptors and O_NOFOLLOW keep traversal inside this workspace.
    """
    scan_deadline = time.monotonic() + MAX_WORKSPACE_SCAN_SECONDS
    if deadline is not None:
        scan_deadline = min(scan_deadline, deadline)

    class ChangedDirectory(Exception):
        pass

    def check_deadline():
        if time.monotonic() >= scan_deadline:
            fail("workspace accounting exceeded bounded scan deadline")

    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        root_fd = os.open(root, flags)
    except OSError as error:
        fail(f"workspace accounting cannot open root ({type(error).__name__}, errno={error.errno})")
    try:
        for _ in range(MAX_WORKSPACE_SCAN_ATTEMPTS):
            total = 0

            def scan(directory_fd):
                nonlocal total
                check_deadline()
                for name in os.listdir(directory_fd):
                    check_deadline()
                    item = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                    if stat.S_ISDIR(item.st_mode):
                        child_fd = os.open(name, flags, dir_fd=directory_fd)
                        try:
                            opened = os.fstat(child_fd)
                            if (opened.st_dev, opened.st_ino) != (item.st_dev, item.st_ino):
                                raise ChangedDirectory()
                            scan(child_fd)
                        finally:
                            os.close(child_fd)
                    else:
                        total += item.st_size
                        # An observed excess is conclusive even if a later
                        # entry disappears. Never erase it through a rescan.
                        if total > MAX_WORKSPACE_BYTES:
                            fail("workspace accounting exceeded workspace disk limit")

            try:
                scan(root_fd)
                check_deadline()
                return total
            except (FileNotFoundError, ChangedDirectory):
                check_deadline()
                # Only observed disappearance/replacement merits a full retry.
                # Yield briefly so concurrent cleanup can settle before the
                # next complete scan. The existing attempt and scan deadlines
                # still bound this wait and every retry.
                remaining = scan_deadline - time.monotonic()
                if remaining <= 0:
                    check_deadline()
                time.sleep(min(0.01, remaining))
                check_deadline()
                # Permission, invalid-path and other errors remain failures.
        fail(f"workspace accounting remained unstable after {MAX_WORKSPACE_SCAN_ATTEMPTS} scans")
    except OSError as error:
        fail(f"workspace accounting failed ({type(error).__name__}, errno={error.errno})")
    finally:
        os.close(root_fd)


def child_limits(snapshot_process=False):
    # Individual files and CPU bounded even between the streaming polls.
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_BYTES))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (120, 120))
    if snapshot_process:
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))


def terminate_process(process):
    # Every spawned trusted subprocess has a session. Bubblewrap additionally
    # owns a private PID namespace, so candidate descendants cannot escape it.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=0.25)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=1)


def run_bounded(args, cwd, env, timeout, label, sink=None, output_limit=MAX_OUTPUT_BYTES, disk_root=None):
    process = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               close_fds=True, start_new_session=True,
                               preexec_fn=lambda: child_limits(label.startswith("trusted snapshot")))
    output, errors = bytearray(), bytearray()
    counts = {"stdout": 0, "stderr": 0}
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as poller:
            for name, pipe in (("stdout", process.stdout), ("stderr", process.stderr)):
                os.set_blocking(pipe.fileno(), False)
                poller.register(pipe, selectors.EVENT_READ, name)
            while poller.get_map() or process.poll() is None:
                if time.monotonic() >= deadline:
                    fail(f"{label} exceeded the bounded timeout")
                if disk_root:
                    workspace_bytes(disk_root, deadline=deadline)
                for key, _ in poller.select(0.05):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        poller.unregister(key.fileobj)
                        continue
                    counts[key.data] += len(chunk)
                    bound = output_limit if key.data == "stdout" else MAX_OUTPUT_BYTES
                    if counts[key.data] > bound:
                        fail(f"{label} output exceeded the bounded limit")
                    if key.data == "stdout" and sink is not None:
                        sink.write(chunk)
                    else:
                        (output if key.data == "stdout" else errors).extend(chunk)
        if process.returncode != 0:
            detail = errors.decode("utf-8", errors="replace").strip()[:500]
            fail(f"{label} failed" + (f": {detail}" if detail else ""))
        return bytes(output)
    finally:
        # Also terminate descendants that retained a pipe after parent exit.
        terminate_process(process)
        process.stdout.close()
        process.stderr.close()


def git_output(git_path, repository_root, args, env, label):
    output = run_bounded([git_path, *args], repository_root, env, 30, label)
    return output.decode("utf-8", errors="strict").strip()


def git_state(policy, git_path, candidate_root, env):
    head = git_output(git_path, candidate_root, ["rev-parse", "HEAD"], env, "trusted Git HEAD")
    tree = git_output(git_path, candidate_root, ["rev-parse", "HEAD^{tree}"], env, "trusted Git tree")
    status_bytes = run_bounded(
        [git_path, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        candidate_root,
        env,
        30,
        "trusted Git status",
    )
    expected = policy["authorizedRevision"]
    if head != expected["commit"] or tree != expected["tree"]:
        fail("candidate HEAD/tree is not the independently authorized revision")
    entries = [entry.decode("utf-8", errors="strict") for entry in status_bytes.split(b"\0") if entry]
    return {"head": head, "tree": tree, "status": entries, "statusSha256": sha256_bytes(status_bytes)}


def validate_bootstrap(policy, bootstrap_parent_pid):
    owner = policy["trustOwnerUid"]
    if sys.flags.isolated != 1 or sys.flags.ignore_environment != 1:
        fail("launcher requires Python isolated and ignore-environment flags")
    if os.environ != BOOTSTRAP_ENVIRONMENT:
        fail("Python did not receive the static bootstrap environment")
    if bootstrap_parent_pid != os.getppid():
        fail("bootstrap parent PID is not the actual parent")
    parent_path = os.path.realpath(f"/proc/{bootstrap_parent_pid}/exe")
    if parent_path != absolute_path(policy["bootstrap"]["path"], "bootstrap path"):
        fail("launcher parent is not the provisioned static bootstrap")
    bootstrap_identity = validate_identity_spec(policy["bootstrap"], "static bootstrap", owner)
    launcher_identity = validate_identity_spec(policy["launcher"], "Python launcher", owner)
    if launcher_identity["path"] != os.path.realpath(__file__):
        fail("running launcher path is not policy-bound")
    python_identity = validate_identity_spec(
        policy["python"], "Python runtime", owner, platform.python_version()
    )
    if python_identity["path"] != os.path.realpath(sys.executable):
        fail("running Python path is not policy-bound")
    return bootstrap_identity, launcher_identity, python_identity


def validate_runtime(policy):
    owner = policy["trustOwnerUid"]
    node_version = run_bounded(
        [policy["node"]["path"], "--version"], "/", BOOTSTRAP_ENVIRONMENT, 5, "Node version"
    ).decode("utf-8", errors="strict").strip()
    node = validate_identity_spec(policy["node"], "Node runtime", owner, node_version)
    git_version = run_bounded(
        [policy["git"]["path"], "--version"], "/", BOOTSTRAP_ENVIRONMENT, 5, "Git version"
    ).decode("utf-8", errors="strict").strip()
    git_identity = validate_identity_spec(policy["git"], "Git runtime", owner, git_version)
    bwrap_version = run_bounded(
        [policy["bubblewrap"]["path"], "--version"], "/", BOOTSTRAP_ENVIRONMENT, 5, "Bubblewrap version"
    ).decode("utf-8", errors="strict").strip()
    bwrap = validate_identity_spec(policy["bubblewrap"], "Bubblewrap runtime", owner, bwrap_version)

    require_keys(policy["npm"], {"inventory", "cliPath", "version"}, "npm policy")
    npm = validate_inventory(policy["npm"]["inventory"], "npm implementation", owner)
    npm_cli = regular_file_identity(
        policy["npm"]["cliPath"], "npm CLI", npm["ownerUid"], trust_owner_uid=owner
    )
    if not path_inside(npm["root"], npm_cli["path"]):
        fail("npm CLI is outside the policy-bound npm tree")
    package_json = json.load(open(os.path.join(npm["root"], "package.json"), encoding="utf-8"))
    if package_json.get("name") != "npm" or package_json.get("version") != policy["npm"]["version"]:
        fail("npm package identity is stale")
    npm.update({"cliPath": npm_cli["path"], "version": policy["npm"]["version"]})

    require_keys(policy["verifier"], {"inventory", "collectEntrypoint", "cleanEntrypoint"}, "verifier policy")
    verifier = validate_inventory(policy["verifier"]["inventory"], "trusted verifier", owner)
    for mode, key in (("collect", "collectEntrypoint"), ("clean", "cleanEntrypoint")):
        entrypoint = absolute_path(policy["verifier"][key], f"{mode} verifier entrypoint")
        if not path_inside(verifier["root"], entrypoint):
            fail(f"{mode} verifier entrypoint is outside the trusted verifier tree")
        regular_file_identity(entrypoint, f"{mode} verifier entrypoint", owner, trust_owner_uid=owner)
        verifier[key] = entrypoint
    runtime_files = policy["workerRuntime"]
    if not isinstance(runtime_files, list) or not 1 <= len(runtime_files) <= 256:
        fail("worker runtime file allowlist is invalid")
    destinations = set()
    total = 0
    for entry in runtime_files:
        require_keys(entry, {"destination", "identity"}, "worker runtime file")
        dest = entry["destination"]
        if (not isinstance(dest, str) or os.path.normpath(dest) != dest
                or not dest.startswith(("/usr/bin/", "/usr/lib/", "/usr/lib64/", "/lib/", "/lib64/"))
                or dest in destinations):
            fail("worker runtime destination is unsafe")
        destinations.add(dest)
        observed = validate_identity_spec(entry["identity"], "worker runtime", owner)
        total += observed["bytes"]
    if total > MAX_WORKSPACE_BYTES:
        fail("worker runtime file scope exceeds limit")
    return {"node": node, "git": git_identity, "bubblewrap": bwrap, "npm": npm, "verifier": verifier}


def validate_roots(policy):
    owner = policy["trustOwnerUid"]
    candidate = absolute_path(policy["candidateRoot"], "candidate root")
    artifact = absolute_path(policy["artifactRoot"], "artifact root")
    temporary = absolute_path(policy["temporaryRoot"], "temporary root")
    output = absolute_path(policy["outputRoot"], "output root")
    regular_directory(candidate, "candidate root")
    regular_directory(artifact, "artifact root")
    regular_directory(temporary, "temporary root", owner, 0o700, owner)
    regular_directory(output, "output root", owner, 0o700, owner)
    if any(path_inside(candidate, value) for value in (artifact, temporary, output)):
        fail("trusted roots and artifacts must remain outside the candidate")
    if path_inside(artifact, output) or path_inside(output, artifact):
        fail("artifact and protected output roots must be distinct")
    return candidate, artifact, temporary, output


def snapshot_clone_command(git_path, candidate_root, snapshot):
    # Local transport clears clone's command-scope configuration before
    # upload-pack. Bind the sending helper explicitly as well as index-pack;
    # otherwise automatic pack threads compete for the 512 MiB address space.
    upload_pack = f"{shlex.quote(git_path)} -c pack.threads=1 upload-pack"
    return [git_path, "-c", "pack.threads=1", "clone", f"--upload-pack={upload_pack}",
            "--no-checkout", "--no-local", "--no-hardlinks", "--quiet", candidate_root, snapshot]


def create_authorized_snapshot(policy, candidate_root, workspace, git_path, env):
    snapshot = os.path.join(workspace, "authorized-candidate")
    run_bounded(
        snapshot_clone_command(git_path, candidate_root, snapshot),
        "/",
        env,
        60,
        "trusted snapshot clone", disk_root=workspace,
    )
    archive_path = os.path.join(workspace, "authorized.tar")
    with open(archive_path, "xb") as archive:
        os.chmod(archive_path, 0o600)
        run_bounded(
            [git_path, "archive", "--format=tar", policy["authorizedRevision"]["commit"]],
            candidate_root, env, 60, "trusted snapshot archive", sink=archive,
            output_limit=MAX_SNAPSHOT_BYTES, disk_root=workspace,
        )
        archive.flush()
        os.fsync(archive.fileno())
    archive_bytes = os.stat(archive_path).st_size
    archive_sha256 = sha256_file(archive_path)
    extract_deadline = time.monotonic() + 60
    total = 0
    names = set()
    with tarfile.open(archive_path, mode="r|", bufsize=65536) as bundle:
        for member in bundle:
            name = member.name.rstrip("/")
            components = name.split("/")
            if (not name or name.startswith("/") or "\\" in name
                    or any(part in ("", ".", "..", ".git") for part in components)
                    or name in names or not (member.isdir() or member.isfile())):
                fail("authorized snapshot archive contains an unsupported entry")
            names.add(name)
            total += member.size
            if total > MAX_SNAPSHOT_BYTES or len(names) > MAX_ARCHIVE_MEMBERS:
                fail("authorized snapshot archive exceeds extraction bounds")
            if time.monotonic() > extract_deadline:
                fail("authorized snapshot extraction exceeded timeout")
            destination = os.path.join(snapshot, name)
            os.makedirs(os.path.dirname(destination), mode=0o700, exist_ok=True)
            if member.isdir():
                os.makedirs(destination, mode=0o700, exist_ok=True)
            else:
                with bundle.extractfile(member) as source, open(destination, "xb") as target:
                    while chunk := source.read(65536):
                        if time.monotonic() > extract_deadline:
                            fail("authorized snapshot extraction exceeded timeout")
                        target.write(chunk)
                os.chmod(destination, 0o755 if member.mode & 0o111 else 0o644)
    os.unlink(archive_path)
    run_bounded(
        [git_path, "reset", "--mixed", policy["authorizedRevision"]["commit"]],
        snapshot,
        env,
        30,
        "trusted snapshot index",
    )
    snapshot_state = git_state(policy, git_path, snapshot, env)
    if snapshot_state["status"]:
        fail("protected authorized snapshot is not clean")
    for current_root, directories, names in os.walk(snapshot):
        for directory in directories:
            os.chmod(os.path.join(current_root, directory), 0o500)
        for name in names:
            item_path = os.path.join(current_root, name)
            item = os.lstat(item_path)
            if stat.S_ISREG(item.st_mode):
                os.chmod(item_path, 0o755 if item.st_mode & 0o111 else 0o644)
    os.chmod(snapshot, 0o500)
    snapshot_state["archive"] = {"bytes": archive_bytes, "sha256": archive_sha256, "limit": MAX_SNAPSHOT_BYTES}
    return snapshot, snapshot_state


def worker_environment():
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": "/run/linmas-worker/home",
        "TMPDIR": "/run/linmas-worker",
        "TMP": "/run/linmas-worker",
        "TEMP": "/run/linmas-worker",
        "XDG_CONFIG_HOME": "/run/linmas-worker/home",
        "XDG_CACHE_HOME": "/run/linmas-worker/home",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_OPTIONAL_LOCKS": "0",
    }


def run_verifier(policy, runtime, mode, repository_root, artifact_root, acceptance_path=None):
    verifier = runtime["verifier"]
    entrypoint = verifier["collectEntrypoint"] if mode == "collect" else verifier["cleanEntrypoint"]
    if mode == "collect":
        child_args = [
            runtime["node"]["path"], entrypoint, "--mode", "collect", "--root-dir", repository_root,
            "--artifact-root", artifact_root, "--package-path", "linmas-0.9.0.tgz",
            "--plugin-path", "plugin/linmas",
        ]
    else:
        child_args = [
            runtime["node"]["path"], entrypoint, "--mode", "clean", "--root-dir", repository_root,
            "--identity-file", os.path.join(repository_root, "compatibility/evidence/v0.9.0-content-identity.json"),
            "--acceptance-file", acceptance_path, "--artifact-root", artifact_root,
        ]
    environment = worker_environment()
    environment["LINMAS_APPROVED_NODE_PATH"] = runtime["node"]["path"]
    environment["LINMAS_APPROVED_NPM_CLI"] = runtime["npm"]["cliPath"]
    mounts = [(repository_root, repository_root), (artifact_root, artifact_root),
              (verifier["root"], verifier["root"]), (runtime["npm"]["root"], runtime["npm"]["root"])]
    mounts += [(entry["identity"]["path"], entry["destination"]) for entry in policy["workerRuntime"]]
    mounts += [(runtime["node"]["path"], runtime["node"]["path"]),
               (runtime["git"]["path"], "/usr/bin/git")]
    if acceptance_path:
        mounts.append((acceptance_path, acceptance_path))
    # Never include trust-policy, launcher, bootstrap, output or temporary root.
    # Numeric namespace IDs map to the caller: confidentiality comes from mounts.
    forbidden = [policy["outputRoot"], DEFAULT_TRUST_POLICY_PATH, policy["launcher"]["path"], policy["bootstrap"]["path"]]
    for source, destination in mounts:
        if source == "/" or destination == "/" or any(path_inside(source, protected) for protected in forbidden):
            fail("worker mount overlaps protected host authority")
    bwrap_args = [runtime["bubblewrap"]["path"], "--die-with-parent", "--new-session",
                  "--unshare-all", "--unshare-user", "--disable-userns", "--cap-drop", "ALL",
                  "--size", str(MAX_WORKSPACE_BYTES), "--tmpfs", "/"]
    for source, destination in dict.fromkeys(mounts):
        bwrap_args.extend(["--ro-bind", source, destination])
    bwrap_args += ["--proc", "/proc", "--dev", "/dev",
                  "--remount-ro", "/proc", "--remount-ro", "/dev",
                  "--size", str(MAX_WORKSPACE_BYTES), "--tmpfs", "/run",
                  "--dir", "/run/linmas-worker", "--dir", "/run/linmas-worker/home",
                  "--remount-ro", "/",
                  "--uid", str(policy["workerUid"]), "--gid", str(policy["workerGid"]),
                  "--chdir", repository_root, "--clearenv"]
    for key, value in sorted(environment.items()):
        bwrap_args.extend(["--setenv", key, value])
    observation_script = r"""
const fs = require('node:fs');
const cp = require('node:child_process');
const os = require('node:os');
const status = fs.readFileSync('/proc/self/status', 'utf8');
const fields = Object.fromEntries(status.split('\n').filter(x=>x.includes(':')).map(x=>[x.slice(0,x.indexOf(':')),x.slice(x.indexOf(':')+1).trim()]));
for (const key of ['CapEff','CapPrm','CapBnd','CapAmb']) if (!/^0+$/.test(fields[key])) throw Error('worker capability restriction failed');
if(fields.NoNewPrivs !== '1') throw Error('worker no-new-privileges restriction failed');
const observation = {uid:process.getuid(),gid:process.getgid(),uidMap:fs.readFileSync('/proc/self/uid_map','utf8').trim(),gidMap:fs.readFileSync('/proc/self/gid_map','utf8').trim(),capabilities:Object.fromEntries(['CapEff','CapPrm','CapBnd','CapAmb'].map(k=>[k,fields[k]])),noNewPrivs:fields.NoNewPrivs,networkNamespace:fs.readlinkSync('/proc/self/ns/net'),interfaces:Object.keys(os.networkInterfaces()),mountinfo:fs.readFileSync('/proc/self/mountinfo','utf8')};
const result = cp.spawnSync(process.argv[1],process.argv.slice(2),{env:process.env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});
if(result.error || result.status !== 0) { process.stderr.write(String(result.error || result.stderr).slice(0,500)); process.exit(1); }
process.stdout.write(JSON.stringify({observation,result:JSON.parse(result.stdout)}));
"""
    bwrap_args.extend([runtime["node"]["path"], "-e", observation_script, *child_args])
    stdout = run_bounded(
        bwrap_args, "/", BOOTSTRAP_ENVIRONMENT, policy["timeoutSeconds"], "isolated trusted verifier"
    )
    try:
        envelope = json.loads(stdout.decode("utf-8"))
        require_keys(envelope, {"observation", "result"}, "worker envelope")
        observation = envelope["observation"]
        if (observation["uid"] != policy["workerUid"] or observation["gid"] != policy["workerGid"]
                or observation["noNewPrivs"] != "1"
                or any(int(value, 16) != 0 for value in observation["capabilities"].values())
                or observation["networkNamespace"] == os.readlink("/proc/self/ns/net")
                or any(name != "lo" for name in observation["interfaces"])):
            fail("worker measured isolation is invalid")
        observation["parentUidMap"] = open("/proc/self/uid_map", encoding="utf-8").read().strip()
        observation["parentGidMap"] = open("/proc/self/gid_map", encoding="utf-8").read().strip()
        observation["readOnlyMounts"] = [{"source": src, "destination": dst} for src, dst in dict.fromkeys(mounts)]
        runtime["workerObservation"] = observation
        result = envelope["result"]
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("isolated trusted verifier returned malformed JSON")
    if not isinstance(result, dict):
        fail("isolated trusted verifier result must be an object")
    if mode == "collect":
        records = result.get("disposition", {}).get("records")
        if not isinstance(records, list) or len(records) != 23:
            fail("trusted collection did not produce the exact record set")
    elif result.get("valid") is not True:
        fail("trusted clean verifier did not accept the authorized object")
    return child_args, environment, result


def fixed_acceptance(policy):
    specification = policy["request"]["acceptance"]
    if policy["request"]["mode"] == "collect":
        if specification is not None:
            fail("collection request must not authorize a clean acceptance")
        return None, None, None
    require_keys(specification, {"path", "sha256"}, "authorized acceptance")
    path = absolute_path(specification["path"], "authorized acceptance path")
    identity = regular_file_identity(path, "authorized acceptance", policy["trustOwnerUid"], trust_owner_uid=policy["trustOwnerUid"])
    if identity["sha256"] != specification["sha256"]:
        fail("acceptance bytes are not independently authorized")
    try:
        value = json.load(open(path, encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"authorized acceptance is malformed: {error}")
    return path, identity, value


def artifact_summary(acceptance, artifact_root):
    binding = acceptance.get("artifactBinding")
    if not isinstance(binding, dict):
        fail("clean acceptance has no artifact binding")
    package = binding.get("package")
    plugin = binding.get("plugin")
    if not isinstance(package, dict) or not isinstance(plugin, dict):
        fail("clean acceptance artifact binding is incomplete")
    package_relative = package.get("path", "")
    if (
        not isinstance(package_relative, str)
        or not package_relative
        or os.path.isabs(package_relative)
        or any(part in ("", ".", "..") for part in package_relative.split("/"))
    ):
        fail("accepted package path is unsafe")
    package_path = os.path.join(artifact_root, package_relative)
    if not path_inside(artifact_root, package_path):
        fail("accepted package path escapes the artifact root")
    measured = regular_file_identity(package_path, "accepted package artifact")
    for field in ("bytes", "sha256"):
        if package.get(field) != measured[field]:
            fail(f"accepted package {field} is stale")
    required_package = {"path", "filename", "bytes", "entryCount", "sha256", "inventorySha256", "packageName", "packageVersion", "published"}
    required_plugin = {"path", "fileCount", "contentDigest", "packageName", "packageVersion", "published"}
    if set(package) != required_package or set(plugin) != required_plugin:
        fail("accepted artifact binding schema is not exact")
    return {"package": package, "plugin": plugin}


def clean_binding(policy, acceptance_path, acceptance_identity, acceptance, repository_root, artifact_root):
    identity_path = os.path.join(repository_root, "compatibility/evidence/v0.9.0-content-identity.json")
    identity = regular_file_identity(identity_path, "accepted content identity")
    content = acceptance.get("contentIdentity")
    if not isinstance(content, dict) or content.get("sha256") != identity["sha256"]:
        fail("accepted content identity bytes are stale")
    evidence = acceptance.get("evidenceDisposition")
    if not isinstance(evidence, dict):
        fail("accepted evidence disposition is missing")
    return {
        "acceptance": {
            **acceptance_identity,
            "bindingKind": acceptance.get("bindingKind"),
            "workingTreeState": acceptance.get("workingTreeState"),
        },
        "contentIdentity": {
            **identity,
            "contentDigest": content.get("contentDigest"),
        },
        "artifacts": artifact_summary(acceptance, artifact_root),
        "evidence": evidence,
        "acceptancePath": acceptance_path,
    }


def output_path_for(policy, output_root):
    request_id = policy["request"]["id"]
    if any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for character in request_id):
        fail("request id is unsafe for protected output")
    return os.path.join(output_root, f"{request_id}.json")


def create_only_json(file_path, value):
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8") + b"\n"
    descriptor = os.open(file_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.close(descriptor)
    return payload


def remove_workspace(workspace):
    if not os.path.isdir(workspace):
        return
    for current_root, directories, names in os.walk(workspace, topdown=False):
        for name in names:
            try:
                os.chmod(os.path.join(current_root, name), 0o600)
            except OSError:
                pass
        for directory in directories:
            try:
                os.chmod(os.path.join(current_root, directory), 0o700)
            except OSError:
                pass
    try:
        os.chmod(workspace, 0o700)
    except OSError:
        pass
    shutil.rmtree(workspace, ignore_errors=True)


def build_attestation(policy, bootstrap, launcher, python, runtime, candidate_root, artifact_root, initial_state, final_state, child_args, child_environment, child_result, bindings=None, snapshot_state=None):
    mode = policy["request"]["mode"]
    return {
        "schemaVersion": 2,
        "attestationKind": CLEAN_KIND if mode == "clean" else DIAGNOSTIC_KIND,
        "status": "PASS",
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "request": policy["request"],
        "trustPolicy": {
            "path": DEFAULT_TRUST_POLICY_PATH,
            "sha256": sha256_bytes(policy["_bytes"]),
            "policyId": policy["policyId"],
        },
        "bootstrap": bootstrap,
        "launcher": launcher,
        "python": python,
        "node": runtime["node"],
        "npm": runtime["npm"],
        "git": runtime["git"],
        "bubblewrap": runtime["bubblewrap"],
        "verifier": runtime["verifier"],
        "authorizedRevision": policy["authorizedRevision"],
        "candidate": {
            "root": candidate_root,
            "initialState": initial_state,
            "finalState": final_state,
        },
        "executionSnapshot": snapshot_state,
        "artifactRoot": artifact_root,
        "worker": {
            "uid": policy["workerUid"],
            "gid": policy["workerGid"],
            "isolation": CHILD_ENVIRONMENT_POLICY,
            "authorityModel": "mount-confidentiality; namespace UID is not host DAC separation",
            "runtimeFiles": policy["workerRuntime"],
            "observation": runtime.get("workerObservation"),
            "candidateWritable": False,
            "artifactsWritable": False,
            "trustAssetsWritable": False,
            "outputWritable": False,
        },
        "childArgv": child_args,
        "childEnvironment": {
            "policy": "complete-replacement-v1",
            "values": child_environment,
            "forbiddenLoaderInputs": [
                "LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS", "NODE_PATH",
                "NODE_EXTRA_CA_CERTS", "PYTHONPATH", "PYTHONHOME",
            ],
        },
        "resultSha256": sha256_bytes(canonical_bytes(child_result)),
        "result": child_result,
        "bindings": bindings,
    }


def validate_clean_attestation(policy, attestation):
    expected_keys = {
        "schemaVersion", "attestationKind", "status", "createdAt", "request",
        "trustPolicy", "bootstrap", "launcher", "python", "node", "npm", "git",
        "bubblewrap", "verifier", "authorizedRevision", "candidate",
        "executionSnapshot", "artifactRoot", "worker", "childArgv",
        "childEnvironment", "resultSha256", "result", "bindings",
    }
    require_keys(attestation, expected_keys, "clean attestation")
    if attestation["schemaVersion"] != 2 or attestation["attestationKind"] != CLEAN_KIND or attestation["status"] != "PASS":
        fail("consumer rejected wrong-kind or failed attestation")
    if attestation["request"] != policy["request"] or attestation["authorizedRevision"] != policy["authorizedRevision"]:
        fail("consumer rejected unrelated request or revision")
    created = parse_timestamp(attestation["createdAt"], "attestation createdAt")
    if not parse_timestamp(policy["request"]["notBefore"], "request notBefore") <= created <= parse_timestamp(policy["request"]["expiresAt"], "request expiresAt"):
        fail("consumer rejected stale attestation")
    expected_policy = {
        "path": DEFAULT_TRUST_POLICY_PATH,
        "sha256": sha256_bytes(policy["_bytes"]),
        "policyId": policy["policyId"],
    }
    if attestation["trustPolicy"] != expected_policy:
        fail("consumer rejected substituted policy binding")
    for field in ("bootstrap", "launcher", "python", "node", "git", "bubblewrap"):
        specification = policy[field]
        expected_identity = {key: specification[key] for key in ("path", "bytes", "sha256", "ownerUid", "mode")}
        if attestation[field] != expected_identity:
            fail(f"consumer rejected substituted {field} identity")
    npm_policy = policy["npm"]
    expected_npm = {
        "root": npm_policy["inventory"]["root"],
        "ownerUid": npm_policy["inventory"]["ownerUid"],
        "fileCount": npm_policy["inventory"]["fileCount"],
        "implementationSha256": npm_policy["inventory"]["implementationSha256"],
        "cliPath": npm_policy["cliPath"],
        "version": npm_policy["version"],
    }
    if attestation["npm"] != expected_npm:
        fail("consumer rejected substituted npm identity")
    verifier_policy = policy["verifier"]
    expected_verifier = {
        "root": verifier_policy["inventory"]["root"],
        "ownerUid": verifier_policy["inventory"]["ownerUid"],
        "fileCount": verifier_policy["inventory"]["fileCount"],
        "implementationSha256": verifier_policy["inventory"]["implementationSha256"],
        "collectEntrypoint": verifier_policy["collectEntrypoint"],
        "cleanEntrypoint": verifier_policy["cleanEntrypoint"],
    }
    if attestation["verifier"] != expected_verifier:
        fail("consumer rejected substituted verifier identity")
    if attestation["artifactRoot"] != policy["artifactRoot"] or attestation["candidate"].get("root") != policy["candidateRoot"]:
        fail("consumer rejected unrelated candidate or artifact root")
    if attestation["candidate"]["initialState"]["status"] or attestation["candidate"]["finalState"]["status"]:
        fail("consumer rejected non-clean candidate state")
    if attestation["executionSnapshot"]["status"]:
        fail("consumer rejected non-clean execution snapshot")
    worker = attestation["worker"]
    if (
        worker.get("isolation") != CHILD_ENVIRONMENT_POLICY
        or worker.get("runtimeFiles") != policy["workerRuntime"]
        or worker.get("uid") != policy["workerUid"]
        or worker.get("gid") != policy["workerGid"]
        or worker.get("uid") in (0, policy["trustOwnerUid"])
        or any(worker.get(field) is not False for field in ("candidateWritable", "artifactsWritable", "trustAssetsWritable", "outputWritable"))
    ):
        fail("consumer rejected unsafe worker authority")
    bindings = attestation["bindings"]
    if not isinstance(bindings, dict):
        fail("consumer rejected missing clean bindings")
    acceptance = bindings.get("acceptance", {})
    if acceptance.get("bindingKind") != "clean-candidate-evidence" or acceptance.get("workingTreeState") != "clean":
        fail("consumer rejected diagnostic or malformed clean acceptance")
    if (
        acceptance.get("path") != policy["request"]["acceptance"]["path"]
        or acceptance.get("sha256") != policy["request"]["acceptance"]["sha256"]
        or bindings.get("acceptancePath") != policy["request"]["acceptance"]["path"]
    ):
        fail("consumer rejected substituted acceptance bytes")
    if not isinstance(bindings.get("contentIdentity"), dict) or not isinstance(bindings.get("artifacts"), dict) or not isinstance(bindings.get("evidence"), dict):
        fail("consumer rejected incomplete content, artifact, or evidence binding")
    if attestation["resultSha256"] != sha256_bytes(canonical_bytes(attestation["result"])) or attestation["result"].get("valid") is not True:
        fail("consumer rejected substituted verifier result")
    return True


def consume_output(policy, output_path, output_root, expected_attestation=None):
    item = regular_file_identity(
        output_path, "protected attestation", policy["trustOwnerUid"], 0o600, policy["trustOwnerUid"]
    )
    try:
        value = json.load(open(output_path, encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"consumer rejected malformed attestation: {error}")
    require_keys(value, {"attestation"}, "protected attestation envelope")
    attestation = value["attestation"]
    if expected_attestation is not None and canonical_bytes(attestation) != canonical_bytes(expected_attestation):
        fail("consumer rejected substituted attestation bytes")
    validate_clean_attestation(policy, attestation)
    marker_path = os.path.join(output_root, f"{policy['request']['id']}.consumed")
    consumption = {
        "schemaVersion": 1,
        "consumptionKind": CONSUMPTION_KIND,
        "requestId": policy["request"]["id"],
        "result": "ACCEPTED",
        "attestationSha256": item["sha256"],
        "consumedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    final_acceptance_gate()
    create_only_json(marker_path, consumption)
    return consumption


def parse_args(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--bootstrap-parent-pid", type=int, required=True)
    parser.add_argument("--mode", choices=sorted(VALID_MODES), required=True)
    return parser.parse_args(argv)


def main(argv):
    global BOOTSTRAP_PID
    args = parse_args(argv)
    BOOTSTRAP_PID = args.bootstrap_parent_pid
    policy = load_policy(DEFAULT_TRUST_POLICY_PATH)
    bootstrap, launcher, python = validate_bootstrap(policy, args.bootstrap_parent_pid)
    candidate_root, artifact_root, temporary_root, output_root = validate_roots(policy)
    output_path = output_path_for(policy, output_root)
    if args.mode == "consume":
        if policy["request"]["mode"] != "clean":
            fail("collection diagnostic cannot be consumed as clean acceptance")
        consumption = consume_output(policy, output_path, output_root)
        print(json.dumps(consumption, sort_keys=True))
        return
    if args.mode != policy["request"]["mode"]:
        fail("invocation mode is not the independently authorized request mode")

    runtime = validate_runtime(policy)
    workspace = tempfile.mkdtemp(prefix="linmas-irsa003-", dir=temporary_root)
    os.chmod(workspace, 0o700)
    environment = clean_environment(workspace)
    try:
        initial_state = git_state(policy, runtime["git"]["path"], candidate_root, environment)
        if args.mode == "clean" and initial_state["status"]:
            fail("clean acceptance requires an independently observed clean candidate")
        acceptance_path, acceptance_identity, acceptance = fixed_acceptance(policy)
        execution_root = candidate_root
        snapshot_state = None
        if args.mode == "clean":
            execution_root, snapshot_state = create_authorized_snapshot(
                policy, candidate_root, workspace, runtime["git"]["path"], environment
            )
        child_args, child_environment, child_result = run_verifier(
            policy, runtime, args.mode, execution_root, artifact_root, acceptance_path
        )
        final_state = git_state(policy, runtime["git"]["path"], candidate_root, environment)
        if args.mode == "clean" and final_state["status"]:
            fail("candidate changed during the clean acceptance operation")
        bindings = None
        if args.mode == "clean":
            bindings = clean_binding(
                policy, acceptance_path, acceptance_identity, acceptance, execution_root, artifact_root
            )
        attestation = build_attestation(
            policy, bootstrap, launcher, python, runtime, candidate_root, artifact_root,
            initial_state, final_state, child_args, child_environment, child_result,
            bindings, snapshot_state,
        )
        if args.mode == "clean":
            validate_clean_attestation(policy, attestation)
        final_acceptance_gate()
        create_only_json(output_path, {"attestation": attestation})
        if args.mode == "clean":
            consumption = consume_output(policy, output_path, output_root, attestation)
            print(json.dumps({
                "status": "PASS", "mode": "clean", "output": output_path,
                "requestId": policy["request"]["id"], "consumption": consumption,
            }, sort_keys=True))
        else:
            print(json.dumps({
                "status": "PASS", "mode": "collect", "output": output_path,
                "requestId": policy["request"]["id"],
                "recordCount": len(child_result["disposition"]["records"]),
                "workingTreeStatus": initial_state["status"],
            }, sort_keys=True))
    finally:
        remove_workspace(workspace)


if __name__ == "__main__":
    for cancellation_signal in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(cancellation_signal, on_cancel)
    try:
        main(sys.argv[1:])
    except Cancelled as error:
        print("trusted outer boundary cancelled before final acceptance", file=sys.stderr)
        sys.exit(128 + int(error.args[0]))
    except Exception as error:
        print(f"trusted outer boundary failed: {error}", file=sys.stderr)
        sys.exit(1)
