"""Controlled, local-only reconciliation for an old STK-M0-06 run."""
import argparse
import json
import os
from pathlib import Path
import sys
import time

try:
    import ipv6_guard as guard
except ModuleNotFoundError:
    from . import ipv6_guard as guard


class ReconciliationError(guard.GuardError):
    """A reconciliation precondition or verification failed."""


class ReconciliationLinuxBackend:
    """Live adapter. It never mutates firewall or persistence state."""
    def __init__(self):
        self.adapter = guard.LinuxAdapter(execute_reviewed=True)
        self.UNIT_DIR = self.adapter.UNIT_DIR

    def boot_id(self):
        return self.adapter.boot_id()

    def snapshot(self):
        return self.adapter.snapshot()

    def persistence_files(self):
        return self.adapter.persistence_files()

    def reconciliation_readback(self, state):
        try:
            observed = self.adapter.observe(state)
        except guard.GuardError as exc:
            raise ReconciliationError("systemd state unknown") from exc
        service, timer = observed["service"], observed["timer"]
        if (timer["active"], timer["sub"], timer["next_us"]) != ("inactive", "dead", 0):
            raise ReconciliationError("timer state unknown or still pending")
        if (service["active"], service["sub"], service["result"], service["status"], service["start_us"]) != ("inactive", "dead", "success", 0, 0):
            raise ReconciliationError("service execution evidence contradicts reconciliation")
        if observed["jobs"]:
            raise ReconciliationError("systemd job remains pending")
        return {"timer_stopped": True, "service_never_started": True, "jobs": []}

    def unit_info(self, name):
        return self.adapter._show(name)

    def read_unit_file(self, name):
        return self.adapter._system_read(self.UNIT_DIR / name)

    def list_jobs(self, names):
        try:
            raw = self.adapter._call([self.adapter.SYSTEMCTL, "list-jobs", "--no-legend", "--plain", "--no-pager"])
        except guard.GuardError as exc:
            raise ReconciliationError("systemd jobs unknown") from exc
        jobs = []
        for row in raw.splitlines():
            fields = row.split()
            if not fields:
                continue
            if len(fields) != 4 or not fields[0].isdigit():
                raise ReconciliationError("systemd jobs unparseable")
            if fields[1] in names:
                jobs.append(fields)
        return jobs

    def units_absent(self, names):
        return all(self.unit_info(name).get("LoadState") == "not-found" and not (self.UNIT_DIR / name).exists() for name in names)

    def daemon_reload(self):
        self.adapter._call([self.adapter.SYSTEMCTL, "daemon-reload"])

    def remove_unit_file(self, name, expected_sha256):
        path = self.UNIT_DIR / name
        if guard.digest(self.read_unit_file(name)) != expected_sha256:
            raise ReconciliationError("runtime unit hash changed")
        os.unlink(path)
        if path.exists():
            raise ReconciliationError("unit removal not verified")


class Reconciler:
    """Transactional cleanup with durable private evidence and safe retry."""
    SCHEMA = 1

    def __init__(self, root, backend, timeout=30):
        self.store = guard.Store(root)
        self.backend = backend
        self.timeout = timeout

    def evidence_path(self, run_id):
        guard.chain_name(run_id)
        return self.store.root / ("reconciliation-" + run_id + ".json")

    def archive_path(self, run_id):
        guard.chain_name(run_id)
        return self.store.root / ("active.reconciled-" + run_id + ".json")

    def _load_state(self, run_id):
        try:
            state = self.store.read(run_id)
        except FileNotFoundError as exc:
            raise ReconciliationError("run identity or journal missing") from exc
        if state.get("phase") != "rollback_incomplete":
            raise ReconciliationError("run phase is not rollback_incomplete")
        if self.backend.boot_id() != state.get("boot_id"):
            raise ReconciliationError("boot changed; reconciliation refused")
        return state

    def _active(self, run_id):
        path = self.store.root / "active.json"
        if not path.is_file() or path.is_symlink():
            raise ReconciliationError("active.json absent or unsafe; completion unknown")
        raw = guard.private_read(path)
        try:
            value = json.loads(raw)
        except (TypeError, ValueError) as exc:
            raise ReconciliationError("active.json identity invalid") from exc
        if value.get("run_id") != run_id:
            raise ReconciliationError("active.json identity mismatch")
        return raw

    def _restored(self, state):
        if self.backend.snapshot() != state.get("before"):
            raise ReconciliationError("restoration snapshot differs from bundle before")
        expected = state.get("persistence_sha256", {})
        actual = {name: None if data is None else guard.digest(data) for name, data in self.backend.persistence_files().items()}
        if actual != expected:
            raise ReconciliationError("persistence differs from bundle")
        observed = self.backend.reconciliation_readback(state)
        if not isinstance(observed, dict) or observed.get("timer_stopped") is not True:
            raise ReconciliationError("timer state unknown or still pending")
        if observed.get("service_never_started") is not True:
            raise ReconciliationError("service execution evidence contradicts reconciliation")
        if observed.get("jobs"):
            raise ReconciliationError("systemd job remains pending")
        return observed

    def _load_evidence(self, run_id):
        path = self.evidence_path(run_id)
        if not path.is_file():
            raise ReconciliationError("reconciliation evidence missing")
        try:
            value = json.loads(guard.private_read(path))
        except (TypeError, ValueError) as exc:
            raise ReconciliationError("reconciliation evidence invalid") from exc
        if value.get("schema") != self.SCHEMA or value.get("run_id") != run_id:
            raise ReconciliationError("reconciliation evidence identity mismatch")
        return value

    def _save_evidence(self, evidence):
        guard.private_write(self.evidence_path(evidence["run_id"]), guard.encoded(evidence))

    def _validate_units(self, state, evidence):
        directory = self.store.directory(state["run_id"])
        names = guard.unit_names(state["run_id"])
        for name in names:
            entry = evidence["units"][name]
            info = self.backend.unit_info(name)
            if entry["status"] == "removed":
                if info.get("LoadState") != "not-found":
                    raise ReconciliationError("removed unit reappeared or collides")
                continue
            bundle = directory / name
            if not bundle.is_file() or bundle.is_symlink():
                raise ReconciliationError("bundle unit missing")
            if guard.digest(guard.private_read(bundle)) != state["unit_sha256"].get(name):
                raise ReconciliationError("bundle unit hash mismatch")
            expected_path = str(self.backend.UNIT_DIR / name)
            if info.get("LoadState") != "loaded" or info.get("FragmentPath") != expected_path:
                raise ReconciliationError("unit ownership/path mismatch")
            if guard.digest(self.backend.read_unit_file(name)) != state["unit_sha256"].get(name):
                raise ReconciliationError("runtime unit hash mismatch")
        return names

    def _remove_unit(self, name, evidence):
        entry = evidence["units"][name]
        if entry["status"] == "removed":
            return
        info = self.backend.unit_info(name)
        expected_path = str(self.backend.UNIT_DIR / name)
        if info.get("LoadState") != "loaded" or info.get("FragmentPath") != expected_path:
            raise ReconciliationError("unit ownership/path mismatch during removal")
        if guard.digest(self.backend.read_unit_file(name)) != entry["sha256"]:
            raise ReconciliationError("runtime unit hash changed")
        entry["status"] = "remove-intent"
        self._save_evidence(evidence)
        self.backend.remove_unit_file(name, entry["sha256"])
        if self.backend.unit_info(name).get("LoadState") != "not-found":
            raise ReconciliationError("unit removal not verified")
        entry["status"] = "removed"
        self._save_evidence(evidence)

    _remove = _remove_unit

    def _archive(self, run_id, active_raw, evidence):
        active, archive = self.store.root / "active.json", self.archive_path(run_id)
        if archive.exists():
            if guard.private_read(archive) != active_raw:
                raise ReconciliationError("archive collision")
            if active.exists() and guard.private_read(active) == active_raw:
                active.unlink()
            elif active.exists():
                raise ReconciliationError("active.json changed before archive")
            return
        evidence["archive"] = {"status": "archive-intent", "sha256": guard.digest(active_raw), "bytes": len(active_raw)}
        self._save_evidence(evidence)
        if guard.private_read(active) != active_raw:
            raise ReconciliationError("active.json changed before archive")
        guard.private_write(archive, active_raw)
        if guard.private_read(archive) != active_raw:
            raise ReconciliationError("archive readback mismatch")
        if guard.private_read(active) != active_raw:
            raise ReconciliationError("active.json changed before archive")
        active.unlink()
        if active.exists():
            raise ReconciliationError("active.json archive removal not verified")
        evidence["archive"]["status"] = "archived"
        self._save_evidence(evidence)

    def _noop(self, run_id, evidence):
        archive = self.archive_path(run_id)
        if evidence.get("phase") != "complete" or evidence.get("archive", {}).get("status") != "archived":
            raise ReconciliationError("completion evidence incomplete")
        if not archive.is_file() or guard.digest(guard.private_read(archive)) != evidence["archive"]["sha256"]:
            raise ReconciliationError("archived active.json evidence invalid")
        names = guard.unit_names(run_id)
        if (self.store.root / "active.json").exists() or not self.backend.units_absent(names) or self.backend.list_jobs(names):
            raise ReconciliationError("completed reconciliation has residual state")
        return {"phase": "complete", "run_id": run_id, "noop": True}

    def reconcile(self, run_id):
        with self.store.lock(timeout=self.timeout):
            path = self.evidence_path(run_id)
            if path.exists():
                evidence = self._load_evidence(run_id)
                if evidence.get("phase") == "complete":
                    return self._noop(run_id, evidence)
                if evidence.get("boot_id") != self.backend.boot_id():
                    raise ReconciliationError("evidence boot changed; retry refused")
            state = self._load_state(run_id)
            active_raw = self._active(run_id)
            observed = self._restored(state)
            names = guard.unit_names(run_id)
            if path.exists():
                evidence = self._load_evidence(run_id)
                if evidence.get("active_sha256") != guard.digest(active_raw):
                    raise ReconciliationError("active.json differs from reconciliation evidence")
            else:
                journal = self.store.directory(run_id) / "journal.json"
                evidence = {"schema": self.SCHEMA, "run_id": run_id, "phase": "removing", "boot_id": state["boot_id"],
                            "journal_sha256": guard.digest(guard.private_read(journal)), "manifest_sha256": state["manifest_sha256"],
                            "active_sha256": guard.digest(active_raw), "observed": observed,
                            "units": {name: {"status": "present", "sha256": state["unit_sha256"][name]} for name in names},
                            "archive": {"status": "pending"}, "created_monotonic_ns": time.monotonic_ns()}
                self._save_evidence(evidence)
            self._validate_units(state, evidence)
            for name in names:
                self._remove_unit(name, evidence)
            self.backend.daemon_reload()
            if not self.backend.units_absent(names) or self.backend.list_jobs(names):
                raise ReconciliationError("unit cleanup or jobs not verified")
            evidence["cleanup"] = {"status": "verified", "reloads": evidence.get("cleanup", {}).get("reloads", 0) + 1}
            self._save_evidence(evidence)
            self._archive(run_id, active_raw, evidence)
            evidence["phase"] = "complete"
            evidence["completed_monotonic_ns"] = time.monotonic_ns()
            self._save_evidence(evidence)
            return {"phase": "complete", "run_id": run_id, "noop": False}

    def status(self, run_id):
        with self.store.lock(timeout=self.timeout):
            state = self.store.read(run_id)
            evidence = self._load_evidence(run_id) if self.evidence_path(run_id).exists() else None
            return {"run_id": run_id, "phase": state["phase"], "reconciliation": evidence}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("reconcile", "status"))
    parser.add_argument("--state-dir", default="/var/lib/stk-ipv6")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--execute-reviewed-linux", action="store_true")
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args(argv)
    if args.command == "status":
        result = Reconciler(args.state_dir, ReconciliationLinuxBackend(), args.timeout).status(args.run_id)
    else:
        if not args.execute_reviewed_linux or sys.platform != "linux" or os.geteuid() != 0:
            raise ReconciliationError("reconcile requires explicit reviewed Linux/root execution")
        if args.state_dir != "/var/lib/stk-ipv6":
            raise ReconciliationError("one fixed state directory is required for the global operation lock")
        result = Reconciler(args.state_dir, ReconciliationLinuxBackend(), args.timeout).reconcile(args.run_id)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ReconciliationError, guard.GuardError, OSError, ValueError, KeyError, TypeError) as exc:
        print("REFUSED (" + type(exc).__name__ + "): no success claim; inspect private evidence", file=sys.stderr)
        raise SystemExit(2)
