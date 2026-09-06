"""Disposable real-systemd integration for controlled reconciliation."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

try:
    import ipv6_guard as guard
    from reconciliation import Reconciler, ReconciliationError, ReconciliationLinuxBackend
except ModuleNotFoundError:
    from . import ipv6_guard as guard
    from .reconciliation import Reconciler, ReconciliationError, ReconciliationLinuxBackend

RUN_ID = "f15efb347860c80f9271"
UNIT_DIR = Path("/run/systemd/system")


def require_disposable_systemd():
    if (sys.platform != "linux" or os.geteuid() != 0
            or os.environ.get("STK_DISPOSABLE_SYSTEMD") != "1"
            or not Path("/.dockerenv").is_file()
            or Path("/proc/1/comm").read_text().strip() != "systemd"):
        raise RuntimeError("requires explicit disposable Docker/systemd opt-in")


def systemctl(*arguments, check=True):
    return subprocess.run(
        ["/usr/bin/systemctl", *arguments],
        capture_output=True,
        text=True,
        timeout=15,
        check=check,
    )


class DisposableSystemdBackend(ReconciliationLinuxBackend):
    """Real systemd observations with file-backed non-firewall state."""

    def __init__(self):
        super().__init__()
        self.simulated_ipv6 = {
            "policies": {"INPUT": "ACCEPT", "FORWARD": "ACCEPT", "OUTPUT": "ACCEPT"},
            "chains": {"INPUT": [], "FORWARD": [], "OUTPUT": [], "DOCKER-USER": []},
        }
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
        if os.name != "posix":
            self.skipTest("real systemd integration requires Linux")
        if not (sys.platform == "linux" and os.geteuid() == 0
                and os.environ.get("STK_DISPOSABLE_SYSTEMD") == "1"
                and Path("/.dockerenv").is_file()
                and Path("/proc/1/comm").read_text().strip() == "systemd"):
            self.skipTest("real systemd integration requires explicit disposable Docker/systemd opt-in")
        self.temp = tempfile.TemporaryDirectory(prefix="stk-reconciliation-systemd-")
        self.addCleanup(self._cleanup_units)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.run_dir = self.root / RUN_ID
        self.run_dir.mkdir(mode=0o700)
        self.backend = DisposableSystemdBackend()
        self.unit_names = guard.unit_names(RUN_ID)
        self.unit_bytes = {
            name: self._unit_content(name).encode() for name in self.unit_names
        }
        self._write_bundle()
        self._install_units()
        systemctl("daemon-reload")
        self.reconciler = Reconciler(self.root, self.backend, timeout=10)

    @staticmethod
    def _unit_content(name):
        if name.endswith(".timer"):
            service = name[:-6] + ".service"
            return "[Unit]\nDescription=disposable reconciliation timer\n\n[Timer]\nUnit=" + service + "\n"
        return "[Unit]\nDescription=disposable reconciliation service\n\n[Service]\nType=oneshot\nExecStart=/bin/true\n"

    def _write_bundle(self):
        script = b"old rollback script\n"
        backup = b"old persistence backup\n"
        for name, data in self.unit_bytes.items():
            guard.private_write(self.run_dir / name, data)
        guard.private_write(self.run_dir / "ipv6_guard.py", script)
        guard.private_write(self.run_dir / "persistence.before.json", backup)
        guard.private_write(self.run_dir / "ipv4.active", self.backend.simulated_ipv4)
        manifest = {
            "schema": 1,
            "run_id": RUN_ID,
            "before": self.backend.snapshot(),
            "boot_id": self.backend.boot_id(),
            "script_sha256": guard.digest(script),
            "persistence_sha256": {name: guard.digest(data) for name, data in self.backend.simulated_persistence.items()},
            "unit_sha256": {name: guard.digest(data) for name, data in self.unit_bytes.items()},
            "backup_sha256": guard.digest(backup),
            "persistence_mode": guard.PERSISTENCE_MODE,
            "chain": guard.chain_name(RUN_ID),
            "tag": "stk6:" + RUN_ID + ":disposable",
            "window_seconds": 600,
            "prepared_monotonic_ns": 1,
            "ipv4_active_evidence": {
                "run_id": RUN_ID,
                "file": "ipv4.active",
                "sha256": guard.digest(self.backend.simulated_ipv4),
                "active_sha256": guard.digest(self.backend.simulated_ipv4),
            },
        }
        manifest_raw = guard.encoded(manifest)
        guard.private_write(self.run_dir / "manifest.json", manifest_raw)
        state = {
            **manifest,
            "manifest_sha256": guard.digest(manifest_raw),
            "phase": "rollback_incomplete",
            "actions": [],
            "rollback_actions": [],
            "units": {},
        }
        guard.private_write(self.run_dir / "journal.json", guard.encoded(state))
        guard.private_write(self.root / "active.json", guard.encoded({"run_id": RUN_ID}))

    def _install_units(self):
        for name, data in self.unit_bytes.items():
            target = UNIT_DIR / name
            target.write_bytes(data)
            target.chmod(0o600)

    def _cleanup_units(self):
        for name in self.unit_names:
            target = UNIT_DIR / name
            if target.is_file() and not target.is_symlink():
                target.unlink()
        systemctl("daemon-reload", check=False)

    def _interrupt_after_first_unlink(self):
        fired = False

        def hook(point, evidence):
            nonlocal fired
            if point == "after-unlink" and not fired:
                fired = True
                raise OSError("disposable interruption after unlink")

        return hook

    def test_completion_resume_and_repetition_with_loaded_units(self):
        self.reconciler.interruption_hook = self._interrupt_after_first_unlink()
        with self.assertRaisesRegex(OSError, "after unlink"):
            self.reconciler.reconcile(RUN_ID)
        self.reconciler.interruption_hook = None
        self.assertFalse((UNIT_DIR / self.unit_names[0]).exists())
        self.assertEqual(systemctl("show", self.unit_names[0], "--property=LoadState", "--value").stdout.strip(), "loaded")
        result = self.reconciler.reconcile(RUN_ID)
        self.assertFalse(result["noop"])
        self.assertEqual(systemctl("show", self.unit_names[0], "--property=LoadState", "--value").stdout.strip(), "not-found")
        self.assertEqual(systemctl("show", self.unit_names[1], "--property=LoadState", "--value").stdout.strip(), "not-found")
        self.assertTrue(self.reconciler.archive_path(RUN_ID).is_file())
        self.assertTrue(self.reconciler.reconcile(RUN_ID)["noop"])


if __name__ == "__main__":
    require_disposable_systemd()
    unittest.main(verbosity=2)
