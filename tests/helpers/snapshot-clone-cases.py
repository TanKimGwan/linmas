"""Owned real Git comparisons; the negative proof records actual child bytes."""
import base64
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import resource
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace

repo = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("launcher", repo / "scripts/irsa003-trusted-launch.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


def make_writable(root):
    root = Path(root)
    if not root.exists():
        return
    for current, directories, names in os.walk(root, topdown=False, followlinks=False):
        for name in names:
            path = Path(current) / name
            if not path.is_symlink() and path.is_file():
                os.chmod(path, 0o600)
        for name in directories:
            path = Path(current) / name
            if not path.is_symlink() and path.is_dir():
                os.chmod(path, 0o700)
    os.chmod(root, 0o700)


class ReadOnlyTemporaryDirectory(tempfile.TemporaryDirectory):
    def cleanup(self):
        if self.name:
            make_writable(self.name)
        super().cleanup()


def make_read_only(root):
    root = Path(root)
    for current, directories, names in os.walk(root, topdown=False, followlinks=False):
        for name in names:
            path = Path(current) / name
            if not path.is_symlink() and path.is_file():
                os.chmod(path, 0o444)
        for name in directories:
            path = Path(current) / name
            if not path.is_symlink() and path.is_dir():
                os.chmod(path, 0o555)
    os.chmod(root, 0o555)


def source_is_read_only(root, parent):
    root = Path(root)
    parent = Path(parent)
    if stat.S_IMODE(parent.stat().st_mode) != 0o500 or stat.S_IMODE(root.stat().st_mode) != 0o555:
        return False
    for current, directories, names in os.walk(root, followlinks=False):
        for name in directories:
            path = Path(current) / name
            if path.is_symlink() or stat.S_IMODE(path.stat().st_mode) != 0o555:
                return False
        for name in names:
            path = Path(current) / name
            if path.is_symlink() or stat.S_IMODE(path.stat().st_mode) != 0o444:
                return False
    return True


def observe_launcher(operation):
    original_os = launcher.os
    original_subprocess = launcher.subprocess
    original_workspace_bytes = launcher.workspace_bytes
    os_proxy = SimpleNamespace(**vars(original_os))
    subprocess_proxy = SimpleNamespace(**vars(original_subprocess))
    state = {"children": [], "pipeTargets": {}, "workspaceScans": []}

    def group_pids(pgid):
        pids = []
        try:
            entries = original_os.listdir("/proc")
        except OSError:
            return pids
        for entry in entries:
            if not entry.isdigit():
                continue
            try:
                raw = Path("/proc", entry, "stat").read_text()
                fields = raw[raw.rfind(")") + 2:].split()
                if int(fields[2]) == pgid:
                    pids.append(int(entry))
            except (OSError, ValueError, IndexError):
                continue
        return sorted(pids)

    def remember_group(child):
        now = time.monotonic()
        last_sample = child.get("lastProcessGroupSample", float("-inf"))
        if now - last_sample < 0.25:
            return []
        child["lastProcessGroupSample"] = now
        pids = group_pids(child["pid"])
        child["observedProcessGroupPids"].update(pids)
        return pids

    def observed_read(fd, size):
        chunk = original_os.read(fd, size)
        target = state["pipeTargets"].get(fd)
        if target and chunk:
            child, stream = target
            remember_group(child)
            child[stream + "Bytes"] += len(chunk)
            child[stream + "Digest"].update(chunk)
            if stream == "stderr":
                child["stderrRaw"].extend(chunk)
        return chunk

    def observed_popen(*args, **kwargs):
        command = args[0] if args else kwargs.get("args")
        process = original_subprocess.Popen(*args, **kwargs)
        child = {
            "pid": process.pid,
            "argv": list(command) if isinstance(command, (list, tuple)) else str(command),
            "cwd": kwargs.get("cwd"),
            "environment": dict(sorted((kwargs.get("env") or {}).items())),
            "startedAtMonotonic": time.monotonic(),
            "effectiveRlimits": {},
            "stdoutBytes": 0,
            "stderrBytes": 0,
            "stdoutDigest": hashlib.sha256(),
            "stderrDigest": hashlib.sha256(),
            "stderrRaw": bytearray(),
            "observedProcessGroupPids": set(),
        }
        for name, limit in (
            ("AS", resource.RLIMIT_AS), ("FSIZE", resource.RLIMIT_FSIZE),
            ("CPU", resource.RLIMIT_CPU), ("CORE", resource.RLIMIT_CORE),
        ):
            try:
                child["effectiveRlimits"][name] = list(resource.prlimit(process.pid, limit))
            except (OSError, ProcessLookupError) as error:
                child["effectiveRlimits"][name] = {"unavailable": type(error).__name__, "errno": getattr(error, "errno", None)}
        if process.stdout is not None:
            child["stdoutFd"] = process.stdout.fileno()
            state["pipeTargets"][child["stdoutFd"]] = (child, "stdout")
        if process.stderr is not None:
            child["stderrFd"] = process.stderr.fileno()
            state["pipeTargets"][child["stderrFd"]] = (child, "stderr")
        child["process"] = process
        state["children"].append(child)
        remember_group(child)
        return process

    def observed_workspace_bytes(root, deadline=None):
        for child in state["children"]:
            remember_group(child)
        item = {"root": str(root), "startedAtMonotonic": time.monotonic(), "deadlineSupplied": deadline is not None}
        state["workspaceScans"].append(item)
        try:
            amount = original_workspace_bytes(root, deadline=deadline)
            item.update({"result": "complete", "bytes": amount})
            return amount
        except BaseException as error:
            item.update({"result": "error", "errorType": type(error).__name__, "error": str(error)[:1000]})
            raise
        finally:
            item["elapsedSeconds"] = round(time.monotonic() - item.pop("startedAtMonotonic"), 6)
            for child in state["children"]:
                remember_group(child)

    os_proxy.read = observed_read
    subprocess_proxy.Popen = observed_popen
    launcher.os = os_proxy
    launcher.subprocess = subprocess_proxy
    launcher.workspace_bytes = observed_workspace_bytes
    outer_error = None
    try:
        value = operation()
    except BaseException as error:
        value = None
        outer_error = {"type": type(error).__name__, "message": str(error)[:2000]}
    finally:
        launcher.os = original_os
        launcher.subprocess = original_subprocess
        launcher.workspace_bytes = original_workspace_bytes

    children = []
    for child in state["children"]:
        # Always make one fresh system-wide check after terminate_process and
        # pipe close. The throttled samples above are only runtime observation;
        # this final sample is the cleanup assertion's source of truth.
        final_group_pids = group_pids(child["pid"])
        child["observedProcessGroupPids"].update(final_group_pids)
        process = child.pop("process")
        raw = bytes(child.pop("stderrRaw"))
        child.pop("lastProcessGroupSample", None)
        child["returnCode"] = process.returncode
        child["pipesClosedAfterReturn"] = {
            "stdout": process.stdout is None or process.stdout.closed,
            "stderr": process.stderr is None or process.stderr.closed,
        }
        child["pipeFdsClosedAfterReturn"] = {}
        for name in ("stdout", "stderr"):
            descriptor = child.get(name + "Fd")
            if descriptor is None:
                child["pipeFdsClosedAfterReturn"][name] = True
                continue
            try:
                original_os.fstat(descriptor)
            except OSError as error:
                child["pipeFdsClosedAfterReturn"][name] = error.errno == errno.EBADF
            else:
                child["pipeFdsClosedAfterReturn"][name] = False
        child["pidExistsAfterReturn"] = Path("/proc", str(process.pid)).exists()
        child["processGroupPidsObserved"] = sorted(child.pop("observedProcessGroupPids"))
        child["processGroupPidsRemainingAfterReturn"] = final_group_pids
        assert child["returnCode"] is not None
        assert all(child["pipesClosedAfterReturn"].values())
        assert all(child["pipeFdsClosedAfterReturn"].values())
        assert not child["pidExistsAfterReturn"]
        assert not child["processGroupPidsRemainingAfterReturn"]
        child["elapsedSeconds"] = round(time.monotonic() - child.pop("startedAtMonotonic"), 6)
        child["stdoutSha256"] = child.pop("stdoutDigest").hexdigest()
        child["stderrSha256"] = child.pop("stderrDigest").hexdigest()
        child["stderrBase64"] = base64.b64encode(raw).decode("ascii")
        child["stderrText"] = raw.decode("utf-8", errors="replace")
        children.append(child)
    return {"value": value, "outerError": outer_error, "children": children, "workspaceScans": state["workspaceScans"]}


def classify_negative(observation):
    error = observation["outerError"]
    if error and error["message"].startswith("workspace accounting"):
        return "workspace-guard-rejection"
    children = observation["children"]
    if not error and children:
        return "negative-unexpected-git-success"
    if error and error["message"].startswith("trusted snapshot clone failed:") and children:
        child = children[0]
        stderr = child["stderrText"].lower()
        if (child["returnCode"] == 128 and "unable to create thread" in stderr
                and "resource temporarily unavailable" in stderr):
            return "intended-actual-git-resource-failure"
        return "other-actual-git-child-failure"
    return "other-harness-or-child-failure"


def fixture_file_identity(root):
    result = {}
    for path in sorted(root.glob("*.txt")):
        content = path.read_bytes()
        result[path.name] = {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
    return result


def repository_file_identity(root):
    result = {}
    for current, directories, names in os.walk(root, followlinks=False):
        directories.sort()
        names.sort()
        for name in names:
            path = Path(current) / name
            if path.is_symlink() or not path.is_file():
                raise AssertionError(f"source fixture contains a non-regular file: {path.relative_to(root)}")
            content = path.read_bytes()
            result[path.relative_to(root).as_posix()] = {
                "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(),
            }
    return result


def inventory_digest(inventory):
    return hashlib.sha256(json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def run(case):
    with tempfile.TemporaryDirectory(prefix="lsi003-clone-") as directory, ReadOnlyTemporaryDirectory(prefix="lsi003-source-") as source_directory:
        root = Path(directory)
        source = Path(source_directory) / "source"
        source.mkdir()
        env = launcher.clean_environment(str(root))
        env.update(GIT_AUTHOR_NAME="Fixture", GIT_COMMITTER_NAME="Fixture",
                   GIT_AUTHOR_EMAIL="fixture@example.invalid", GIT_COMMITTER_EMAIL="fixture@example.invalid")

        def git(args):
            return subprocess.check_output(["/usr/bin/git", *args], cwd=source, env=env, stderr=subprocess.PIPE, timeout=15).decode().strip()

        # Unique objects exercise actual delta workers on any CPU count.
        for number in range(256):
            (source / f"file-{number:03}.txt").write_text(f"{number:03}\n" + "bounded synthetic fixture\n" * 1366)
        git(["init", "-q"])
        git(["config", "pack.threads", "8"])
        git(["config", "user.name", "Fixture"])
        git(["config", "user.email", "fixture@example.invalid"])
        git(["add", "--", "."])
        git(["commit", "-q", "-m", "owned synthetic snapshot"])
        commit, tree = git(["rev-parse", "HEAD"]), git(["rev-parse", "HEAD^{tree}"])
        source_files = fixture_file_identity(source)
        source_repository = repository_file_identity(source)
        source_config = (source / ".git/config").read_bytes()
        source_identity = {
            "commit": commit, "tree": tree,
            "files": source_files,
            "filesSha256": inventory_digest(source_files),
            "repositoryFiles": source_repository,
            "repositorySha256": inventory_digest(source_repository),
            "gitConfigSha256": hashlib.sha256(source_config).hexdigest(),
        }
        make_read_only(source)
        os.chmod(source_directory, 0o500)
        assert source_is_read_only(source, source_directory)
        policy = {"authorizedRevision": {"commit": commit, "tree": tree}}

        if case == "bounded-comparison":
            production_limits = launcher.child_limits

            def lower_owned_limit(snapshot_process=False):
                production_limits(snapshot_process)
                if snapshot_process:
                    resource.setrlimit(resource.RLIMIT_AS, (64 * 1024 * 1024,) * 2)

            launcher.child_limits = lower_owned_limit
            negative_destination = root / "negative-clone"
            negative_destination.mkdir()
            # Only the sender helper argument is removed. The source is a
            # separate read-only fixture. Passing destination/. keeps the
            # pre-created parent directory outside Git's failure cleanup.
            negative_destination_argument = f"{negative_destination}/."
            production = launcher.snapshot_clone_command("/usr/bin/git", str(source), negative_destination_argument)
            negative = [argument for argument in production if not argument.startswith("--upload-pack=")]
            removed = [argument for argument in production if argument.startswith("--upload-pack=")]
            assert len(production) - len(negative) == 1 and len(removed) == 1
            negative_observation = observe_launcher(
                lambda: launcher.run_bounded(negative, "/", env, 15, "trusted snapshot clone", disk_root=str(root))
            )
            negative_classification = classify_negative(negative_observation)
            assert negative_classification == "intended-actual-git-resource-failure", negative_observation
            assert all(scan["result"] == "complete" for scan in negative_observation["workspaceScans"])
            direct = negative_observation["children"][0]
            assert direct["effectiveRlimits"]["AS"] == [64 * 1024 * 1024, 64 * 1024 * 1024]
            assert hashlib.sha256(base64.b64decode(direct["stderrBase64"])).hexdigest() == direct["stderrSha256"]
            assert direct["stderrBytes"] > 0
            assert source_identity["filesSha256"] == inventory_digest(fixture_file_identity(source))
            assert source_identity["repositorySha256"] == inventory_digest(repository_file_identity(source))
            assert source_identity["gitConfigSha256"] == hashlib.sha256((source / ".git/config").read_bytes()).hexdigest()
            assert source_is_read_only(source, source_directory)

            work = root / "bounded"
            work.mkdir()
            traced = {**env, "GIT_TRACE2_EVENT": str(root / "trace.jsonl"), "GIT_TRACE2_CONFIG_PARAMS": "pack.threads"}
            positive_observation = observe_launcher(
                lambda: launcher.create_authorized_snapshot(policy, str(source), str(work), "/usr/bin/git", traced)
            )
            assert positive_observation["outerError"] is None, positive_observation
            snapshot, snapshot_state = positive_observation["value"]
            snapshot_path = Path(snapshot)
            snapshot_files = fixture_file_identity(snapshot_path)
            events = [json.loads(line) for line in (root / "trace.jsonl").read_text().splitlines()]
            roles = {event["sid"]: event["name"] for event in events if event.get("event") == "cmd_name"}
            helper_policy = {}
            for role in ("clone", "upload-pack", "pack-objects", "index-pack"):
                sessions = [sid for sid, name in roles.items() if name == role]
                assert len(sessions) == 1, (role, sessions)
                parameters = [event for event in events if event.get("sid") == sessions[0] and event.get("event") == "def_param" and event.get("param") == "pack.threads"]
                helper_policy[role] = [{"scope": event.get("scope"), "value": event.get("value")} for event in parameters]
                assert parameters and parameters[-1]["scope"] == "command" and str(parameters[-1]["value"]) == "1", (role, parameters)
            alternate = snapshot_path / ".git/objects/info/alternates"
            hardlinks = []
            for current, _, names in os.walk(snapshot_path, followlinks=False):
                for name in names:
                    item = os.lstat(Path(current) / name)
                    if item.st_nlink != 1:
                        hardlinks.append({"path": str((Path(current) / name).relative_to(snapshot_path)), "links": item.st_nlink})
            assert snapshot_state["head"] == commit and snapshot_state["tree"] == tree
            assert snapshot_state["status"] == []
            assert snapshot_state["archive"]["bytes"] > 8 * 1024 * 1024
            assert snapshot_files == source_files
            assert not alternate.exists() and hardlinks == []
            assert source_identity["filesSha256"] == inventory_digest(fixture_file_identity(source))
            assert source_identity["repositorySha256"] == inventory_digest(repository_file_identity(source))
            assert source_identity["gitConfigSha256"] == hashlib.sha256((source / ".git/config").read_bytes()).hexdigest()
            assert source_is_read_only(source, source_directory)
            assert negative_destination.is_dir() and not any(negative_destination.iterdir())
            return {
                "success": True,
                "negativeEvidence": {
                    "classification": negative_classification,
                    "removedArgument": removed[0],
                    "outerError": negative_observation["outerError"],
                    "directChildren": negative_observation["children"],
                    "workspaceScans": negative_observation["workspaceScans"],
                    "workspaceCapBytes": launcher.MAX_WORKSPACE_BYTES,
                    "sourceReadOnlyOutsideDiskRoot": True,
                    "sourceUnchanged": True,
                    "destinationRetainedEmpty": negative_destination.is_dir() and not any(negative_destination.iterdir()),
                },
                "correctedSnapshot": {
                    "head": snapshot_state["head"], "tree": snapshot_state["tree"],
                    "clean": not snapshot_state["status"], "archive": snapshot_state["archive"],
                    "sourceFileCount": len(source_files), "exactSourceBytes": snapshot_files == source_files,
                    "noAlternates": not alternate.exists(), "sharedHardlinks": hardlinks,
                    "helperPolicy": helper_policy,
                    "gitChildren": positive_observation["children"],
                },
            }

        if case == "guard-rejection-control":
            original_workspace_bytes = launcher.workspace_bytes

            def deterministic_guard_rejection(_root, deadline=None):
                raise RuntimeError("workspace accounting remained unstable after 3 scans")

            launcher.workspace_bytes = deterministic_guard_rejection
            try:
                observation = observe_launcher(lambda: launcher.run_bounded(
                    [sys.executable, "-c", "import time; time.sleep(5)"],
                    "/", launcher.clean_environment(str(root)), 10, "guard classification control",
                    disk_root=str(root),
                ))
            finally:
                launcher.workspace_bytes = original_workspace_bytes
            classification = classify_negative(observation)
            direct = observation["children"][0]
            assert classification == "workspace-guard-rejection", observation
            assert direct["stderrText"] == ""
            assert direct["returnCode"] != 128
            return {
                "success": True, "classification": classification,
                "acceptedAsIntendedGitFailure": classification == "intended-actual-git-resource-failure",
                "outerError": observation["outerError"], "directChildren": observation["children"],
                "workspaceScans": observation["workspaceScans"],
            }

        if case == "quoted-git-path":
            git_path = root / "trusted git's executable"
            shutil.copyfile("/usr/bin/git", git_path)
            git_path.chmod(0o500)
            work = root / "quoted"
            work.mkdir()
            command = launcher.snapshot_clone_command(str(git_path), str(source), str(work / "authorized-candidate"))
            helper = next(argument.split("=", 1)[1] for argument in command if argument.startswith("--upload-pack="))
            assert shlex.split(helper) == [str(git_path), "-c", "pack.threads=1", "upload-pack"]
            os.environ["GIT_CONFIG_COUNT"] = "1"
            os.environ["GIT_CONFIG_KEY_0"] = "pack.threads"
            os.environ["GIT_CONFIG_VALUE_0"] = "8"
            _, snapshot_state = launcher.create_authorized_snapshot(policy, str(source), str(work), str(git_path), launcher.clean_environment(str(work)))
            assert snapshot_state["head"] == commit and snapshot_state["tree"] == tree and not snapshot_state["status"]
            return {"success": True, "quotedPathAccepted": True, "callerSettingsExcluded": True, "snapshot": snapshot_state}
        raise AssertionError(case)


print(json.dumps(run(sys.argv[1]), sort_keys=True))
