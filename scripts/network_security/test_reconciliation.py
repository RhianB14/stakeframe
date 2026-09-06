"""Simulation-only tests for controlled STK-M0-06 reconciliation."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
import ipv6_guard as guard
from reconciliation import ReconciliationError, Reconciler

RUN_ID = "f15efb347860c80f9271"


class FakeReconciliationBackend:
    UNIT_DIR = Path("/fake/systemd")

    def __init__(self, state):
        self.boot = state["boot_id"]
        self.before = copy.deepcopy(state["before"])
        self.current = copy.deepcopy(self.before)
        self.persistence = {"rules.v4": b"ipv4-before", "rules.v6": b"ipv6-before"}
        self.units = {}
        self.jobs = []
        self.reloads = 0
        self.readback = {"timer_stopped": True, "service_never_started": True, "jobs": []}
        self.fail_reload = False

    def boot_id(self):
        return self.boot

    def snapshot(self):
        return copy.deepcopy(self.current)

    def persistence_files(self):
        return dict(self.persistence)

    def ipv4_active(self):
        return b"ipv4-active"

    def quiescence_readback(self, state):
        if self.readback is None:
            raise ReconciliationError("systemd state unknown")
        if self.readback.get("jobs"):
            raise ReconciliationError("systemd job remains pending")
        if self.readback.get("service_never_started") is not True:
            raise ReconciliationError("service execution evidence contradicts reconciliation")
        if self.readback.get("timer_stopped") is not True:
            raise ReconciliationError("timer state unknown or still pending")
        return {"service": {"active": "inactive", "sub": "dead", "result": "success", "status": 0, "start_us": 0},
                "timer": {"active": "inactive", "sub": "dead", "next_us": 0}, "jobs": []}

    def unit_info(self, name):
        path = self.UNIT_DIR / name
        if name not in self.units:
            return {"LoadState": "not-found", "FragmentPath": ""}
        return {"LoadState": "loaded", "FragmentPath": str(path)}

    def read_unit_file(self, name):
        if name not in self.units:
            raise ReconciliationError("unit file absent")
        return self.units[name]

    def unit_file_exists(self, name):
        return name in self.units

    def remove_unit_file(self, name, expected_sha256=None):
        if name not in self.units:
            raise ReconciliationError("unit file absent")
        if expected_sha256 is not None and guard.digest(self.units[name]) != expected_sha256:
            raise ReconciliationError("runtime unit hash changed")
        del self.units[name]

    def list_jobs(self, names):
        return [job for job in self.jobs if job[0] in names]

    def units_absent(self, names):
        return all(name not in self.units and self.unit_info(name)["LoadState"] == "not-found" for name in names)

    def daemon_reload(self):
        if self.fail_reload:
            raise OSError("simulated daemon-reload failure")
        self.reloads += 1

    def cleanup_readback(self, names):
        if self.jobs:
            raise ReconciliationError("systemd job remains pending after daemon-reload")
        if not self.units_absent(names):
            raise ReconciliationError("unit remains after daemon-reload")
        return {"units_absent": True, "jobs": []}


class ReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "state"
        self.store = guard.Store(self.root)
        self.run_dir = self.root / RUN_ID
        self.run_dir.mkdir(mode=0o700)
        self.unit_names = guard.unit_names(RUN_ID)
        self.unit_bytes = {name: ("[Unit]\nDescription=original " + name + "\n").encode() for name in self.unit_names}
        self.before = {"policies": {"INPUT": "ACCEPT", "FORWARD": "ACCEPT", "OUTPUT": "ACCEPT"},
                       "chains": {"INPUT": [], "FORWARD": [["-j", "DOCKER-USER"]], "OUTPUT": [], "DOCKER-USER": [["-j", "RETURN"]]}}
        manifest = {"schema": 1, "run_id": RUN_ID, "before": self.before, "boot_id": "boot-a",
                    "script_sha256": guard.digest(b"old-script"), "persistence_sha256": {"rules.v4": guard.digest(b"ipv4-before"), "rules.v6": guard.digest(b"ipv6-before")},
                    "unit_sha256": {name: guard.digest(data) for name, data in self.unit_bytes.items()}, "backup_sha256": guard.digest(b"old-backup"),
                    "persistence_mode": guard.PERSISTENCE_MODE, "chain": guard.chain_name(RUN_ID), "tag": "stk6:" + RUN_ID + ":oldtag", "window_seconds": 600, "prepared_monotonic_ns": 1,
                    "ipv4_active_evidence": {"run_id": RUN_ID, "file": "ipv4.active", "sha256": guard.digest(b"ipv4-active"), "active_sha256": guard.digest(b"ipv4-active")}}
        manifest_raw = guard.encoded(manifest)
        guard.private_write(self.run_dir / "manifest.json", manifest_raw)
        guard.private_write(self.run_dir / "ipv6_guard.py", b"old-script")
        guard.private_write(self.run_dir / "persistence.before.json", b"old-backup")
        self.state = {**manifest, "manifest_sha256": guard.digest(manifest_raw), "phase": "rollback_incomplete", "actions": [], "rollback_actions": [], "units": {}}
        guard.private_write(self.run_dir / "journal.json", guard.encoded(self.state))
        guard.private_write(self.run_dir / "ipv4.active", b"ipv4-active")
        self.backend = FakeReconciliationBackend(self.state)
        for name, data in self.unit_bytes.items():
            guard.private_write(self.run_dir / name, data)
            self.backend.units[name] = data
        self.active_bytes = guard.encoded({"run_id": RUN_ID})
        guard.private_write(self.root / "active.json", self.active_bytes)
        self.reconciler = Reconciler(self.root, self.backend, timeout=0.2)

    def test_success_removes_owned_units_and_archives_active_bytes(self):
        result = self.reconciler.reconcile(RUN_ID)
        self.assertEqual(result["phase"], "complete")
        self.assertEqual(self.backend.reloads, 1)
        archive = self.root / ("active.reconciled-" + RUN_ID + ".json")
        self.assertEqual(archive.read_bytes(), self.active_bytes)
        self.assertFalse((self.root / "active.json").exists())
        self.assertEqual(self.store.read(RUN_ID)["phase"], "rollback_incomplete")

    def test_repeating_after_success_is_verified_noop(self):
        self.reconciler.reconcile(RUN_ID)
        second = self.reconciler.reconcile(RUN_ID)
        self.assertTrue(second["noop"])
        self.assertEqual(self.backend.reloads, 1)

    def test_partial_unit_removal_resumes_only_after_prior_intent(self):
        original = self.reconciler._remove_unit
        calls = []
        def fail_after_first(name, evidence):
            calls.append(name)
            original(name, evidence)
            if len(calls) == 1:
                raise OSError("simulated crash after first unlink")
        self.reconciler._remove_unit = fail_after_first
        with self.assertRaises(OSError):
            self.reconciler.reconcile(RUN_ID)
        self.assertNotIn(self.unit_names[0], self.backend.units)
        self.assertIn(self.unit_names[1], self.backend.units)
        self.reconciler._remove_unit = original
        self.assertEqual(self.reconciler.reconcile(RUN_ID)["phase"], "complete")

    def test_daemon_reload_failure_preserves_active_and_retries(self):
        self.backend.fail_reload = True
        with self.assertRaises(OSError):
            self.reconciler.reconcile(RUN_ID)
        self.assertTrue((self.root / "active.json").exists())
        self.backend.fail_reload = False
        self.assertEqual(self.reconciler.reconcile(RUN_ID)["phase"], "complete")

    def test_archive_collision_is_refused_without_touching_active(self):
        archive = self.root / ("active.reconciled-" + RUN_ID + ".json")
        guard.private_write(archive, b"foreign")
        with self.assertRaisesRegex(ReconciliationError, "collision"):
            self.reconciler.reconcile(RUN_ID)
        self.assertTrue((self.root / "active.json").exists())

    def test_missing_active_without_completed_evidence_is_unknown(self):
        (self.root / "active.json").unlink()
        with self.assertRaisesRegex(ReconciliationError, "active.json"):
            self.reconciler.reconcile(RUN_ID)

    def test_wrong_active_identity_is_refused(self):
        guard.private_write(self.root / "active.json", guard.encoded({"run_id": "0123456789abcdefabcd"}))
        with self.assertRaisesRegex(ReconciliationError, "identity"):
            self.reconciler.reconcile(RUN_ID)

    def test_modified_unit_is_not_removed(self):
        self.backend.units[self.unit_names[0]] = b"modified"
        with self.assertRaisesRegex(ReconciliationError, "hash"):
            self.reconciler.reconcile(RUN_ID)
        self.assertIn(self.unit_names[0], self.backend.units)

    def test_modified_bundle_unit_is_not_removed(self):
        guard.private_write(self.run_dir / self.unit_names[0], b"modified bundle")
        with self.assertRaisesRegex(ReconciliationError, "bundle"):
            self.reconciler.reconcile(RUN_ID)

    def test_original_script_and_backup_hashes_are_required(self):
        guard.private_write(self.run_dir / "ipv6_guard.py", b"changed")
        with self.assertRaisesRegex(ReconciliationError, "script"):
            self.reconciler.reconcile(RUN_ID)
        guard.private_write(self.run_dir / "ipv6_guard.py", b"old-script")
        guard.private_write(self.run_dir / "persistence.before.json", b"changed")
        with self.assertRaisesRegex(ReconciliationError, "backup"):
            self.reconciler.reconcile(RUN_ID)

    def test_boot_change_is_refused(self):
        self.backend.boot = "boot-b"
        with self.assertRaisesRegex(ReconciliationError, "boot"):
            self.reconciler.reconcile(RUN_ID)

    def test_restoration_ipv4_and_persistence_drift_are_refused(self):
        self.backend.current["policies"]["INPUT"] = "DROP"
        with self.assertRaisesRegex(ReconciliationError, "snapshot"):
            self.reconciler.reconcile(RUN_ID)
        self.backend.current = copy.deepcopy(self.before)
        self.backend.persistence["rules.v4"] = b"changed"
        with self.assertRaisesRegex(ReconciliationError, "persistence"):
            self.reconciler.reconcile(RUN_ID)
        self.backend.persistence["rules.v4"] = b"ipv4-before"
        self.backend.ipv4_active = lambda: b"changed"
        with self.assertRaisesRegex(ReconciliationError, "IPv4"):
            self.reconciler.reconcile(RUN_ID)

    def test_unknown_execution_or_jobs_are_refused(self):
        self.backend.readback = None
        with self.assertRaisesRegex(ReconciliationError, "unknown"):
            self.reconciler.reconcile(RUN_ID)
        self.backend.readback = {"timer_stopped": True, "service_never_started": False, "jobs": []}
        with self.assertRaisesRegex(ReconciliationError, "execution"):
            self.reconciler.reconcile(RUN_ID)
        self.backend.readback = {"timer_stopped": True, "service_never_started": True, "jobs": [["42", self.unit_names[1]]]}
        with self.assertRaisesRegex(ReconciliationError, "job"):
            self.reconciler.reconcile(RUN_ID)

    def test_concurrent_reconciliation_uses_global_lock(self):
        first = guard.Store(self.root)
        second = Reconciler(self.root, self.backend, timeout=0.01)
        with first.lock():
            with self.assertRaisesRegex(guard.GuardError, "lock"):
                second.reconcile(RUN_ID)

    def test_status_remains_read_only(self):
        before = set(self.root.rglob("*"))
        result = self.reconciler.status(RUN_ID)
        after = set(self.root.rglob("*"))
        self.assertEqual(before, after - {self.root / "operation.lock"})
        self.assertEqual(result["phase"], "rollback_incomplete")

    def _interrupt_once(self, point):
        fired = False
        def interrupt(current, evidence):
            nonlocal fired
            if current == point and not fired:
                fired = True
                raise OSError("interrupt at " + point)
        self.reconciler.interruption_hook = interrupt
        with self.assertRaises(OSError):
            self.reconciler.reconcile(RUN_ID)
        self.reconciler.interruption_hook = None
        self.assertEqual(self.reconciler.reconcile(RUN_ID)["phase"], "complete")

    def test_interrupt_after_unlink_resumes(self):
        self._interrupt_once("after-unlink")

    def test_interrupt_after_daemon_reload_resumes(self):
        self._interrupt_once("after-daemon-reload")

    def test_interrupt_after_archive_creation_resumes(self):
        self._interrupt_once("after-archive-create")

    def test_interrupt_after_active_unlink_resumes(self):
        self._interrupt_once("after-active-unlink")

    def test_wrong_fragment_path_is_refused(self):
        name = self.unit_names[0]
        original = self.backend.unit_info
        self.backend.unit_info = lambda queried: {"LoadState": "loaded", "FragmentPath": "/foreign/" + queried} if queried == name else original(queried)
        with self.assertRaisesRegex(ReconciliationError, "path"):
            self.reconciler.reconcile(RUN_ID)

    def test_wrong_run_id_is_refused_before_mutation(self):
        with self.assertRaisesRegex(ReconciliationError, "identity"):
            self.reconciler.reconcile("0123456789abcdefabcd")
        self.assertTrue((self.root / "active.json").exists())


if __name__ == "__main__":
    unittest.main()
