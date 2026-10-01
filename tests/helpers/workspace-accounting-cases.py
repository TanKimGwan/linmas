"""Deterministic benign filesystem transitions against the production module."""
import errno
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
from unittest import mock

spec = importlib.util.spec_from_file_location("trusted_launch", sys.argv[1])
launch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch)
case = sys.argv[2]


def rejected(action, expected):
    try:
        action()
    except RuntimeError as error:
        assert expected in str(error), str(error)
    else:
        raise AssertionError("incomplete/error measurement was accepted")


with tempfile.TemporaryDirectory(prefix="linmas-accounting-case-") as temporary:
    root = Path(temporary) / "workspace"
    root.mkdir()
    (root / "steady").write_bytes(b"1234567")
    real_listdir, real_stat, real_open, real_close = os.listdir, os.stat, os.open, os.close
    scans = [0]

    def churn(count):
        def enumerate_then_remove(fd):
            scans[0] += 1
            if scans[0] <= count:
                (root / "transient").write_bytes(b"temporary")
            names = real_listdir(fd)
            if scans[0] <= count:
                os.unlink("transient", dir_fd=fd)
            return names
        return enumerate_then_remove

    if case in ("disappearance", "finite-churn", "persistent-churn"):
        count = {"disappearance": 1, "finite-churn": 2, "persistent-churn": 100}[case]
        with mock.patch.object(launch.os, "listdir", side_effect=churn(count)):
            if case == "persistent-churn":
                rejected(lambda: launch.workspace_bytes(root), "remained unstable after 3 scans")
                assert scans[0] == 3
            else:
                assert launch.workspace_bytes(root) == 7
                assert scans[0] == count + 1

    elif case == "stable-bounds":
        assert launch.workspace_bytes(root) == 7
        with (root / "large").open("wb") as output:
            output.truncate(launch.MAX_WORKSPACE_BYTES - 7)
        assert launch.workspace_bytes(root) == launch.MAX_WORKSPACE_BYTES
        with (root / "large").open("ab") as output:
            output.write(b"x")
        rejected(lambda: launch.workspace_bytes(root), "exceeded workspace disk limit")

    elif case == "excess-before-disappearance":
        with (root / "large").open("wb") as output:
            output.truncate(launch.MAX_WORKSPACE_BYTES + 1)
        def ordered(fd):
            scans[0] += 1
            return ["large", "disappeared"]
        with mock.patch.object(launch.os, "listdir", side_effect=ordered):
            rejected(lambda: launch.workspace_bytes(root), "exceeded workspace disk limit")
        assert scans[0] == 1, "observed excess must never be retried away"

    elif case == "other-errors":
        for failure in (PermissionError(errno.EACCES, "synthetic"),
                        NotADirectoryError(errno.ENOTDIR, "synthetic"),
                        OSError(errno.EIO, "synthetic")):
            with mock.patch.object(launch.os, "stat", side_effect=failure) as probe:
                rejected(lambda: launch.workspace_bytes(root), f"errno={failure.errno}")
                assert probe.call_count == 1

    elif case == "scope-and-root-errors":
        outside = Path(temporary) / "outside"
        outside.mkdir()
        with (outside / "large").open("wb") as output:
            output.truncate(launch.MAX_WORKSPACE_BYTES + 1)
        (root / "link").symlink_to(outside, target_is_directory=True)
        assert launch.workspace_bytes(root) == 7 + (root / "link").lstat().st_size
        for invalid in (root / "link", root / "steady", root / "absent"):
            rejected(lambda: launch.workspace_bytes(invalid), "cannot open root")

    elif case == "directory-replacement":
        nested = root / "nested"
        nested.mkdir()
        (nested / "old").write_bytes(b"old")
        replacements = [0]
        def replace_before_open(name, flags, **kwargs):
            if name == "nested" and replacements[0] == 0:
                replacements[0] += 1
                nested.rename(Path(temporary) / "retired")
                nested.mkdir()
                (nested / "new").write_bytes(b"replacement")
            return real_open(name, flags, **kwargs)
        with mock.patch.object(launch.os, "open", side_effect=replace_before_open):
            assert launch.workspace_bytes(root) == 7 + len(b"replacement")
        assert replacements[0] == 1

    elif case == "nested-git-cleanup":
        hooks = root / "negative-clone" / ".git" / "hooks"
        hooks.mkdir(parents=True)
        transient = hooks / "prepare-commit-msg.sample"
        transient.write_bytes(b"git cleanup fixture")
        parent_before = hooks.stat()
        real_unlink, real_write, real_open = os.unlink, os.write, os.open
        real_sleep = launch.time.sleep
        active = [True]
        disappeared = [0]
        delays = []
        content = transient.read_bytes()

        def disappear_after_listing(name, *, dir_fd=None, follow_symlinks=True):
            if os.fsdecode(name) == transient.name and active[0]:
                disappeared[0] += 1
                real_unlink(name, dir_fd=dir_fd)
                try:
                    return real_stat(name, dir_fd=dir_fd, follow_symlinks=follow_symlinks)
                except FileNotFoundError:
                    descriptor = real_open(
                        name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=dir_fd
                    )
                    try:
                        real_write(descriptor, content)
                    finally:
                        real_close(descriptor)
                    raise
            return real_stat(name, dir_fd=dir_fd, follow_symlinks=follow_symlinks)

        def cleanup_yield(seconds):
            assert 0 < seconds <= 0.01
            delays.append(seconds)
            active[0] = False
            real_sleep(0)

        with mock.patch.object(launch.os, "stat", side_effect=disappear_after_listing), \
             mock.patch.object(launch.time, "sleep", side_effect=cleanup_yield):
            assert launch.workspace_bytes(root) == 7 + len(content)
        assert disappeared == [1], "one real ENOENT must discard and retry the complete scan"
        assert len(delays) == 1, "retry must yield within the pre-existing deadline"
        parent_after = hooks.stat()
        assert (parent_before.st_dev, parent_before.st_ino) == (parent_after.st_dev, parent_after.st_ino)
        assert transient.read_bytes() == content

    elif case == "scan-and-operation-deadlines":
        for outer_deadline, maximum_calls in ((None, 6), (0.3, 3)):
            ticks = [0]
            def clock():
                value = ticks[0] * 0.2
                ticks[0] += 1
                return value
            with mock.patch.object(launch.os, "listdir", side_effect=churn(100)), \
                 mock.patch.object(launch.time, "monotonic", side_effect=clock):
                rejected(lambda: launch.workspace_bytes(root, deadline=outer_deadline), "bounded scan deadline")
            assert ticks[0] <= maximum_calls

    elif case == "cancellation-descriptor-cleanup":
        descriptors = []
        def capture_open(*args, **kwargs):
            fd = real_open(*args, **kwargs)
            descriptors.append(fd)
            return fd
        def cancel(*args, **kwargs):
            launch.on_cancel(signal.SIGTERM, None)
        with mock.patch.object(launch.os, "open", side_effect=capture_open), \
             mock.patch.object(launch.os, "stat", side_effect=cancel):
            try:
                launch.workspace_bytes(root)
            except launch.Cancelled as error:
                assert error.args == (signal.SIGTERM,)
            else:
                raise AssertionError("cancellation was swallowed")
        assert descriptors
        for fd in descriptors:
            try:
                os.fstat(fd)
            except OSError as error:
                assert error.errno == errno.EBADF
            else:
                raise AssertionError("workspace descriptor leaked")
    else:
        raise AssertionError("unknown accounting case")

print(json.dumps({"case": case, "status": "PASS"}))
