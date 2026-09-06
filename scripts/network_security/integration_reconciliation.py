"""Opt-in disposable systemd integration; no real firewall commands or data."""
import copy
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

try:
    import ipv6_guard as guard
    from reconciliation import Reconciler, ReconciliationError, ReconciliationLinuxBackend, regular_file_present
except ModuleNotFoundError:
    from . import ipv6_guard as guard
    from .reconciliation import Reconciler, ReconciliationError, ReconciliationLinuxBackend, regular_file_present

RUN_ID = "f15efb347860c80f9271"
UNIT_DIR = Path("/run/systemd/system")


def require_disposable_systemd():
    if (sys.platform != "linux" or os.geteuid() != 0
            or os.environ.get("STK_DISPOSABLE_SYSTEMD") != "1"
            or not Path("/.dockerenv").is_file()
            or Path("/proc/1/comm").read_text().strip() != "systemd"):
        raise RuntimeError("requires explicit disposable Docker/systemd opt-in")


def systemctl(*arguments, check=True):
    return subprocess.run(["/usr/bin/systemctl", *arguments], capture_output=True,
                          text=True, timeout=15, check=check)


class SystemdOnlyAdapter(guard.LinuxAdapter):
    def __init__(self):
        super().__init__(execute_reviewed=True)

    def _call(self, argv, ok=(0,)):
        if argv[0] not in (self.SYSTEMCTL, self.BUSCTL):
            raise AssertionError("fixture forbids real firewall and other system commands")
        return super()._call(argv, ok=ok)


class DisposableSystemdBackend(ReconciliationLinuxBackend):
    def __init__(self):
        super().__init__(adapter=SystemdOnlyAdapter())
        self.simulated_ipv6 = {"policies": {"INPUT": "ACCEPT", "FORWARD": "ACCEPT", "OUTPUT": "ACCEPT"},
                               "chains": {"INPUT": [], "FORWARD": [], "OUTPUT": [], "DOCKER-USER": []}}
        self.simulated_persistence = {"rules.v4": b"ipv4-before", "rules.v6": b"ipv6-before"}
        self.simulated_ipv4 = b"ipv4-active"

    def snapshot(self):
        return copy.deepcopy(self.simulated_ipv6)

    def persistence_files(self):
        return dict(self.simulated_persistence)

    def ipv4_active(self):
        return self.simulated_ipv4


class ReconciliationSystemdIntegration(unittest.TestCase):
    def setUp(self):
        try:
            require_disposable_systemd()
        except RuntimeError as exc:
            self.skipTest(str(exc))
        self.temp = tempfile.TemporaryDirectory(prefix="stk-reconciliation-systemd-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.run_dir = self.root / RUN_ID
        self.run_dir.mkdir(mode=0o700)
        self.backend = DisposableSystemdBackend()
        self.unit_names = guard.unit_names(RUN_ID)
        self.unit_bytes = {name: self._unit_content(name).encode() for name in self.unit_names}
        self.owned = {}
        self.references = None
        self.addCleanup(self._cleanup_units)
        self._write_bundle()
        self._install_units()
        systemctl("daemon-reload")
        # Keep BOTH valid units loaded without starting the rollback service.
        # This reference is fixture scaffolding, not a historical proof for the reconciler.
        self.references = guard.SystemdReferences(self.unit_names)
        self.references.__enter__()
        systemctl("start", self.unit_names[1])
        systemctl("stop", self.unit_names[1])
        self.assertEqual(self.backend.unit_info(self.unit_names[0])["ExecMainStartTimestampMonotonic"], "0")
        self.reconciler = Reconciler(self.root, self.backend, timeout=10, ipv4_evidence={
            "schema": 1, "run_id": RUN_ID, "boot_id": self.backend.boot_id(),
            "manifest_sha256": guard.digest(self.manifest_raw), "source": "external-private-observation",
            "observed_monotonic_ns": self.observed_ns, "data_file": "ipv4.active",
            "active_sha256": guard.digest(self.backend.simulated_ipv4), "active_bytes": self.backend.simulated_ipv4})

    @staticmethod
    def _unit_content(name):
        if name.endswith(".timer"):
            return ("[Unit]\nDescription=disposable reconciliation timer\n[Timer]\nOnActiveSec=3600s\n"
                    "AccuracySec=1s\nRandomizedDelaySec=0\nPersistent=false\nUnit=" + name[:-6] + ".service\n")
        return "[Unit]\nDescription=disposable reconciliation service\n[Service]\nType=simple\nExecStart=/bin/sleep 60\n"

    def _write_bundle(self):
        script, backup = b"old fixture script\n", b"old fixture backup\n"
        self.observed_ns = time.monotonic_ns()
        for name, data in self.unit_bytes.items():
            guard.private_write(self.run_dir / name, data)
        guard.private_write(self.run_dir / "ipv6_guard.py", script)
        guard.private_write(self.run_dir / "persistence.before.json", backup)
        manifest = {"schema": 1, "run_id": RUN_ID, "before": self.backend.snapshot(), "boot_id": self.backend.boot_id(),
                    "script_sha256": guard.digest(script), "backup_sha256": guard.digest(backup),
                    "persistence_sha256": {name: guard.digest(data) for name, data in self.backend.simulated_persistence.items()},
                    "unit_sha256": {name: guard.digest(data) for name, data in self.unit_bytes.items()},
                    "persistence_mode": guard.PERSISTENCE_MODE, "chain": guard.chain_name(RUN_ID),
                    "tag": "stk6:" + RUN_ID + ":disposable", "window_seconds": 600, "prepared_monotonic_ns": time.monotonic_ns()}
        self.manifest_raw = guard.encoded(manifest)
        guard.private_write(self.run_dir / "manifest.json", self.manifest_raw)
        state = {**manifest, "manifest_sha256": guard.digest(self.manifest_raw), "phase": "rollback_incomplete",
                 "actions": [], "rollback_actions": [], "units": {name: {"acquired": True, "installed": True} for name in self.unit_names}}
        self.journal_raw = guard.encoded(state)
        guard.private_write(self.run_dir / "journal.json", self.journal_raw)
        guard.private_write(self.root / "active.json", guard.encoded({"run_id": RUN_ID}))

    def _install_units(self):
        for name in self.unit_names:
            if regular_file_present(UNIT_DIR / name):
                raise RuntimeError("fixture unit collision: " + name)
        for name, data in self.unit_bytes.items():
            target = UNIT_DIR / name
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            self.owned[name] = data
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())

    def _cleanup_units(self):
        try:
            for name, original in self.owned.items():
                target = UNIT_DIR / name
                if regular_file_present(target) and guard.private_read(target) != original:
                    raise RuntimeError("fixture cleanup refuses foreign unit bytes")
                # Only synthetic units exclusively created by this fixture.
                systemctl("stop", name, check=False)
                if regular_file_present(target):
                    target.unlink()
            if self.owned:
                systemctl("daemon-reload", check=False)
        finally:
            if self.references is not None:
                self.references.__exit__(None, None, None)

    def _pause(self, checkpoint):
        def hook(point, evidence):
            if point == checkpoint:
                raise OSError("fixture interruption: " + point)
        self.reconciler.interruption_hook = hook
        with self.assertRaisesRegex(OSError, checkpoint):
            self.reconciler.reconcile(RUN_ID)
        self.reconciler.interruption_hook = None

    def _assert_complete(self):
        self.assertEqual(self.reconciler.reconcile(RUN_ID)["phase"], "complete")
        self.assertTrue(self.reconciler.reconcile(RUN_ID)["noop"])
        self.assertEqual((self.run_dir / "journal.json").read_bytes(), self.journal_raw)
        self.assertEqual((self.run_dir / "manifest.json").read_bytes(), self.manifest_raw)
        self.assertFalse((self.root / "active.json").exists())
        for name in self.unit_names:
            self.assertFalse((UNIT_DIR / name).exists())
            self.assertEqual(self.backend.unit_info(name)["LoadState"], "not-found")

    def test_normal_completion_and_repetition(self):
        self._assert_complete()

    def test_resume_after_evidence(self):
        self._pause("after-evidence")
        self._assert_complete()

    def test_resume_with_unit_still_loaded_after_unlink(self):
        self._pause("after-unlink")
        self.assertFalse((UNIT_DIR / self.unit_names[0]).exists())
        self.assertEqual(self.backend.unit_info(self.unit_names[0])["LoadState"], "loaded")
        self._assert_complete()

    def test_resume_after_unlinked_unit_has_been_unloaded(self):
        self._pause("after-unlink")
        systemctl("daemon-reload")
        self.assertEqual(self.backend.unit_info(self.unit_names[0])["LoadState"], "not-found")
        self._assert_complete()

    def test_resume_after_daemon_reload(self):
        self._pause("after-daemon-reload")
        self._assert_complete()

    def test_resume_after_archive_creation(self):
        self._pause("after-archive-create")
        self._assert_complete()

    def test_resume_after_archive_created_checkpoint(self):
        self._pause("after-archive-created")
        self._assert_complete()

    def test_resume_after_active_unlink(self):
        self._pause("after-active-unlink")
        self._assert_complete()

    def test_missing_archive_after_created_preserves_active(self):
        self._pause("after-archive-created")
        self.reconciler.archive_path(RUN_ID).unlink()
        with self.assertRaisesRegex(ReconciliationError, "archive missing"):
            self.reconciler.reconcile(RUN_ID)
        self.assertTrue((self.root / "active.json").is_file())

    def test_corrupted_archive_after_created_preserves_active(self):
        self._pause("after-archive-created")
        guard.private_write(self.reconciler.archive_path(RUN_ID), b"corrupted")
        with self.assertRaisesRegex(ReconciliationError, "archive readback"):
            self.reconciler.reconcile(RUN_ID)
        self.assertTrue((self.root / "active.json").is_file())

    def test_real_service_activation_between_unlinks_preserves_timer_file(self):
        def hook(point, evidence):
            if point == "after-unlink":
                systemctl("start", self.unit_names[0])
        self.reconciler.interruption_hook = hook
        with self.assertRaisesRegex(ReconciliationError, "quiescent"):
            self.reconciler.reconcile(RUN_ID)
        self.assertTrue((UNIT_DIR / self.unit_names[1]).is_file())
        self.assertTrue((self.root / "active.json").is_file())

    def test_dangling_unit_collision_blocks_noop(self):
        self._assert_complete()
        target = UNIT_DIR / self.unit_names[0]
        target.symlink_to(self.root / "fixture-missing-target")
        try:
            systemctl("daemon-reload")
            with self.assertRaisesRegex(ReconciliationError, "symlink"):
                self.reconciler.reconcile(RUN_ID)
            self.assertTrue(target.is_symlink())
        finally:
            target.unlink()  # This test's own deliberately created symlink only.

    def test_fixture_install_collision_preserves_bytes(self):
        with self.assertRaisesRegex(RuntimeError, "collision"):
            self._install_units()
        for name, original in self.unit_bytes.items():
            self.assertEqual(guard.private_read(UNIT_DIR / name), original)

    def test_fixture_rejects_real_firewall_commands(self):
        with self.assertRaisesRegex(AssertionError, "forbids real firewall"):
            self.backend.adapter._call(["/usr/sbin/iptables", "-S"])


if __name__ == "__main__":
    require_disposable_systemd()
    unittest.main(verbosity=2)
