"""Simulation ONLY. No subprocess, privilege escalation or networking permitted."""
import importlib.util
import os
import copy
import json
import tempfile
import threading
import hashlib
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

# An accidental call from the production Linux adapter must fail before spawning.
PROCESS_GUARDS = [patch.object(subprocess, "Popen", side_effect=AssertionError("REAL SUBPROCESS FORBIDDEN")),
                  patch.object(os, "system", side_effect=AssertionError("REAL SHELL FORBIDDEN"))]
for guard in PROCESS_GUARDS:
    guard.start()
sys.path.insert(0, str(Path(__file__).parent))
try:
    import ipv6_guard as guard
except ModuleNotFoundError:
    guard = None


class RulesTests(unittest.TestCase):
    def test_complete_chain_is_bounded_tagged_and_has_no_return(self):
        self.assertIsNotNone(guard, "IPv6 guard implementation is missing")
        run_id = guard.new_run_id()
        self.assertRegex(run_id, r"^[0-9a-f]{20}$")
        chain = guard.chain_name(run_id)
        self.assertLessEqual(len(chain), 28)
        rules = guard.input_rules("stk6:" + run_id)
        self.assertEqual(rules[0][:2], ["-i", "lo"])
        self.assertIn("ESTABLISHED,RELATED", rules[1])
        self.assertIn("ipv6-icmp", rules[2])
        self.assertIn("22", rules[3])
        self.assertEqual(rules[-1][-2:], ["-j", "DROP"])
        self.assertNotIn("RETURN", sum(rules, []))
        self.assertTrue(all("stk6:" + run_id in rule for rule in rules))
        with self.assertRaises(ValueError):
            guard.chain_name("../bad")


class FakeLinux:
    """In-memory kernel/systemd double, never delegates to operating tools."""
    def __init__(self):
        self.now = 1_000_000_000_000
        self.boot = "simulated-boot"
        self.fw = {"policies": {"INPUT": "ACCEPT", "FORWARD": "ACCEPT", "OUTPUT": "ACCEPT"},
                   "chains": {"INPUT": [], "FORWARD": [["-j", "DOCKER-USER"], ["-j", "DOCKER-FORWARD"]],
                              "OUTPUT": [], "DOCKER-USER": [["-j", "RETURN"]], "DOCKER-FORWARD": []}}
        self.files = {"rules.v4": b"simulated IPv4 persistence", "rules.v6": b"simulated IPv6 persistence"}
        self.events = []
        self.fail = None
        self.after = False
        self.timer = {"active": "inactive", "sub": "dead", "next_us": 0}
        self.service = {"active": "inactive", "sub": "dead", "result": "success", "status": 0, "start_us": 0}
        self.jobs = []
        self.on_stop = None
        self.on_observe = None
        self.persistence_error = False

    def monotonic_ns(self):
        self.now += 1_000_000
        return self.now

    def boot_id(self):
        return self.boot

    def snapshot(self):
        return copy.deepcopy(self.fw)

    def persistence_files(self):
        if self.persistence_error:
            raise OSError("simulated persistence read failure")
        return dict(self.files)

    def units_absent(self, run_id):
        return True

    def arm(self, state, directory, record):
        for name in guard.unit_names(state["run_id"]):
            for event in ("intent", "acquired", "installed"):
                record(name, event)
        record(guard.unit_names(state["run_id"])[1], "start_intent")
        record(guard.unit_names(state["run_id"])[1], "started")
        self.events.append(("arm",))
        self.timer = {"active": "active", "sub": "waiting", "next_us": self.now // 1000 + state["window_seconds"] * 1_000_000}

    def observe(self, state):
        if self.on_observe:
            self.on_observe()
        return {"timer": dict(self.timer), "service": dict(self.service), "jobs": list(self.jobs)}

    def timer_stopped(self, state):
        return self.timer == {"active": "inactive", "sub": "dead", "next_us": 0}

    def stop_timer(self, state):
        self.events.append(("stop_timer",))
        self.timer = {"active": "inactive", "sub": "dead", "next_us": 0}
        if self.on_stop:
            callback, self.on_stop = self.on_stop, None
            callback()

    def mutate(self, op, *args):
        event = (op,) + args
        self.events.append(event)
        fail = self.fail and self.fail(event)
        if fail and not self.after:
            self.fail = None
            raise OSError("simulated command failed before mutation")
        if op == "create":
            if args[0] in self.fw["chains"]:
                raise OSError("chain collision")
            self.fw["chains"][args[0]] = []
        elif op == "append":
            self.fw["chains"][args[0]].append(list(args[1]))
        elif op == "jump":
            # Assertion inside the double guards the ordering, not implementation.
            assert self.fw["chains"][args[0]][-1][-1] == "DROP"
            self.fw["chains"]["INPUT"].insert(0, list(args[1]))
        elif op == "policy":
            self.fw["policies"][args[0]] = args[1]
        elif op == "delete_jump":
            self.fw["chains"]["INPUT"].remove(list(args[1]))
        elif op == "flush":
            self.fw["chains"][args[0]] = []
        elif op == "delete_chain":
            del self.fw["chains"][args[0]]
        else:
            raise AssertionError("unexpected mutation " + op)
        if fail and self.after:
            self.fail = None
            raise OSError("simulated lost acknowledgement after mutation")


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(hasattr(guard, "Controller"), "transaction controller is missing")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "private"
        self.backend = FakeLinux()
        self.controller = guard.Controller(self.root, self.backend)
        self.run_id = "0123456789abcdefabcd"

    def prepare(self):
        return self.controller.prepare(self.run_id, 600)

    def evidence(self, state, kind):
        directory = self.root / state["run_id"]
        document = {"schema": 1, "kind": kind, "source": "operator-observed",
                    "run_id": state["run_id"], "manifest_sha256": state["manifest_sha256"],
                    "boot_id": self.backend.boot, "operator": "SIMULATION ONLY", "authorization_ref": "SIMULATED-NOT-AUTHORIZATION",
                    "observed_monotonic_ns": self.backend.monotonic_ns(), "expires_monotonic_ns": self.backend.now + 200_000_000_000,
                    "persistence_mode": "unchanged-active-only", "original_session": "connection-A", "second_session": "connection-B",
                    "second_session_opened_monotonic_ns": self.backend.now,
                    "checks": {}}
        names = guard.PREFLIGHT_CHECKS if kind == "preflight" else guard.POST_CHECKS
        for name in names:
            path = directory / (kind + "-" + name + ".evidence")
            data = ("SIMULATED operator evidence: " + name).encode()
            path.write_bytes(data)
            path.chmod(0o600)
            document["checks"][name] = {"outcome": "pass", "file": path.name, "sha256": hashlib.sha256(data).hexdigest()}
        path = directory / (kind + ".json")
        path.write_text(json.dumps(document), encoding="utf-8")
        path.chmod(0o600)
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def apply(self):
        state = self.prepare()
        return self.controller.apply(self.run_id, *self.evidence(state, "preflight"))

    def confirm(self, state):
        self.assertTrue(hasattr(self.controller, "confirm"), "confirmation handshake is missing")
        return self.controller.confirm(self.run_id, *self.evidence(state, "post"), wait_seconds=2)

    def start_timer_worker(self, state, start_us=None):
        self.backend.service.update(active="activating", sub="start", start_us=start_us or self.backend.monotonic_ns() // 1000)
        entered = threading.Event()
        self.worker_errors = []
        original = self.controller._record_timer_start
        def record(run_id):
            result = original(run_id)
            entered.set()
            return result
        self.controller._record_timer_start = record
        def worker():
            try:
                self.controller.rollback(self.run_id, trigger="timer")
                self.backend.service.update(active="inactive", sub="dead", result="success", status=0)
            except BaseException as exc:
                self.worker_errors.append(exc)
                self.backend.service.update(active="failed", sub="failed", result="exit-code", status=1)
        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        self.assertTrue(entered.wait(1), "worker must register start BEFORE waiting for the operation lock")
        self.worker = thread

    def test_confirm_requires_valid_post_change_evidence(self):
        state = self.apply()
        result = self.confirm(state)
        self.assertEqual(result["phase"], "confirmed")
        self.assertGreater(result["confirmed_monotonic_ns"], state["applied_monotonic_ns"])
        self.assertEqual(self.backend.timer["active"], "inactive")
        self.assertEqual(self.backend.fw["policies"]["INPUT"], "DROP")

    def test_timer_started_during_stop_releases_lock_and_never_confirms(self):
        state = self.apply()
        self.assertTrue(hasattr(self.controller, "confirm"), "confirmation handshake is missing")
        self.backend.on_stop = lambda: self.start_timer_worker(state)
        with self.assertRaisesRegex(guard.GuardError, "confirmation refused"):
            self.confirm(state)
        self.worker.join(2)
        self.assertFalse(self.worker.is_alive(), "confirm must release lock for rollback")
        self.assertEqual(self.worker_errors, [])
        self.assertEqual(self.controller.store.read(self.run_id)["phase"], "rolled_back")
        self.assertEqual(self.backend.fw["policies"]["INPUT"], "ACCEPT")

    def test_activation_between_marker_and_final_readback_is_rejected(self):
        state = self.apply()
        self.assertTrue(hasattr(self.controller, "confirm"), "confirmation handshake is missing")
        save = self.controller.store.save
        fired = []
        def racing_save(current):
            save(current)
            if current["phase"] == "confirmed" and not fired:
                fired.append(True)
                self.start_timer_worker(state, current["confirmed_monotonic_ns"] // 1000 - 1)
        self.controller.store.save = racing_save
        with self.assertRaisesRegex(guard.GuardError, "confirmation refused"):
            self.confirm(state)
        self.worker.join(2)
        self.assertFalse(self.worker.is_alive())
        self.assertEqual(self.controller.store.read(self.run_id)["phase"], "rolled_back")

    def test_timer_started_strictly_after_confirmation_is_noop(self):
        state = self.apply()
        confirmed = self.confirm(state)
        before = self.backend.snapshot()
        self.start_timer_worker(confirmed)
        self.worker.join(2)
        self.assertEqual(self.worker_errors, [])
        self.assertEqual(self.backend.snapshot(), before)
        latest = self.controller.store.read(self.run_id)
        self.assertEqual(latest["phase"], "confirmed")
        self.assertTrue(latest["late_timer_noop"])

    def test_persistence_read_failure_prevents_prepare(self):
        self.backend.persistence_error = True
        with self.assertRaises(OSError):
            self.prepare()
        self.assertEqual(self.backend.events, [])

    def test_persistence_failure_during_confirm_recovers_active_not_files(self):
        state = self.apply()
        before_files = dict(self.backend.files)
        self.backend.persistence_error = True
        self.assertTrue(hasattr(self.controller, "confirm"), "confirmation handshake is missing")
        with self.assertRaisesRegex(guard.GuardError, "confirmation refused"):
            self.confirm(state)
        self.assertEqual(self.backend.fw["policies"]["INPUT"], "ACCEPT")
        self.assertNotIn(state["chain"], self.backend.fw["chains"])
        self.assertEqual(self.backend.files, before_files)
        self.assertEqual(self.controller.store.read(self.run_id)["phase"], "rollback_incomplete")

    def test_failure_before_drop_recovers_owned_chain(self):
        before = self.backend.snapshot()
        self.backend.fail = lambda event: event[0] == "append" and event[2][-1] == "DROP"
        with self.assertRaises(Exception):
            self.apply()
        self.assertEqual(self.backend.snapshot(), before)
        self.assertEqual(self.controller.store.read(self.run_id)["phase"], "rolled_back")

    def test_lost_ack_after_policy_drop_restores_intended_policies(self):
        before = self.backend.snapshot()
        self.backend.fail = lambda event: event[:3] == ("policy", "FORWARD", "DROP")
        self.backend.after = True
        with self.assertRaises(Exception):
            self.apply()
        self.assertEqual(self.backend.snapshot(), before)
        events = self.backend.events
        removal = next(i for i, e in enumerate(events) if e[0] == "delete_jump")
        for chain in ("INPUT", "FORWARD"):
            self.assertLess(events.index(("policy", chain, "ACCEPT")), removal)
        state = self.controller.store.read(self.run_id)
        uncertain = [item for item in state["actions"] if item["op"] == "policy" and item["args"][0] == "FORWARD"]
        self.assertTrue(uncertain[0]["intent"])
        self.assertFalse(uncertain[0]["applied"])

    def test_rollback_repeats_without_unowned_mutations(self):
        before = self.backend.snapshot()
        self.apply()
        self.assertTrue(hasattr(self.controller, "rollback"), "rollback is missing")
        self.controller.rollback(self.run_id)
        self.controller.rollback(self.run_id)
        self.assertEqual(self.backend.snapshot(), before)
        self.assertEqual(self.controller.store.read(self.run_id)["phase"], "rolled_back")

    def test_failed_policy_restore_still_restores_other_policy_but_keeps_jump(self):
        self.apply()
        self.backend.fail = lambda event: event[:3] == ("policy", "INPUT", "ACCEPT")
        self.assertTrue(hasattr(self.controller, "rollback"), "rollback is missing")
        with self.assertRaises(guard.GuardError):
            self.controller.rollback(self.run_id)
        self.assertEqual(self.backend.fw["policies"]["FORWARD"], "ACCEPT")
        self.assertTrue(self.backend.fw["chains"]["INPUT"])
        self.assertNotIn(("stop_timer",), self.backend.events)
        self.assertEqual(self.backend.timer["active"], "active", "failed policy restoration must retain pending fallback")
        self.controller.rollback(self.run_id)
        self.assertEqual(self.backend.fw["policies"]["INPUT"], "ACCEPT")

    def test_chain_collision_is_not_adopted_or_deleted(self):
        self.backend.fw["chains"][guard.chain_name(self.run_id)] = [["-j", "RETURN"]]
        before = self.backend.snapshot()
        with self.assertRaisesRegex(guard.GuardError, "collision"):
            self.prepare()
        self.assertEqual(self.backend.snapshot(), before)
        self.assertEqual(self.backend.events, [])

    def test_receipt_and_journal_disk_failure_cannot_suppress_active_recovery(self):
        before = self.backend.snapshot()
        self.apply()
        self.backend.service.update(active="activating", sub="start", start_us=self.backend.monotonic_ns() // 1000)
        with patch.object(self.controller, "_record_timer_start", side_effect=OSError("simulated ENOSPC receipt")), \
             patch.object(self.controller.store, "save", side_effect=OSError("simulated ENOSPC journal")):
            with self.assertRaises(Exception):
                self.controller.rollback(self.run_id, trigger="timer")
        self.assertEqual(self.backend.snapshot(), before, "disk failure must not skip safe policy restoration")
        self.assertIn(("stop_timer",), self.backend.events)

    def test_failed_receipt_never_allows_late_timer_noop(self):
        state = self.apply()
        self.confirm(state)
        self.backend.service.update(active="activating", sub="start", start_us=self.backend.monotonic_ns() // 1000)
        with patch.object(self.controller, "_record_timer_start", side_effect=OSError("simulated receipt failure")):
            with self.assertRaises(guard.GuardError):
                self.controller.rollback(self.run_id, trigger="timer")
        self.assertEqual(self.backend.fw["policies"]["INPUT"], "ACCEPT")
        self.assertEqual(self.controller.store.read(self.run_id)["phase"], "rollback_incomplete")

    def test_identical_unit_collision_after_prepare_is_not_stopped_or_adopted(self):
        state = self.prepare()
        evidence = self.evidence(state, "preflight")
        unit_dir = self.root / "simulated-systemd"
        unit_dir.mkdir(mode=0o700)
        timer = guard.unit_names(self.run_id)[1]
        guard.private_write(unit_dir / timer, guard.private_read(self.root / self.run_id / timer))
        calls = []
        def runner(argv):
            calls.append(argv)
            if argv[1] == "show":
                path = unit_dir / argv[2]
                return "LoadState=loaded\nFragmentPath=" + str(path) + "\n" if path.exists() else "LoadState=not-found\n"
            return ""
        adapter = guard.LinuxAdapter(runner=runner)
        adapter.UNIT_DIR = unit_dir
        self.backend.arm = adapter.arm
        self.backend.stop_timer = adapter.stop_timer
        with self.assertRaises(guard.GuardError):
            self.controller.apply(self.run_id, *evidence)
        self.assertEqual([c for c in calls if c[1] in ("start", "stop")], [], "matching bytes are not acquisition evidence")
        self.assertEqual(self.controller.store.read(self.run_id)["actions"], [])
        self.assertTrue((unit_dir / timer).exists())

    def test_failure_after_jump_before_policy_drop_recovers(self):
        before = self.backend.snapshot()
        self.backend.fail = lambda event: event[:3] == ("policy", "INPUT", "DROP")
        with self.assertRaises(guard.GuardError):
            self.apply()
        self.assertTrue(any(event[0] == "jump" for event in self.backend.events))
        self.assertEqual(self.backend.snapshot(), before)

    def test_old_second_connection_cannot_confirm(self):
        state = self.apply()
        path, _ = self.evidence(state, "post")
        proof = json.loads(path.read_bytes())
        proof["second_session_opened_monotonic_ns"] = state["prepared_monotonic_ns"]
        guard.private_write(path, guard.encoded(proof))
        with self.assertRaisesRegex(guard.GuardError, "confirmation refused"):
            self.controller.confirm(self.run_id, path, guard.digest(path.read_bytes()))
        self.assertEqual(self.backend.fw["policies"]["INPUT"], "ACCEPT")

    def test_deactivating_service_is_waited_not_stopped_or_confirmed(self):
        state = self.apply()
        self.backend.service.update(active="deactivating", sub="stop", start_us=self.backend.monotonic_ns() // 1000)
        with self.assertRaisesRegex(guard.GuardError, "confirmation refused"):
            self.controller.confirm(self.run_id, *self.evidence(state, "post"), wait_seconds=0)
        self.assertEqual(self.controller.store.read(self.run_id)["phase"], "rollback_required")
        self.assertNotIn(("stop_timer",), self.backend.events)
        self.backend.service.update(active="inactive", sub="dead")
        self.controller.rollback(self.run_id)

    def test_immutable_manifest_binds_run_parameters_for_external_copy(self):
        state = self.prepare()
        manifest = json.loads((self.root / self.run_id / "manifest.json").read_bytes())
        for field in ("chain", "tag", "window_seconds", "prepared_monotonic_ns"):
            self.assertIn(field, manifest, "recovery parameter missing from external-copy manifest")
            self.assertEqual(manifest[field], state[field])

    def test_absent_persistence_becoming_present_blocks_apply(self):
        self.backend.files["rules.v6"] = None
        state = self.prepare()
        backup = json.loads((self.root / self.run_id / "persistence.before.json").read_bytes())
        self.assertIsNone(backup["rules.v6"])
        self.backend.files["rules.v6"] = b"external file appeared"
        with self.assertRaisesRegex(guard.GuardError, "persistence drift"):
            self.controller.apply(self.run_id, *self.evidence(state, "preflight"))
        self.assertEqual(self.backend.events, [])

    def test_service_failed_is_not_success_even_if_timer_stopped(self):
        state = self.apply()
        self.backend.service.update(active="failed", sub="failed", result="exit-code", status=1, start_us=7)
        with self.assertRaisesRegex(guard.GuardError, "confirmation refused"):
            self.controller.confirm(self.run_id, *self.evidence(state, "post"), wait_seconds=0)
        self.assertNotEqual(self.controller.store.read(self.run_id)["phase"], "confirmed")
        self.assertEqual(self.backend.fw["policies"]["INPUT"], "ACCEPT")

    def test_expired_monotonic_timer_prevents_first_firewall_mutation(self):
        arm = self.backend.arm
        def expired(state, directory, record):
            arm(state, directory, record)
            self.backend.timer["next_us"] = self.backend.now // 1000 - 1
        self.backend.arm = expired
        with self.assertRaises(guard.GuardError):
            self.apply()
        self.assertFalse(any(e[0] == "create" for e in self.backend.events))

    def test_adapter_arms_only_owned_nonpersistent_timer(self):
        state = self.prepare()
        directory = self.root / self.run_id
        unit_dir = self.root / "simulated-systemd"
        unit_dir.mkdir(mode=0o700)
        calls = []
        def runner(argv):
            calls.append(argv)
            if argv[1] == "show":
                path = unit_dir / argv[2]
                return "LoadState=loaded\nFragmentPath=" + str(path) + "\n" if path.exists() else "LoadState=not-found\n"
            return ""
        adapter = guard.LinuxAdapter(runner=runner)
        adapter.UNIT_DIR = unit_dir
        record = lambda name, event: self.controller._unit_event(state, name, event)
        adapter.arm(state, directory, record)
        adapter.stop_timer(state)
        self.assertEqual([c[2] for c in calls if c[1] in ("start", "stop")], [guard.unit_names(self.run_id)[1]] * 2)
        self.assertTrue(all("enable" not in c and "--no-block" not in c for c in calls))
        with self.assertRaisesRegex(guard.GuardError, "collision"):
            adapter.arm(state, directory, record)

    def test_tampered_journal_policy_is_rejected_before_rollback(self):
        self.apply()
        state = self.controller.store.read(self.run_id)
        state["before"]["policies"]["INPUT"] = "DROP"
        self.controller.store.save(state)
        before = self.backend.snapshot()
        with self.assertRaisesRegex(guard.GuardError, "immutable"):
            self.controller.rollback(self.run_id)
        self.assertEqual(self.backend.snapshot(), before)

    def test_staged_unit_corruption_prevents_any_application(self):
        state = self.prepare()
        name = guard.unit_names(self.run_id)[0]
        (self.root / self.run_id / name).write_text("corrupt", encoding="utf-8")
        with self.assertRaisesRegex(guard.GuardError, "unit"):
            self.controller.apply(self.run_id, *self.evidence(state, "preflight"))
        self.assertEqual(self.backend.events, [])

    def test_old_manual_rollback_cannot_clobber_newer_run(self):
        self.apply()
        self.controller.rollback(self.run_id)
        old_id = self.run_id
        self.run_id = "fedcba9876543210abcd"
        self.apply()
        before = self.backend.snapshot()
        with self.assertRaisesRegex(guard.GuardError, "newer"):
            self.controller.rollback(old_id)
        self.assertEqual(self.backend.snapshot(), before)

    def test_queued_job_with_no_start_timestamp_is_never_confirmation(self):
        state = self.apply()
        self.backend.on_stop = lambda: self.backend.jobs.append(["42", guard.unit_names(self.run_id)[0], "start", "waiting"])
        with self.assertRaisesRegex(guard.GuardError, "confirmation refused"):
            self.controller.confirm(self.run_id, *self.evidence(state, "post"), wait_seconds=0)
        self.assertEqual(self.controller.store.read(self.run_id)["phase"], "rollback_required")
        self.backend.jobs = []
        self.controller.rollback(self.run_id)

    def test_backup_corruption_prevents_application(self):
        state = self.prepare()
        (self.root / self.run_id / "persistence.before.json").write_bytes(b"corrupted")
        with self.assertRaisesRegex(guard.GuardError, "backup"):
            self.controller.apply(self.run_id, *self.evidence(state, "preflight"))
        self.assertEqual(self.backend.events, [])

    def test_ambiguous_empty_chain_after_lost_create_ack_is_preserved(self):
        self.backend.fail = lambda event: event[0] == "create"
        self.backend.after = True
        with self.assertRaisesRegex(guard.GuardError, "INCOMPLETE"):
            self.apply()
        self.assertEqual(self.backend.fw["policies"]["INPUT"], "ACCEPT")
        self.assertIn(guard.chain_name(self.run_id), self.backend.fw["chains"])
        self.assertEqual(self.controller.store.read(self.run_id)["phase"], "rollback_incomplete")

    def test_failed_jump_removal_keeps_chain_and_retry_succeeds(self):
        state = self.apply()
        self.backend.fail = lambda event: event[0] == "delete_jump"
        with self.assertRaisesRegex(guard.GuardError, "incomplete"):
            self.controller.rollback(self.run_id)
        self.assertEqual(self.backend.fw["policies"]["INPUT"], "ACCEPT")
        self.assertIn(state["chain"], self.backend.fw["chains"])
        self.assertEqual(self.backend.timer["active"], "active", "pending fallback must survive failed jump detachment")
        self.assertNotIn(("stop_timer",), self.backend.events)
        self.controller.rollback(self.run_id)
        self.assertNotIn(state["chain"], self.backend.fw["chains"])
        self.assertEqual(self.backend.timer["active"], "inactive")

    def test_corrupt_evidence_causes_recovery_instead_of_confirmation(self):
        state = self.apply()
        path, sha = self.evidence(state, "post")
        (path.parent / "post-second_ssh.evidence").write_bytes(b"tampered")
        with self.assertRaisesRegex(guard.GuardError, "confirmation refused"):
            self.controller.confirm(self.run_id, path, sha)
        self.assertEqual(self.backend.fw["policies"]["INPUT"], "ACCEPT")

    def test_prepared_bundle_contains_script_units_and_before_data(self):
        state = self.prepare()
        directory = self.root / self.run_id
        for name in guard.unit_names(self.run_id):
            self.assertTrue((directory / name).is_file(), "prepared rollback unit missing")
            self.assertEqual(guard.digest((directory / name).read_bytes()), state["unit_sha256"][name])
        self.assertEqual(state["before"], self.backend.snapshot())

    def test_success_builds_whole_chain_before_jump_and_drop(self):
        before = self.backend.snapshot()
        state = self.apply()
        self.assertEqual(state["phase"], "applied")
        self.assertEqual(state["persistence_mode"], "unchanged-active-only")
        self.assertEqual(self.backend.fw["policies"]["INPUT"], "DROP")
        self.assertEqual(self.backend.fw["policies"]["FORWARD"], "DROP")
        self.assertEqual(self.backend.fw["policies"]["OUTPUT"], "ACCEPT")
        self.assertEqual(self.backend.fw["chains"]["FORWARD"], before["chains"]["FORWARD"])
        self.assertEqual(self.backend.events[0], ("arm",))
        actions = state["actions"]
        self.assertTrue(all(item["intent"] and item["applied"] for item in actions))
        self.assertEqual(state["before"]["policies"], before["policies"])
        self.assertTrue((self.root / self.run_id / "manifest.json").is_file())


class LockTests(unittest.TestCase):
    def test_shared_lock_wait_has_a_bounded_timeout(self):
        import inspect
        self.assertIn("timeout", inspect.signature(guard.Store.lock).parameters, "bounded lock acquisition is missing")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "private"
            first, second = guard.Store(root), guard.Store(root)
            held, release = threading.Event(), threading.Event()
            def holder():
                with first.lock():
                    held.set()
                    release.wait(2)
            worker = threading.Thread(target=holder)
            worker.start()
            try:
                self.assertTrue(held.wait(1))
                with self.assertRaisesRegex(guard.GuardError, "lock"):
                    with second.lock(timeout=0.02):
                        self.fail("concurrent operation entered the shared lock")
            finally:
                release.set()
                worker.join(2)
            self.assertFalse(worker.is_alive())


class AdapterTests(unittest.TestCase):
    def test_oci_gate_uses_existing_codex_relay_not_repeated_panel_inspection(self):
        self.assertIn("oci_codex_relay_reviewed", guard.PREFLIGHT_CHECKS)
        self.assertNotIn("oci_readback", guard.PREFLIGHT_CHECKS)
        self.assertFalse(any("oci" in check for check in guard.POST_CHECKS))

    def test_job_empty_and_queued_are_distinct_from_missing_or_invalid(self):
        self.assertEqual(guard.parse_unit_job({"Job": ""}), 0)
        self.assertEqual(guard.parse_unit_job({"Job": "42"}), 42)
        self.assertEqual(guard.parse_unit_job({"Job": "42 /org/freedesktop/systemd1/job/42"}), 42)
        for properties in ({}, {"Job": "unknown"}):
            with self.subTest(properties=properties), self.assertRaises(guard.GuardError):
                guard.parse_unit_job(properties)

    def test_stop_rejects_loaded_fragment_different_from_owned_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rid = "0123456789abcdefabcd"
            timer = guard.unit_names(rid)[1]
            guard.private_write(root / timer, b"simulated unit")
            calls = []
            def runner(argv):
                calls.append(argv)
                return "LoadState=loaded\nFragmentPath=/different/foreign.timer\n"
            adapter = guard.LinuxAdapter(runner=runner)
            adapter.UNIT_DIR = root
            state = {"run_id": rid, "units": {timer: {"acquired": True, "installed": True}},
                     "unit_sha256": {timer: guard.digest(b"simulated unit")}}
            with self.assertRaisesRegex(guard.GuardError, "fragment"):
                adapter.stop_timer(state)
            self.assertFalse(any("stop" in c for c in calls))

    def test_absent_timer_can_be_verified_without_loading_service(self):
        self.assertTrue(hasattr(guard.LinuxAdapter, "timer_stopped"), "absent-timer readback is missing")
        calls = []
        def runner(argv):
            calls.append(argv)
            if argv[1] == "show":
                return "LoadState=not-found\n"
            if argv[1] == "list-jobs":
                return ""
            raise AssertionError(argv)
        adapter = guard.LinuxAdapter(runner=runner)
        self.assertTrue(adapter.timer_stopped({"run_id": "0123456789abcdefabcd"}))
        self.assertFalse(any("stop" in c or "start" in c for c in calls))

    def test_adapter_reads_raw_dbus_monotonic_not_human_duration(self):
        self.assertTrue(hasattr(guard, "LinuxAdapter"), "Linux adapter is missing")
        calls = []
        rid = "0123456789abcdefabcd"
        def runner(argv):
            calls.append(argv)
            if "show" in argv:
                unit = argv[2]
                if unit.endswith(".timer"):
                    return "LoadState=loaded\nActiveState=active\nSubState=waiting\nJob=\nNextElapseUSecMonotonic=1h 2min\n"
                return "LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\nExecMainStatus=0\nExecMainStartTimestampMonotonic=0\nJob=\n"
            if "list-jobs" in argv:
                return "99 unrelated.service start running\n"
            if "GetUnit" in argv:
                return 'o "/org/freedesktop/systemd1/unit/test"\n'
            if argv[-1] == "NextElapseUSecMonotonic":
                return "t 9000000000\n"
            if argv[-1] == "ExecMainStartTimestampMonotonic":
                return "t 0\n"
            raise AssertionError(argv)
        adapter = guard.LinuxAdapter(runner=runner)
        observed = adapter.observe({"run_id": rid})
        self.assertEqual(observed["timer"]["next_us"], 9000000000)
        self.assertEqual(observed["service"]["start_us"], 0)
        self.assertEqual(observed["jobs"], [])
        self.assertTrue(all("--all" in call for call in calls if "show" in call))
        self.assertTrue(any("busctl" in str(call[0]) for call in calls))
        with self.assertRaises(guard.GuardError):
            guard.parse_dbus_usec("t 1h 2min")
        self.assertEqual(guard.parse_dbus_usec("t 18446744073709551615", allow_infinity=True), 0)

    def test_adapter_scopes_mutations_and_parses_kernel_readback(self):
        self.assertTrue(hasattr(guard, "LinuxAdapter"), "Linux adapter is missing")
        calls = []
        def runner(argv):
            calls.append(argv)
            return '-P INPUT ACCEPT\n-P FORWARD DROP\n-P OUTPUT ACCEPT\n-N DOCKER-USER\n-A FORWARD -j DOCKER-USER\n-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT\n'
        adapter = guard.LinuxAdapter(runner=runner)
        snapshot = adapter.snapshot()
        self.assertEqual(snapshot["policies"]["FORWARD"], "DROP")
        self.assertIn("ESTABLISHED,RELATED", snapshot["chains"]["DOCKER-USER"][0])
        adapter.mutate("policy", "INPUT", "DROP")
        with self.assertRaises(guard.GuardError):
            adapter.mutate("policy", "OUTPUT", "DROP")
        with self.assertRaises(guard.GuardError):
            adapter.mutate("flush", "DOCKER-USER")
        self.assertEqual(len(calls), 2)
        self.assertIn("/usr/sbin/ip6tables", calls[0])

    def test_units_use_nonpersistent_monotonic_timer_and_same_script(self):
        self.assertTrue(hasattr(guard, "render_units"), "unit rendering is missing")
        service, timer = guard.render_units("0123456789abcdefabcd", "/var/lib/stk-ipv6", 600)
        self.assertIn("OnActiveSec=600s", timer)
        self.assertIn("WakeSystem=false", timer)
        self.assertIn("Persistent=false", timer)
        self.assertNotIn("[Install]", timer)
        self.assertIn("rollback --trigger timer", service)
        self.assertIn("/ipv6_guard.py", service)
        self.assertNotIn("systemctl stop", service)
        self.assertIn("TimeoutStartSec=infinity", service)

    def test_script_entrypoint_runs_offline_plan(self):
        import io
        import runpy
        with patch.object(sys, "argv", ["ipv6_guard.py", "plan"]), patch("sys.stdout", new_callable=io.StringIO) as out:
            with self.assertRaises(SystemExit) as exit_status:
                runpy.run_path(str(Path(guard.__file__)), run_name="__main__")
        self.assertEqual(exit_status.exception.code, 0)
        self.assertEqual(json.loads(out.getvalue())["mode"], "offline-review-only")

    def test_host_gate_uses_trusted_os_release_target(self):
        seen = []
        def reader(path):
            seen.append(path)
            if path == "/usr/lib/os-release":
                return b'ID=ubuntu\nVERSION_ID="24.04"\n'
            raise AssertionError("must not follow the /etc/os-release symlink")
        adapter = guard.LinuxAdapter(runner=lambda argv: "ip6tables v1.8.10 (nf_tables)\n", file_reader=reader)
        with patch.object(guard.platform, "machine", return_value="aarch64"):
            adapter.validate_host()
        self.assertEqual(seen, ["/usr/lib/os-release"])

    def test_missing_persistence_rules_are_recorded_as_absent(self):
        def reader(path):
            if path in ("/etc/iptables/rules.v4", "/etc/iptables/rules.v6", "/etc/default/iptables"):
                raise FileNotFoundError(path)
            return b"simulated installed persistence configuration/plugin"
        adapter = guard.LinuxAdapter(runner=lambda argv: "", file_reader=reader)
        files = adapter.persistence_files()
        self.assertIsNone(files["/etc/iptables/rules.v4"])
        self.assertIsNone(files["/etc/iptables/rules.v6"])
        self.assertIsNone(files["/etc/default/iptables"])

    def test_offline_cli_never_constructs_live_adapter(self):
        self.assertTrue(hasattr(guard, "main"), "CLI is missing")
        import io
        with patch.object(guard, "LinuxAdapter", side_effect=AssertionError("LIVE ADAPTER FORBIDDEN")), patch("sys.stdout", new_callable=io.StringIO) as out:
            self.assertEqual(guard.main(["plan"]), 0)
        document = json.loads(out.getvalue())
        self.assertEqual(document["persistence_mode"], "unchanged-active-only")
        self.assertEqual(document["mode"], "offline-review-only")
        self.assertNotIn("before", document)


if __name__ == "__main__":
    unittest.main(verbosity=2)
