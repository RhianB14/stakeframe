"""STK-M0-03-R2: review-only IPv6 INPUT/FORWARD active-state guard.

No persistence writes, global restore, IPv4/OUTPUT edits or service stops.
Linux execution requires separate operational authorization; tests are simulations.
"""
import re
import secrets
import base64
import contextlib
import copy
import hashlib
import json
import os
from pathlib import Path
import stat
import time
import argparse
import platform
import shlex
import subprocess
import sys
from decimal import Decimal

PERSISTENCE_MODE = "unchanged-active-only"
PREFLIGHT_CHECKS = ("external_bundle_copy", "server_bundle_copy", "private_full_snapshot", "provider_recovery", "oci_codex_relay_reviewed", "original_ssh", "independent_ssh", "ipv6_matrix_approved", "persistence_readback")
POST_CHECKS = ("original_ssh", "second_ssh", "ipv6_input", "ipv6_forward", "routes_dns_ntp", "docker_fail2ban", "ipv4_output_unchanged", "persistence_readback")


class GuardError(RuntimeError):
    pass


class UnitNotLoaded(GuardError):
    """systemd reports the unit as not loaded (e.g. garbage-collected while
    quiescent). This is a definite state, not a transient fault: callers may
    treat it as "no pending elapse / never started" only where a fresh
    readback already established quiescence."""


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode("utf-8")


def private_read(path):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink():
        raise GuardError("expected regular private file")
    if os.name == "posix" and (info.st_uid != os.geteuid() or info.st_mode & 0o077):
        raise GuardError("private file must be owned by effective user and mode 0600")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    with os.fdopen(fd, "rb") as stream:
        return stream.read()


def private_write(path, data):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp-" + secrets.token_hex(6))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name == "posix":
            directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if temporary.exists():
            temporary.unlink()


class Store:
    def __init__(self, root):
        self.root = Path(root).absolute()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = self.root.lstat()
        if not stat.S_ISDIR(info.st_mode) or self.root.is_symlink():
            raise GuardError("state directory must not be a symlink")
        if os.name == "posix" and (info.st_uid != os.geteuid() or info.st_mode & 0o077):
            raise GuardError("state directory must be private, owned, mode 0700")

    def directory(self, run_id):
        chain_name(run_id)
        path = self.root / run_id
        if path.is_symlink():
            raise GuardError("run directory is a symlink")
        return path

    @contextlib.contextmanager
    def lock(self, timeout=None):
        # One lock for ALL runs and commands, not one independent lock per run.
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(self.root / "operation.lock", flags, 0o600)
        locked = False
        deadline = None if timeout is None else time.monotonic() + timeout
        try:
            if os.name != "posix" and os.fstat(fd).st_size == 0:
                os.write(fd, b"0")
            while not locked:
                try:
                    if os.name == "posix":
                        import fcntl
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    else:  # Nonprivileged Windows simulations only.
                        import msvcrt
                        os.lseek(fd, 0, os.SEEK_SET)
                        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                    locked = True
                except (BlockingIOError, PermissionError):
                    if deadline is not None and time.monotonic() >= deadline:
                        raise GuardError("operation lock busy; rollback may still be running")
                    time.sleep(0.01)
            yield
        finally:
            if locked:
                if os.name == "posix":
                    import fcntl
                    fcntl.flock(fd, fcntl.LOCK_UN)
                else:
                    import msvcrt
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            os.close(fd)

    def read(self, run_id):
        state = json.loads(private_read(self.directory(run_id) / "journal.json"))
        if state["run_id"] != run_id or state["chain"] != chain_name(run_id):
            raise GuardError("journal identity mismatch")
        raw = private_read(self.directory(run_id) / "manifest.json")
        manifest = json.loads(raw)
        if digest(raw) != state["manifest_sha256"] or any(state.get(key) != value for key, value in manifest.items()):
            raise GuardError("immutable journal/manifest mismatch")
        return state

    def save(self, state):
        private_write(self.directory(state["run_id"]) / "journal.json", encoded(state))


class Controller:
    def __init__(self, root, backend):
        self.store = Store(root)
        self.backend = backend

    def _persistence(self):
        files = self.backend.persistence_files()
        if not files:
            raise GuardError("persistence evidence missing")
        return {name: None if data is None else digest(data) for name, data in files.items()}, files

    def prepare(self, run_id, window_seconds=600):
        chain = chain_name(run_id)
        if not 120 <= window_seconds <= 1800:
            raise GuardError("rollback window must be 120..1800 seconds")
        with self.store.lock():
            directory = self.store.directory(run_id)
            before = self.backend.snapshot()
            if directory.exists() or chain in before["chains"] or not self.backend.units_absent(run_id):
                raise GuardError("run/chain/unit collision: never adopt existing resources")
            if before["chains"]["INPUT"]:
                raise GuardError("host-specific precondition: IPv6 INPUT must be empty")
            if any(before["policies"].get(c) not in ("ACCEPT", "DROP") for c in ("INPUT", "FORWARD", "OUTPUT")):
                raise GuardError("cannot establish real policies")
            hashes, files = self._persistence()
            directory.mkdir(mode=0o700)
            backup = encoded({name: None if data is None else base64.b64encode(data).decode("ascii") for name, data in files.items()})
            private_write(directory / "persistence.before.json", backup)
            if private_read(directory / "persistence.before.json") != backup:
                raise GuardError("private persistence backup readback failed")
            script = Path(__file__).read_bytes()
            private_write(directory / "ipv6_guard.py", script)
            units = dict(zip(unit_names(run_id), render_units(run_id, self.store.root, window_seconds)))
            for name, content in units.items():
                private_write(directory / name, content.encode())
            manifest = {"schema": 1, "run_id": run_id, "before": before, "boot_id": self.backend.boot_id(),
                        "script_sha256": digest(script), "persistence_sha256": hashes,
                        "unit_sha256": {name: digest(content.encode()) for name, content in units.items()},
                        "backup_sha256": digest(backup), "persistence_mode": PERSISTENCE_MODE,
                        "chain": chain, "tag": "stk6:" + run_id + ":" + secrets.token_hex(8),
                        "window_seconds": window_seconds, "prepared_monotonic_ns": self.backend.monotonic_ns()}
            private_write(directory / "manifest.json", encoded(manifest))
            state = {**manifest, "manifest_sha256": digest(encoded(manifest)),
                     "phase": "prepared", "actions": [], "rollback_actions": [], "units": {}}
            self.store.save(state)
            return state

    def _verify_bundle(self, state):
        directory = self.store.directory(state["run_id"])
        if digest(private_read(directory / "manifest.json")) != state["manifest_sha256"]:
            raise GuardError("manifest digest mismatch")
        if digest(private_read(directory / "ipv6_guard.py")) != state["script_sha256"]:
            raise GuardError("staged rollback script digest mismatch")
        if digest(private_read(directory / "persistence.before.json")) != state["backup_sha256"]:
            raise GuardError("persistence backup digest mismatch")
        for name in unit_names(state["run_id"]):
            if digest(private_read(directory / name)) != state["unit_sha256"][name]:
                raise GuardError("staged unit digest mismatch")
        if digest(Path(__file__).read_bytes()) != state["script_sha256"]:
            raise GuardError("running script differs from prepared artifact")
        if self.backend.boot_id() != state["boot_id"]:
            raise GuardError("boot changed; no stale rollback/apply/confirm")
        if self._persistence()[0] != state["persistence_sha256"]:
            raise GuardError("persistence drift: external writes are not owned or restored")

    def _evidence(self, state, kind, path, sha256):
        raw = private_read(path)
        if digest(raw) != sha256:
            raise GuardError("attestation digest mismatch")
        proof = json.loads(raw)
        for field, value in {"schema": 1, "kind": kind, "source": "operator-observed", "run_id": state["run_id"],
                             "manifest_sha256": state["manifest_sha256"], "boot_id": state["boot_id"], "persistence_mode": PERSISTENCE_MODE}.items():
            if proof.get(field) != value:
                raise GuardError("attestation binding mismatch: " + field)
        threshold = state["prepared_monotonic_ns"] if kind == "preflight" else state["applied_monotonic_ns"]
        now = self.backend.monotonic_ns()
        if not threshold < proof.get("observed_monotonic_ns", 0) <= now < proof.get("expires_monotonic_ns", 0):
            raise GuardError("attestation is stale, future-dated or expired")
        if not proof.get("operator") or not proof.get("authorization_ref"):
            raise GuardError("operator and explicit authorization reference required")
        if not proof.get("original_session") or not proof.get("second_session") or proof["original_session"] == proof["second_session"]:
            raise GuardError("independent SSH connection attestation required")
        names = PREFLIGHT_CHECKS if kind == "preflight" else POST_CHECKS
        if set(proof.get("checks", {})) != set(names):
            raise GuardError("required probe/evidence matrix is incomplete")
        for name in names:
            check = proof["checks"][name]
            filename = check.get("file", "")
            if not filename or Path(filename).name != filename or "\\" in filename:
                raise GuardError("evidence file must be an adjacent basename")
            data = private_read(Path(path).parent / filename)
            if not data or check.get("outcome") != "pass" or digest(data) != check.get("sha256"):
                raise GuardError("probe/evidence failed integrity or outcome: " + name)
        # Integrity + operator attestation, NOT an automated network probe.
        private_write(self.store.directory(state["run_id"]) / (kind + ".accepted.json"), raw)
        return proof

    def _service_clean(self, state, observed):
        service = observed["service"]
        if service["start_us"] > 0:
            return False
        if state.get("systemd_observation", {}).get("service", {}).get("start_us", 0) > 0:
            return False
        # Persisted positive evidence is never treated as a never-started service.
        return (service["active"] == "inactive" and service["sub"] == "dead"
                and service["result"] == "success" and service["status"] == 0
                and service["start_us"] == 0
                and not observed["jobs"]
                and not (self.store.directory(state["run_id"]) / "rollback-started.json").exists())

    def _observe(self, state):
        authoritative = self.store.read(state["run_id"])
        previous = authoritative.get("systemd_observation", {})
        observed = self.backend.observe({**authoritative, "systemd_observation": previous})
        retained = copy.deepcopy(observed)
        previous_service = previous.get("service", {})
        current_start = observed["service"]["start_us"]
        previous_start = previous_service.get("start_us", 0)
        if current_start < previous_start:
            retained["service"]["start_us"] = previous_start
        authoritative["systemd_observation"] = retained
        self.store.save(authoritative)
        state.clear()
        state.update(authoritative)
        return retained

    def _armed(self, state):
        observed = self._observe(state)
        timer = observed["timer"]
        if (timer["active"] != "active" or timer["sub"] != "waiting"
                or timer["next_us"] * 1000 <= self.backend.monotonic_ns() + 30_000_000_000
                or not self._service_clean(state, observed)):
            raise GuardError("rollback timer not safely armed / rollback service has started")
        return observed

    def _unit_event(self, state, name, event):
        if name not in unit_names(state["run_id"]) or event not in ("intent", "acquired", "installed", "start_intent", "started"):
            raise GuardError("invalid unit journal event")
        entry = state["units"].setdefault(name, {key: False for key in ("intent", "acquired", "installed", "start_intent", "started")})
        entry[event] = True
        self.store.save(state)

    def _action(self, state, op, *args):
        item = {"op": op, "args": list(args), "intent": True, "applied": False}
        state["actions"].append(item)
        self.store.save(state)  # Write-ahead intent; command may take effect then fail.
        self.backend.mutate(op, *args)
        item["applied"] = True
        self.store.save(state)

    def _jump(self, state):
        return ["-m", "comment", "--comment", state["tag"], "-j", state["chain"]]

    def _verify_applied(self, state):
        actual = self.backend.snapshot()
        expected = copy.deepcopy(state["before"])
        expected["chains"][state["chain"]] = input_rules(state["tag"])
        expected["chains"]["INPUT"].insert(0, self._jump(state))
        expected["policies"].update(INPUT="DROP", FORWARD="DROP")
        if actual != expected:
            raise GuardError("IPv6 readback differs (including unowned chains/OUTPUT)")

    def _rollback_locked(self, state, initial_errors=()):
        if self.backend.boot_id() != state["boot_id"]:
            raise GuardError("boot changed; refuse stale policy writes; reconcile manually")
        errors = list(initial_errors)
        state["phase"] = "rolling_back"

        def attempt(label, action):
            entry = {"action": label, "intent": True, "applied": False}
            state["rollback_actions"].append(entry)
            try:
                self.store.save(state)
            except Exception as exc:
                errors.append("journal before " + label + ": " + str(exc))
            try:
                result = action()
                entry["applied"] = True
                return result
            except Exception as exc:
                entry["error"] = type(exc).__name__ + ": " + str(exc)
                errors.append(label + ": " + str(exc))
                return None
            finally:
                try:
                    self.store.save(state)
                except Exception as exc:
                    errors.append("journal after " + label + ": " + str(exc))

        # Restore EVERY intended policy first, including lost-ack/crash cases.
        # Independent failures cannot suppress restoration/readback of the other.
        touched = {a["args"][0] for a in state["actions"] if a["op"] == "policy" and a["intent"]}
        if not touched <= {"INPUT", "FORWARD"}:
            raise GuardError("journal requests policy outside owned scope")
        restored = True
        for chain in ("INPUT", "FORWARD"):
            if chain not in touched:
                continue
            previous = state["before"]["policies"][chain]
            current = attempt("read policy " + chain, lambda c=chain: self.backend.snapshot()["policies"][c])
            if current != previous:
                attempt("restore policy " + chain, lambda c=chain, p=previous: self.backend.mutate("policy", c, p))
            readback = attempt("verify policy " + chain, lambda c=chain: self.backend.snapshot()["policies"][c])
            if readback != previous:
                restored = False
                errors.append("policy not restored: " + chain)

        cleaned = False
        if restored:
            def cleanup_owned():
                snapshot = self.backend.snapshot()
                own = snapshot["chains"].get(state["chain"])
                if own is None:
                    return True
                created = any(a["op"] == "create" and a["applied"] for a in state["actions"])
                expected = input_rules(state["tag"])
                if (own != expected[:len(own)] or (not own and not created)):
                    raise GuardError("chain ownership ambiguous/modified; preserve for manual review")
                jump = self._jump(state)
                for chain, rules in snapshot["chains"].items():
                    for rule in rules:
                        if state["chain"] in rule and not (chain == "INPUT" and rule == jump):
                            raise GuardError("foreign reference to own chain; no deletion")
                # Only exact tagged jumps, never line numbers or foreign references.
                for rule in snapshot["chains"]["INPUT"]:
                    if rule == jump:
                        self.backend.mutate("delete_jump", state["chain"], jump)
                if jump in self.backend.snapshot()["chains"]["INPUT"]:
                    raise GuardError("owned jump removal not verified")
                # External writers do not share our lock. Delete exact owned
                # rules, never flush; -X must refuse concurrent foreign content.
                # Reverse order retains the validated prefix on a partial retry.
                for rule in reversed(own):
                    self.backend.mutate("delete_rule", state["chain"], rule)
                self.backend.mutate("delete_chain", state["chain"])
                if state["chain"] in self.backend.snapshot()["chains"]:
                    raise GuardError("owned chain removal not verified")
                return True
            cleaned = attempt("remove owned resources", cleanup_owned) is True
        else:
            errors.append("jumps/chains retained until ALL touched policies are read back")
        timer_record = state.get("units", {}).get(unit_names(state["run_id"])[1], {})
        timer_owned = timer_record.get("acquired") and timer_record.get("installed")
        if restored and cleaned and timer_owned:
            # Do not cancel a pending fallback while active recovery is incomplete.
            # Never stop the rollback SERVICE (possibly this process).
            attempt("stop timer", lambda: self.backend.stop_timer(state))
            def verify_timer_stopped():
                if not self.backend.timer_stopped(state):
                    raise GuardError("timer stop not verified")
            attempt("verify stopped timer", verify_timer_stopped)
        elif not restored or not cleaned:
            errors.append("pending timer preserved; no automatic rearm if already fired")
        # No acquired timer => never stop/adopt even an identical collision file.
        attempt("verify persistence unchanged and backup", lambda: self._verify_bundle(state))
        state["rollback_errors"] = errors
        state["phase"] = "rollback_incomplete" if errors else "rolled_back"
        state["rollback_finished_monotonic_ns"] = self.backend.monotonic_ns()
        try:
            self.store.save(state)
        except Exception as exc:
            raise GuardError("active recovery attempted; final journal unavailable; NOT verified durable success") from exc
        if errors:
            raise GuardError("rollback incomplete: " + "; ".join(errors))
        return state

    def _record_timer_start(self, run_id):
        # This receipt is deliberately OUTSIDE the operation lock. A service
        # waiting for confirm/apply must already be visible as started.
        path = self.store.directory(run_id) / "rollback-started.json"
        if not path.exists():
            receipt = {"boot_id": self.backend.boot_id(), "entered_monotonic_ns": self.backend.monotonic_ns()}
            private_write(path, encoded(receipt))
        return json.loads(private_read(path))

    def rollback(self, run_id, trigger="manual"):
        if trigger not in ("manual", "timer"):
            raise GuardError("invalid rollback trigger")
        receipt, receipt_errors = None, []
        if trigger == "timer":
            try:
                receipt = self._record_timer_start(run_id)
            except Exception as exc:
                # Disk/receipt failure forbids confirmation/noop, not recovery.
                receipt_errors.append("timer start receipt unavailable: " + str(exc))
        with self.store.lock():
            state = self.store.read(run_id)
            active = self.store.root / "active.json"
            if active.exists() and json.loads(private_read(active))["run_id"] != run_id:
                raise GuardError("newer run owns the active firewall; refuse stale rollback")
            if receipt and state["phase"] == "confirmed":
                service = self._observe(state)["service"]
                point = state["confirmed_monotonic_ns"]
                # Kernel service-start timestamp closes the gap before Python
                # can write its receipt. Unknown/zero/earlier => rollback.
                if (receipt["boot_id"] == state["boot_id"] == self.backend.boot_id()
                        and receipt["entered_monotonic_ns"] > point
                        and service["start_us"] * 1000 > point):
                    state["late_timer_noop"] = True
                    self.store.save(state)
                    return state
            return self._rollback_locked(state, receipt_errors)

    @staticmethod
    def _in_flight(observed):
        return bool(observed["jobs"]) or observed["service"]["active"] in ("active", "activating", "deactivating", "reloading")

    def _disarmed_clean(self, state):
        observed = self._observe(state)
        if observed["timer"] != {"active": "inactive", "sub": "dead", "next_us": 0} or not self._service_clean(state, observed):
            raise GuardError("timer/service/job/start receipt invalid after synchronous timer stop")
        return observed

    def _wait_rollback(self, state, seconds):
        # MUST run outside the lock. Never stop, kill, reset or restart service.
        deadline = time.monotonic() + seconds
        while True:
            # Brief read lock only; release before waiting. Also avoids Windows
            # readers denying atomic replacement of journal.json in simulations.
            with self.store.lock(timeout=max(0, deadline - time.monotonic())):
                observed = self._observe(state)
                service = observed["service"]
                latest = self.store.read(state["run_id"])
                if not self._in_flight(observed):
                    if (latest["phase"] == "rolled_back" and service["active"] == "inactive" and service["sub"] == "dead"
                            and service["result"] == "success" and service["status"] == 0 and service["start_us"] > 0):
                        actual = self.backend.snapshot()
                        touched = {a["args"][0] for a in latest["actions"] if a["op"] == "policy" and a["intent"]}
                        if (self.backend.boot_id() != latest["boot_id"] or latest["chain"] in actual["chains"]
                                or self._jump(latest) in actual["chains"]["INPUT"]
                                or any(actual["policies"][c] != latest["before"]["policies"][c] for c in touched)):
                            raise GuardError("active rollback readback differs from recovered owned state")
                        self._verify_bundle(latest)
                        return
                    raise GuardError("rollback service completed unsuccessfully or lacks verified journal result")
            if time.monotonic() >= deadline:
                raise GuardError("rollback still queued/running; NOT cancelled; inspect journal and wait/retry")
            time.sleep(0.02)

    def confirm(self, run_id, evidence, sha256, wait_seconds=30):
        waiting = False
        failure = None
        recovery_error = None
        with self.store.lock():
            state = self.store.read(run_id)
            if state["phase"] != "applied":
                raise GuardError("confirmation refused: run is not applied")
            try:
                self._verify_bundle(state)
                proof = self._evidence(state, "post", evidence, sha256)
                if (proof["original_session"] != state["original_session"]
                        or not state["applied_monotonic_ns"] < proof.get("second_session_opened_monotonic_ns", 0) <= proof["observed_monotonic_ns"]):
                    raise GuardError("a NEW independent SSH connection after application is required")
                self._verify_applied(state)
                before = self._armed(state)
                self.backend.stop_timer(state)  # Synchronous. NEVER the service.
                after = self._disarmed_clean(state)
                state["confirmation_observations"] = {"before_stop": before, "after_stop": after}
                state["confirmed_monotonic_ns"] = self.backend.monotonic_ns()
                state["phase"] = "confirmed"
                self.store.save(state)  # Durable linearization marker, under lock.
                self._disarmed_clean(state)  # Catch activation/receipt racing save.
                self._verify_bundle(state)
                self._verify_applied(state)
                self._disarmed_clean(state)  # Final readback before releasing lock.
                return state
            except BaseException as exc:
                failure = exc
                state["phase"] = "rollback_required"
                state["confirmation_error"] = type(exc).__name__ + ": " + str(exc)
                try:
                    self.store.save(state)
                except Exception as save_error:
                    recovery_error = save_error
                try:
                    waiting = self._in_flight(self._observe(state))
                except Exception:
                    # Shared lock still makes direct recovery safe if systemd
                    # observation itself fails. A concurrent rollback waits.
                    waiting = False
                if not waiting:
                    try:
                        self._rollback_locked(state)
                    except BaseException as exc:
                        recovery_error = exc
        if waiting:
            try:
                self._wait_rollback(state, wait_seconds)
            except BaseException as exc:
                recovery_error = exc
        if recovery_error:
            raise GuardError("confirmation refused; recovery incomplete or service still running; inspect private journal") from recovery_error
        raise GuardError("confirmation refused; active rollback verified; never stopped rollback service") from failure

    def apply(self, run_id, evidence, sha256):
        waiting = False
        failure = recovery_error = None
        with self.store.lock():
            state = self.store.read(run_id)
            if state["phase"] != "prepared":
                raise GuardError("apply requires a fresh prepared run; no resume/adoption")
            self._verify_bundle(state)
            proof = self._evidence(state, "preflight", evidence, sha256)
            if self.backend.snapshot() != state["before"]:
                raise GuardError("firewall drift since preparation")
            active = self.store.root / "active.json"
            if active.exists():
                previous = json.loads(private_read(active))
                if self.store.read(previous["run_id"])["phase"] != "rolled_back":
                    raise GuardError("another run still owns the active window")
            private_write(active, encoded({"run_id": run_id}))
            state["phase"] = "applying"
            state["original_session"] = proof["original_session"]
            try:
                self.store.save(state)
                self.backend.arm(state, self.store.directory(run_id), lambda name, event: self._unit_event(state, name, event))
                self._armed(state)
                self._action(state, "create", state["chain"])
                for rule in input_rules(state["tag"]):
                    self._armed(state)
                    self._action(state, "append", state["chain"], rule)
                if self.backend.snapshot()["chains"][state["chain"]] != input_rules(state["tag"]):
                    raise GuardError("chain not completely populated before attachment")
                self._armed(state)
                self._action(state, "jump", state["chain"], self._jump(state))
                for chain in ("INPUT", "FORWARD"):
                    self._armed(state)
                    if state["before"]["policies"][chain] != "DROP":
                        self._action(state, "policy", chain, "DROP")
                self._verify_applied(state)
                self._verify_bundle(state)
                state["phase"] = "applied"
                state["applied_monotonic_ns"] = self.backend.monotonic_ns()
                self.store.save(state)
                self._armed(state)  # Catch activation/jobs/receipt racing the last mutation/save.
                return state
            except BaseException as exc:
                failure = exc
                state["application_error"] = type(exc).__name__ + ": " + str(exc)
                timer = state.get("units", {}).get(unit_names(run_id)[1], {})
                try:
                    waiting = bool(timer.get("acquired") and timer.get("installed")
                                   and self._in_flight(self._observe(state)))
                except Exception:
                    # Unknown service state cannot suppress safe locked recovery.
                    waiting = False
                if waiting:
                    state["phase"] = "rollback_required"
                    try:
                        self.store.save(state)
                    except Exception as save_error:
                        recovery_error = save_error
                else:
                    try:
                        self._rollback_locked(state)
                    except BaseException as recovery:
                        recovery_error = recovery
        if waiting:
            # The worker needs the same lock. Never stop its service or compete
            # with it; wait outside the lock and reject this application anyway.
            try:
                self._wait_rollback(state, 30)
            except BaseException as recovery:
                recovery_error = recovery
        if recovery_error:
            raise GuardError("application failed; rollback INCOMPLETE; inspect private journal and retry rollback") from recovery_error
        raise GuardError("application failed; active rollback verified; not confirmed") from failure


def unit_names(run_id):
    chain_name(run_id)
    base = "stk6-rollback-" + run_id
    return base + ".service", base + ".timer"


def render_units(run_id, root, seconds):
    service_name, _ = unit_names(run_id)
    root = str(root).replace("\\", "/")
    def quote(value):
        return '"' + value.replace("%", "%%").replace("$", "$$").replace('"', '\\"') + '"'
    script = root + "/" + run_id + "/ipv6_guard.py"
    service = ("[Unit]\nDescription=STK IPv6 owned rollback\n\n[Service]\nType=oneshot\nUser=root\n"
               "UMask=0077\nRemainAfterExit=no\nRestart=no\nTimeoutStartSec=infinity\n"
               "StandardOutput=journal\nStandardError=journal\n"
               "ExecStart=/usr/bin/python3 -I -B " + quote(script) + " rollback --trigger timer --execute-reviewed-linux --state-dir "
               + quote(root) + " --run-id " + run_id + "\n")
    timer = ("[Unit]\nDescription=STK IPv6 bounded active-state window\n\n[Timer]\n"
             f"OnActiveSec={seconds}s\nAccuracySec=1s\nRandomizedDelaySec=0\nWakeSystem=false\nPersistent=false\nUnit={service_name}\n")
    return service, timer


def parse_unit_job(properties):
    if "Job" not in properties:
        raise GuardError("missing unit Job (systemctl show --all required)")
    value = properties["Job"]
    if value == "":  # systemd 255 renders the (uo) zero Job as empty.
        return 0
    if not re.fullmatch(r"[0-9]+(?: .*|)", value):
        raise GuardError("invalid unit Job")
    return int(value.split()[0])


def parse_systemd_next_elapse(value):
    """Parse systemd's human rendering of NextElapseUSecMonotonic.

    ``systemctl show`` formats uint64 ``*USec`` properties as a duration;
    uint64 max is rendered as ``infinity``. The guard needs the stopped
    sentinel (zero) versus the absolute positive monotonic deadline.
    """
    if value is None:
        raise GuardError("NextElapseUSecMonotonic property is missing")
    value = value.strip()
    if value == "infinity":
        return 0
    if value in ("", "0"):
        if value == "0":
            return 0
        raise GuardError("NextElapseUSecMonotonic property is missing")
    if re.fullmatch(r"[0-9]+", value):
        return int(value)
    units = {"us": 1, "µs": 1, "ms": 1_000, "s": 1_000_000,
             "min": 60_000_000, "h": 3_600_000_000, "d": 86_400_000_000,
             "w": 604_800_000_000}
    total = Decimal(0)
    token = re.compile(r"([0-9]+(?:\.[0-9]+)?)(us|µs|ms|min|s|h|d|w)")
    parts = value.split()
    if not parts:
        raise GuardError("invalid NextElapseUSecMonotonic property")
    for part in parts:
        match = token.fullmatch(part)
        if not match:
            raise GuardError("invalid NextElapseUSecMonotonic property")
        total += Decimal(match[1]) * units[match[2]]
    if total <= 0 or total != total.to_integral_value():
        raise GuardError("invalid NextElapseUSecMonotonic property")
    return int(total)


def parse_dbus_usec(text, allow_infinity=False):
    match = re.fullmatch(r"t ([0-9]+)\s*", text)
    if not match:
        raise GuardError("expected raw D-Bus uint64 microseconds, not formatted duration")
    value = int(match[1])
    if value >= 2**64 - 1:
        if allow_infinity and value == 2**64 - 1:
            return 0
        raise GuardError("invalid/infinite monotonic timestamp")
    return value


def parse_filter(text):
    snapshot = {"policies": {}, "chains": {}}
    for line in text.splitlines():
        args = shlex.split(line)
        if not args:
            continue
        if args[0] == "-P" and len(args) == 3:
            snapshot["policies"][args[1]] = args[2]
            snapshot["chains"][args[1]] = []
        elif args[0] == "-N" and len(args) == 2:
            snapshot["chains"][args[1]] = []
        elif args[0] == "-A" and args[1] in snapshot["chains"]:
            rule = args[2:]
            if "--ctstate" in rule:
                index = rule.index("--ctstate") + 1
                rule[index] = ",".join(sorted(rule[index].split(",")))
            snapshot["chains"][args[1]].append(rule)
        else:
            raise GuardError("unexpected ip6tables -S output")
    if set(snapshot["policies"]) != {"INPUT", "FORWARD", "OUTPUT"}:
        raise GuardError("missing built-in IPv6 policies")
    return snapshot


class LinuxAdapter:
    """Only this adapter can reach Linux. Injected runner is used by tests.

    No shell commands, global restores, persistence saves/reloads, IPv4 tooling,
    nft, SSH, installs, service stops or external network probes are provided.
    """
    IP6 = "/usr/sbin/ip6tables"
    SYSTEMCTL = "/usr/bin/systemctl"
    BUSCTL = "/usr/bin/busctl"
    UNIT_DIR = Path("/run/systemd/system")
    PERSISTENT_FILES = ("/etc/iptables/rules.v4", "/etc/iptables/rules.v6", "/etc/default/netfilter-persistent",
                        "/usr/share/netfilter-persistent/plugins.d/15-ip4tables", "/usr/share/netfilter-persistent/plugins.d/25-ip6tables")

    def __init__(self, runner=None, execute_reviewed=False, file_reader=None):
        self.runner = runner
        self.execute_reviewed = execute_reviewed
        self.file_reader = file_reader or self._system_read

    @staticmethod
    def _system_read(name):
        path = Path(name)
        info = path.lstat()
        if path.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise GuardError("system prerequisite must be root-owned regular, not writable by others")
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as stream:
            return stream.read()

    def _call(self, argv, ok=(0,)):
        if self.runner is not None:
            return self.runner(list(argv))
        if not self.execute_reviewed or sys.platform != "linux" or os.geteuid() != 0:
            raise GuardError("live operations require separately reviewed Linux/root execution")
        result = subprocess.run(argv, capture_output=True, text=True, timeout=30, check=False,
                                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "SYSTEMD_PAGER": "cat", "SYSTEMD_COLORS": "0"})
        if result.returncode not in ok:
            # No raw firewall/systemd output leaks to the terminal or CI log.
            error = GuardError(Path(argv[0]).name + " failed with exit " + str(result.returncode))
            error.detail = result.stderr or ""  # Classification identity only; never printed or journalled verbatim.
            raise error
        return result.stdout

    def validate_host(self):
        release = self.file_reader("/usr/lib/os-release").decode()
        values = dict(line.split("=", 1) for line in release.splitlines() if "=" in line and not line.startswith("#"))
        if values.get("ID", "").strip('"') != "ubuntu" or values.get("VERSION_ID", "").strip('"') != "24.04" or platform.machine() != "aarch64":
            raise GuardError("reviewed target is Ubuntu 24.04 ARM64 only")
        if not re.fullmatch(r"ip6tables v1\.8\.10 \(nf_tables\)\s*", self._call([self.IP6, "--version"])):
            raise GuardError("reviewed backend must be ip6tables 1.8.10 nf_tables")

    @staticmethod
    def monotonic_ns():
        return time.monotonic_ns()  # CLOCK_MONOTONIC matches WakeSystem=false.

    def boot_id(self):
        return self.file_reader("/proc/sys/kernel/random/boot_id").decode().strip()

    def snapshot(self):
        return parse_filter(self._call([self.IP6, "-w", "5", "-t", "filter", "-S"]))

    def persistence_files(self):
        optional = {"/etc/iptables/rules.v4", "/etc/iptables/rules.v6", "/etc/default/iptables"}
        files = {}
        for name in (*self.PERSISTENT_FILES, "/etc/default/iptables"):
            try:
                files[name] = self.file_reader(name)
            except FileNotFoundError:
                if name not in optional:
                    raise
                files[name] = None  # Absence is a real before-state, not empty bytes.
        return files

    def mutate(self, op, *args):
        if op == "policy":
            if len(args) != 2 or args[0] not in ("INPUT", "FORWARD") or args[1] not in ("ACCEPT", "DROP"):
                raise GuardError("policy mutation outside IPv6 INPUT/FORWARD")
            command = ["-P", *args]
        else:
            if not args or not re.fullmatch(r"STK6_[0-9a-f]{20}", args[0]):
                raise GuardError("chain mutation outside owned namespace")
            chain = args[0]
            simple = {"create": "-N", "delete_chain": "-X"}
            if op in simple and len(args) == 1:
                command = [simple[op], chain]
            elif op in ("append", "delete_rule") and len(args) == 2:
                if "--comment" not in args[1] or not args[1][args[1].index("--comment") + 1].startswith("stk6:" + chain[5:] + ":"):
                    raise GuardError("rule lacks ownership tag")
                command = ["-A" if op == "append" else "-D", chain, *args[1]]
            elif op in ("jump", "delete_jump") and len(args) == 2:
                rule = args[1]
                if len(rule) != 6 or rule[:3] != ["-m", "comment", "--comment"] or rule[-2:] != ["-j", chain] or not rule[3].startswith("stk6:" + chain[5:] + ":"):
                    raise GuardError("invalid owned INPUT jump")
                command = (["-I", "INPUT", "1"] if op == "jump" else ["-D", "INPUT"]) + list(rule)
            else:
                raise GuardError("unsupported mutation")
        self._call([self.IP6, "-w", "5", "-t", "filter", *command])

    def _show(self, unit):
        properties = "LoadState,FragmentPath,ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestampMonotonic,NextElapseUSecMonotonic,Job"
        text = self._call([self.SYSTEMCTL, "show", unit, "--all", "--no-pager", "--property=" + properties], ok=(0, 1))
        result = {}
        for line in text.splitlines():
            key, separator, value = line.partition("=")
            if not separator or key in result:
                raise GuardError("invalid/duplicate systemctl property")
            result[key] = value
        if "LoadState" not in result:
            raise GuardError("systemd unit state unreadable")
        return result

    _UNIT_NOT_LOADED_RE = re.compile(
        r"(?im)^\s*(?:call failed:\s*)?unit\s+(?P<unit>[^\s]+)\s+not loaded\.\s*$"
    )

    def _unit_not_loaded(self, error, unit=None):
        # Classification identity only: accept systemd's exact not-loaded
        # response for the unit that was requested. Exit status and unrelated
        # D-Bus errors are never enough; stderr is never printed or journalled.
        if not isinstance(error, GuardError):
            return False
        detail = getattr(error, "detail", "") or ""
        match = self._UNIT_NOT_LOADED_RE.search(detail)
        if match and unit is not None and match.group("unit") == unit:
            return True
        if unit is None:
            return False
        # NoSuchUnit is accepted only when it names the requested unit.
        return bool(re.search(r"(?im)nosuchunit.*unit\s+" + re.escape(unit) + r"\b", detail))

    def _usec(self, unit, interface, prop, infinity=False, prior=None):
        try:
            raw = self._call([self.BUSCTL, "--system", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
                              "org.freedesktop.systemd1.Manager", "GetUnit", "s", unit])
        except GuardError as error:
            if not self._unit_not_loaded(error, unit):
                raise
            # GetUnit refuses units systemd garbage-collected while quiescent:
            # systemctl show re-loads the unit as an ephemeral client and its
            # exit drops the pin, so the next GetUnit is refused by identity,
            # not by transient fault. Callers resolve via fresh readbacks.
            raise UnitNotLoaded(unit + " refused by D-Bus: not loaded") from error
        parts = shlex.split(raw)
        if len(parts) != 2 or parts[0] != "o" or not parts[1].startswith("/org/freedesktop/systemd1/unit/"):
            raise GuardError("invalid D-Bus unit object")
        raw = self._call([self.BUSCTL, "--system", "get-property", "org.freedesktop.systemd1", parts[1],
                          "org.freedesktop.systemd1." + interface, prop])
        value = parse_dbus_usec(raw, allow_infinity=infinity)
        if prior not in (None, "", "0") and value == 0 and prop == "ExecMainStartTimestampMonotonic":
            try:
                previous = int(prior)
            except (TypeError, ValueError):
                raise GuardError(unit + " prior " + prop + " is invalid")
            if previous > 0:
                return previous, False
        return value, True

    def _monotonic_readback(self, unit, interface, prop, infinity=False, prior=None):
        """Read a monotonic property without erasing an earlier observation.

        A GetUnit refusal permits a fresh ``systemctl show`` readback only for a
        quiescent unit. A non-zero value already observed is retained when the
        fresh show loses execution history; a fresh zero is never evidence that
        a service did not run. Other D-Bus failures remain hard refusals.
        """
        try:
            return self._usec(unit, interface, prop, infinity=infinity, prior=prior)
        except UnitNotLoaded as error:
            info = self._show(unit)
            quiescent = (info.get("LoadState") == "not-found"
                         or (info.get("LoadState") == "loaded" and info.get("ActiveState") == "inactive"
                             and info.get("SubState") == "dead" and parse_unit_job(info) == 0))
            if not quiescent:
                raise GuardError(unit + " neither quiescent on readback nor readable via D-Bus: " + str(error)) from error
            shown = info.get(prop)
            if infinity and prop == "NextElapseUSecMonotonic":
                parsed = parse_systemd_next_elapse(shown)
                if parsed == 0:
                    return 0, False
                # systemctl show exposes a human duration here, not the
                # absolute monotonic timestamp returned by D-Bus. It proves
                # that a deadline remains, but cannot quantify observe().
                raise GuardError(unit + " pending " + prop + " unquantifiable without D-Bus") from error
            if prior is not None and prior != "":
                try:
                    prior_value = int(prior)
                except (TypeError, ValueError):
                    raise GuardError(unit + " prior " + prop + " is invalid") from error
                if prior_value > 0:
                    return prior_value, False
            if prop == "ExecMainStartTimestampMonotonic" and info.get("LoadState") == "loaded":
                if prop in info:
                    return 0, False
                raise GuardError(unit + " quiescent but " + prop + " unquantifiable without D-Bus") from error
            # A zero/absent service timestamp after a reload cannot prove that
            # the service never ran: systemd may have discarded the evidence.
            raise GuardError(unit + " quiescent but " + prop + " unquantifiable without D-Bus") from error

    def units_absent(self, run_id):
        return all(not (self.UNIT_DIR / name).exists() and self._show(name)["LoadState"] == "not-found" for name in unit_names(run_id))

    def observe(self, state):
        service_name, timer_name = unit_names(state["run_id"])
        service, timer = self._show(service_name), self._show(timer_name)
        if service["LoadState"] != "loaded" or timer["LoadState"] != "loaded":
            raise GuardError("rollback units not loaded")
        retained = state.get("systemd_observation", {})
        previous_service = retained.get("service", {})
        previous_timer = retained.get("timer", {})
        service_prior = service.get("ExecMainStartTimestampMonotonic")
        if service_prior in (None, "", "0") and previous_service.get("start_us", 0) > 0:
            service_prior = str(previous_service["start_us"])
        timer_prior = timer.get("NextElapseUSecMonotonic")
        if timer_prior in (None, "") and previous_timer.get("next_us", 0) > 0:
            timer_prior = str(previous_timer["next_us"])
        start, _ = self._monotonic_readback(service_name, "Service", "ExecMainStartTimestampMonotonic",
                                            prior=service_prior)
        next_us, _ = self._monotonic_readback(timer_name, "Timer", "NextElapseUSecMonotonic", infinity=True,
                                              prior=timer_prior)
        jobs = []
        for row in self._call([self.SYSTEMCTL, "list-jobs", "--no-legend", "--plain", "--no-pager"]).splitlines():
            fields = row.split()
            if not fields:
                continue
            if len(fields) != 4 or not fields[0].isdigit():
                raise GuardError("unparseable systemd jobs")
            if fields[1] in (service_name, timer_name):
                jobs.append(fields)
        for name, properties in ((service_name, service), (timer_name, timer)):
            job = parse_unit_job(properties)
            if job:
                jobs.append([str(job), name])
        return {"timer": {"active": timer["ActiveState"], "sub": timer["SubState"], "next_us": next_us},
                "service": {"active": service["ActiveState"], "sub": service["SubState"], "result": service["Result"],
                            "status": int(service["ExecMainStatus"]), "start_us": start}, "jobs": jobs}

    def arm(self, state, directory, record):
        names = unit_names(state["run_id"])
        if not self.units_absent(state["run_id"]):
            raise GuardError("unit collision while arming")
        for name in names:
            content = private_read(Path(directory) / name)
            if digest(content) != state["unit_sha256"][name]:
                raise GuardError("staged unit digest mismatch")
            record(name, "intent")
            fd = os.open(self.UNIT_DIR / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as stream:
                record(name, "acquired")  # Only after successful exclusive create.
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            record(name, "installed")  # Durable BEFORE load/start can execute it.
        self._call([self.SYSTEMCTL, "daemon-reload"])
        for name in names:
            info = self._show(name)
            if info["LoadState"] != "loaded" or info.get("FragmentPath") != str(self.UNIT_DIR / name):
                raise GuardError("installed unit readback mismatch")
        record(names[1], "start_intent")
        self._call([self.SYSTEMCTL, "start", names[1]])  # No enable; no service start.
        record(names[1], "started")

    def timer_stopped(self, state):
        _, name = unit_names(state["run_id"])
        timer = self._show(name)
        # An absent unit after an arming failure is not an active timer. Do not
        # fabricate service execution/state to verify this narrower property.
        jobs = self._call([self.SYSTEMCTL, "list-jobs", "--no-legend", "--plain", "--no-pager"])
        for row in jobs.splitlines():
            fields = row.split()
            if len(fields) != 4 or not fields[0].isdigit():
                raise GuardError("unparseable systemd jobs")
            if fields[1] == name:
                return False
        if timer["LoadState"] == "not-found":
            return True
        if not (timer["LoadState"] == "loaded" and timer["ActiveState"] == "inactive" and timer["SubState"] == "dead"
                and parse_unit_job(timer) == 0):
            return False
        # A positive formatted deadline proves that the timer is not stopped;
        # infinity/zero are the only no-deadline sentinels.
        shown = timer.get("NextElapseUSecMonotonic")
        if shown is not None:
            parsed = parse_systemd_next_elapse(shown)
            if parsed > 0:
                return False
        elif timer["LoadState"] == "loaded":
            raise GuardError("NextElapseUSecMonotonic property is missing")
        value, _ = self._monotonic_readback(name, "Timer", "NextElapseUSecMonotonic", infinity=True,
                                             prior=shown)
        return value == 0

    def stop_timer(self, state):
        _, name = unit_names(state["run_id"])
        acquired = state.get("units", {}).get(name, {})
        if not acquired.get("acquired") or not acquired.get("installed"):
            raise GuardError("timer was not acquired by this run; no stop/adoption")
        path = self.UNIT_DIR / name
        if not path.exists():
            if self._show(name)["LoadState"] == "not-found":
                return
            raise GuardError("refuse stopping timer without owned unit file")
        if digest(private_read(path)) != state["unit_sha256"][name]:
            raise GuardError("refuse stopping unowned/modified timer")
        loaded = self._show(name)
        if loaded["LoadState"] == "not-found":
            return
        if loaded["LoadState"] != "loaded" or loaded.get("FragmentPath") != str(path):
            raise GuardError("loaded timer fragment does not match acquired unit")
        self._call([self.SYSTEMCTL, "stop", name])  # Synchronous; never --no-block.


def public_status(state):
    return {key: state[key] for key in ("run_id", "phase", "manifest_sha256", "persistence_mode")}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("plan", help="offline contract only; no files, system commands or network")
    for name in ("prepare", "apply", "confirm", "rollback", "status"):
        command = commands.add_parser(name)
        command.add_argument("--state-dir", default="/var/lib/stk-ipv6")
        command.add_argument("--run-id", required=name != "prepare")
        if name != "status":
            command.add_argument("--execute-reviewed-linux", action="store_true", required=True)
        if name == "prepare":
            command.add_argument("--window-seconds", type=int, default=600)
        if name in ("apply", "confirm"):
            command.add_argument("--attestation", required=True)
            command.add_argument("--attestation-sha256", required=True)
        if name == "rollback":
            command.add_argument("--trigger", choices=("manual", "timer"), default="manual")
    args = parser.parse_args(argv)
    if args.command == "plan":
        print(json.dumps({"mode": "offline-review-only", "persistence_mode": PERSISTENCE_MODE,
                          "state_dir": "/var/lib/stk-ipv6", "preflight_checks": PREFLIGHT_CHECKS, "post_checks": POST_CHECKS,
                          "commands": ["prepare", "apply", "confirm", "rollback", "status"],
                          "evidence": "private structured operator attestation + SHA256; NOT automated network verification"}, indent=2))
        return 0
    try:
        if args.command == "status":
            if not Path(args.state_dir).is_dir():
                raise GuardError("state directory does not exist")
            store = Store(args.state_dir)
            with store.lock():
                result = store.read(args.run_id)
        else:
            if sys.platform != "linux" or os.geteuid() != 0:
                raise GuardError("review-only here: live path requires Linux/root and separate window approval")
            if args.state_dir != "/var/lib/stk-ipv6":
                raise GuardError("one fixed state directory is required for the global operation lock")
            for path in (Path(args.state_dir), *Path(args.state_dir).parents):
                if path.exists() and (path.is_symlink() or path.stat().st_uid != 0 or path.stat().st_mode & 0o022):
                    raise GuardError("unsafe state directory ancestor")
            backend = LinuxAdapter(execute_reviewed=True)
            if args.command in ("prepare", "apply"):
                backend.validate_host()
            controller = Controller(args.state_dir, backend)
            run_id = args.run_id or new_run_id()
            if args.command == "prepare":
                result = controller.prepare(run_id, args.window_seconds)
            elif args.command == "apply":
                result = controller.apply(run_id, args.attestation, args.attestation_sha256)
            elif args.command == "confirm":
                result = controller.confirm(run_id, args.attestation, args.attestation_sha256)
            else:
                result = controller.rollback(run_id, args.trigger)
        print(json.dumps(public_status(result), sort_keys=True))
        return 0
    except (GuardError, OSError, ValueError, KeyError, TypeError) as exc:
        # Details are private journal material, not console/snapshot output.
        print("REFUSED (" + type(exc).__name__ + "): no success claim; inspect private journal and runbook", file=sys.stderr)
        return 2


def new_run_id():
    return secrets.token_hex(10)


def chain_name(run_id):
    if not re.fullmatch(r"[0-9a-f]{20}", run_id):
        raise ValueError("run id must be exactly 20 lowercase hex characters")
    return "STK6_" + run_id


def input_rules(tag):
    # Permit all ICMPv6 deliberately: ND/RA/MLD, PMTU and error signalling.
    # This is not a router policy; forwarded Docker flows retain their jumps.
    return [prefix + ["-m", "comment", "--comment", tag, "-j", target]
            for prefix, target in [
                (["-i", "lo"], "ACCEPT"),
                (["-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED"], "ACCEPT"),
                (["-p", "ipv6-icmp"], "ACCEPT"),
                (["-p", "tcp", "-m", "tcp", "--dport", "22", "-m", "conntrack", "--ctstate", "NEW"], "ACCEPT"),
                ([], "DROP"),
            ]]


if __name__ == "__main__":
    raise SystemExit(main())
