"""Opt-in controller integration: real systemd, file-backed SIMULATED firewall.

Run ONLY inside a disposable Docker container, with systemd as PID 1:
  STK_DISPOSABLE_SYSTEMD=1 python3 -B integration_systemd.py --disposable
No iptables/ip6tables, networking, production state or production CLI is used.
The worker runs this fixture too; it never runs the production firewall adapter.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest

import ipv6_guard as guard


def require_disposable():
    if (sys.platform != "linux" or os.geteuid() != 0
            or os.environ.get("STK_DISPOSABLE_SYSTEMD") != "1"
            or Path("/proc/1/comm").read_text().strip() != "systemd"
            or not Path("/.dockerenv").is_file()):
        raise RuntimeError("This fixture requires explicit opt-in inside disposable Docker/systemd")


def run_systemctl(*arguments):
    result = subprocess.run(["/usr/bin/systemctl", *arguments], capture_output=True, text=True,
                            timeout=15, check=True)
    return result.stdout


def wait_for(predicate, timeout=10):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("disposable fixture wait timed out")
        time.sleep(0.02)


class IsolatedAdapter(guard.LinuxAdapter):
    """Real production systemd adapter; all firewall/persistence calls replaced."""
    IP6 = "/DO-NOT-EXECUTE-A-FIREWALL-IN-THIS-TEST"

    def __init__(self, root):
        super().__init__(execute_reviewed=True)
        self.root = Path(root)
        if not str(self.root).startswith("/tmp/stk-systemd-integration-"):
            raise RuntimeError("fixture state must be in its disposable /tmp directory")
        if guard.private_read(self.root / "fixture.marker") != b"SIMULATED FIREWALL ONLY\n":
            raise RuntimeError("missing isolated fixture marker")

    def _call(self, argv, ok=(0,)):
        if argv[0] not in (self.SYSTEMCTL, self.BUSCTL):
            raise AssertionError("no real firewall/system commands outside systemd")
        if "stop" in argv and not argv[-1].endswith(".timer"):
            raise AssertionError("the rollback service must never be stopped")
        return super()._call(argv, ok=ok)

    def snapshot(self):
        return json.loads(guard.private_read(self.root / "simulated-kernel.json"))

    def persistence_files(self):
        return {"simulated-only": b"unchanged simulated persistence"}

    def mutate(self, op, *args):
        snapshot = self.snapshot()
        chains = snapshot["chains"]
        if op == "policy":
            assert args[0] in ("INPUT", "FORWARD")
            snapshot["policies"][args[0]] = args[1]
        elif op == "create":
            assert args[0] not in chains
            chains[args[0]] = []
        elif op == "append":
            chains[args[0]].append(args[1])
        elif op == "jump":
            chains["INPUT"].insert(0, args[1])
        elif op == "delete_jump":
            chains["INPUT"].remove(args[1])
        elif op == "delete_rule":
            chains[args[0]].remove(args[1])
        elif op == "delete_chain":
            assert not chains[args[0]]
            assert not any(args[0] in rule for rules in chains.values() for rule in rules)
            del chains[args[0]]
        else:
            raise AssertionError("unexpected simulated mutation")
        guard.private_write(self.root / "simulated-kernel.json", guard.encoded(snapshot))


class SystemdControllerIntegration(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="stk-systemd-integration-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        guard.private_write(self.root / "fixture.marker", b"SIMULATED FIREWALL ONLY\n")
        self.before = {"policies": {"INPUT": "ACCEPT", "FORWARD": "ACCEPT", "OUTPUT": "ACCEPT"},
                       "chains": {"INPUT": [], "FORWARD": [["-j", "DOCKER-USER"]],
                                  "OUTPUT": [], "DOCKER-USER": [["-j", "RETURN"]]}}
        guard.private_write(self.root / "simulated-kernel.json", guard.encoded(self.before))
        self.backend = IsolatedAdapter(self.root)
        self.controller = guard.Controller(self.root, self.backend)
        self.run_id = guard.new_run_id()
        self.names = guard.unit_names(self.run_id)
        original = guard.render_units

        def fixture_units(run_id, root, seconds):
            service, timer = original(run_id, root, seconds)
            # Only ExecStart is replaced: the worker uses the real Controller
            # and same lock/journal, but IsolatedAdapter for the simulated kernel.
            command = "ExecStart=/usr/bin/python3 -B " + str(Path(__file__).resolve()) + " --worker " + str(root) + " " + run_id
            service = re.sub(r"(?m)^ExecStart=.*$", command, service)
            service += "Environment=STK_DISPOSABLE_SYSTEMD=1\n"
            return service, timer

        guard.render_units = fixture_units
        try:
            self.state = self.controller.prepare(self.run_id, 600)
        finally:
            guard.render_units = original
        self.addCleanup(self.clean_units)

    def clean_units(self):
        # Only this test's two exclusive names/files; never stop the service.
        if not any((self.backend.UNIT_DIR / name).exists() for name in self.names):
            return
        if (self.backend.UNIT_DIR / self.names[1]).exists():
            run_systemctl("stop", self.names[1])
        wait_for(lambda: run_systemctl("show", self.names[0], "--property=ActiveState", "--value").strip()
                 not in ("active", "activating", "deactivating", "reloading"))
        for name in self.names:
            path = self.backend.UNIT_DIR / name
            if path.exists():
                self.assertEqual(guard.digest(guard.private_read(path)), self.state["unit_sha256"][name])
                path.unlink()
        run_systemctl("daemon-reload")

    def evidence(self, kind):
        state = self.controller.store.read(self.run_id)
        names = guard.PREFLIGHT_CHECKS if kind == "preflight" else guard.POST_CHECKS
        now = self.backend.monotonic_ns()
        document = {"schema": 1, "kind": kind, "source": "operator-observed", "run_id": self.run_id,
                    "manifest_sha256": state["manifest_sha256"], "boot_id": state["boot_id"],
                    "operator": "DISPOSABLE SIMULATION", "authorization_ref": "TEST ONLY, NOT VPS AUTHORIZATION",
                    "observed_monotonic_ns": now, "expires_monotonic_ns": now + 120_000_000_000,
                    "persistence_mode": guard.PERSISTENCE_MODE, "original_session": "synthetic-A",
                    "second_session": "synthetic-B", "second_session_opened_monotonic_ns": now, "checks": {}}
        for name in names:
            data = b"SIMULATED operator evidence; NOT a real network probe\n"
            path = self.root / (kind + "-" + name + ".txt")
            guard.private_write(path, data)
            document["checks"][name] = {"outcome": "pass", "file": path.name, "sha256": guard.digest(data)}
        path = self.root / (kind + ".json")
        raw = guard.encoded(document)
        guard.private_write(path, raw)
        return path, guard.digest(raw)

    def apply(self):
        return self.controller.apply(self.run_id, *self.evidence("preflight"))

    def confirm(self):
        return self.controller.confirm(self.run_id, *self.evidence("post"), wait_seconds=15)

    def start_worker(self):
        run_systemctl("start", "--no-block", self.names[0])
        wait_for(lambda: (self.root / self.run_id / "rollback-started.json").exists())

    def assert_rolled_back(self):
        self.assertEqual(self.controller.store.read(self.run_id)["phase"], "rolled_back")
        self.assertEqual(self.backend.snapshot(), self.before)
        self.assertTrue(self.backend.timer_stopped(self.state))

    def test_normal_confirm_and_references_released(self):
        self.apply()
        final = self.confirm()
        self.assertEqual(final["phase"], "confirmed")
        self.assertEqual(self.backend.snapshot()["policies"]["INPUT"], "DROP")
        self.assertEqual(final["confirmation_observations"]["after_stop"]["service"]["start_us"], 0)
        self.assertFalse((self.root / self.run_id / "rollback-started.json").exists())
        self.assertIsNone(self.backend.references)
        self.assertTrue(self.backend.timer_stopped(final))

        def collected():
            try:
                self.backend._usec(self.names[0], "Service", "ExecMainStartTimestampMonotonic")
                return False
            except guard.UnitNotLoaded:
                return True
        wait_for(collected)
        with self.assertRaises(guard.GuardError):
            self.backend.observe(final)  # An unreferenced, reloaded zero is unknown.

    def test_manual_rollback_stopped_timer_collected(self):
        self.apply()
        self.controller.rollback(self.run_id)
        self.assert_rolled_back()

    def test_real_worker_started_during_timer_stop(self):
        self.apply()
        original = self.backend.stop_timer
        fired = False

        def racing_stop(state):
            nonlocal fired
            if not fired:
                fired = True
                self.start_worker()
            original(state)
        self.backend.stop_timer = racing_stop
        with self.assertRaisesRegex(guard.GuardError, "confirmation refused; active rollback verified"):
            self.confirm()
        self.assert_rolled_back()

    def test_real_worker_races_confirmation_marker(self):
        self.apply()
        original = self.controller.store.save
        fired = False

        def racing_save(state):
            nonlocal fired
            original(state)
            if state["phase"] == "confirmed" and not fired:
                fired = True
                self.start_worker()
        self.controller.store.save = racing_save
        with self.assertRaisesRegex(guard.GuardError, "confirmation refused; active rollback verified"):
            self.confirm()
        self.assert_rolled_back()

    def test_lost_reference_refuses_confirm_and_recovers(self):
        self.apply()
        original = self.backend.stop_timer

        def lost_connection(state):
            original(state)
            self.backend.references.__exit__(None, None, None)
        self.backend.stop_timer = lost_connection
        with self.assertRaisesRegex(guard.GuardError, "confirmation refused; active rollback verified"):
            self.confirm()
        self.assert_rolled_back()


def main():
    require_disposable()
    if len(sys.argv) == 4 and sys.argv[1] == "--worker":
        root, run_id = sys.argv[2:]
        guard.Controller(root, IsolatedAdapter(root)).rollback(run_id, trigger="timer")
        return
    if sys.argv[1:] != ["--disposable"]:
        raise RuntimeError("explicit --disposable required")
    print("REAL SYSTEMD; FILE-BACKED SIMULATED FIREWALL; NO VPS", flush=True)
    print(run_systemctl("--version").splitlines()[0], flush=True)
    unittest.main(argv=[sys.argv[0]], verbosity=2)


if __name__ == "__main__":
    main()
