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


RUN_ID = "f15efb347860c80f9271"


def load_ipv4_evidence(path):
    evidence_path = Path(path)
    _require_private_file(evidence_path)
    try:
        document = json.loads(guard.private_read(evidence_path))
    except (TypeError, ValueError) as exc:
        raise ReconciliationError("IPv4 evidence document is invalid") from exc
    required = ("schema", "source", "run_id", "boot_id", "manifest_sha256", "observed_monotonic_ns", "active_sha256", "data_file")
    if document.get("schema") != 1 or any(not document.get(key) for key in required[1:]):
        raise ReconciliationError("IPv4 evidence document is incomplete")
    if document["source"] != "external-private-observation":
        raise ReconciliationError("IPv4 evidence source is not a prior private observation")
    data_name = document["data_file"]
    if Path(data_name).name != data_name or "\\" in data_name:
        raise ReconciliationError("IPv4 evidence data file must be an adjacent basename")
    data_path = evidence_path.parent / data_name
    _require_private_file(data_path)
    active_bytes = guard.private_read(data_path)
    if not active_bytes or guard.digest(active_bytes) != document["active_sha256"]:
        raise ReconciliationError("IPv4 evidence data hash mismatch")
    return {**document, "active_bytes": active_bytes}


def _require_private_file(path):
    try:
        info = path.lstat()
    except FileNotFoundError as exc:
        raise ReconciliationError("private IPv4 evidence file is missing") from exc
    if path.is_symlink() or not path.is_file():
        raise ReconciliationError("private IPv4 evidence file is not a regular file")
    if os.name == "posix" and (info.st_uid != os.geteuid() or info.st_mode & 0o077):
        raise ReconciliationError("IPv4 evidence file must be private and user-owned")


class ReconciliationError(guard.GuardError):
    """A reconciliation precondition or verification failed."""


class ReconciliationLinuxBackend:
    """Live backend: reads firewall/persistence and mutates only owned units."""

    def __init__(self, adapter=None, ipv4_reader=None):
        self.adapter = adapter or guard.LinuxAdapter(execute_reviewed=True)
        self.ipv4_reader = ipv4_reader or self._read_ipv4_active
        self.UNIT_DIR = self.adapter.UNIT_DIR

    def _read_ipv4_active(self):
        return self.adapter._call(["/usr/sbin/iptables", "-t", "filter", "-S"]).encode()

    def boot_id(self):
        return self.adapter.boot_id()

    def snapshot(self):
        return self.adapter.snapshot()

    def persistence_files(self):
        return self.adapter.persistence_files()

    def ipv4_active(self):
        """Read active IPv4 state only through an explicitly supplied reader."""
        if self.ipv4_reader is None:
            raise ReconciliationError("independent IPv4 active evidence reader is required")
        try:
            value = self.ipv4_reader()
        except Exception as exc:
            raise ReconciliationError("independent IPv4 active evidence is unreadable") from exc
        if not isinstance(value, (bytes, bytearray)) or not value:
            raise ReconciliationError("independent IPv4 active evidence is empty")
        return bytes(value)

    def _jobs(self, names):
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

    def unit_info(self, name):
        return self.adapter._show(name)

    def read_unit_file(self, name):
        return self.adapter._system_read(self.UNIT_DIR / name)

    def unit_file_exists(self, name):
        path = self.UNIT_DIR / name
        return path.is_file() and not path.is_symlink()

    def list_jobs(self, names):
        return self._jobs(names)

    def units_absent(self, names):
        return all(not self.unit_file_exists(name) and self.unit_info(name).get("LoadState") == "not-found" for name in names)

    def daemon_reload(self):
        self.adapter._call([self.adapter.SYSTEMCTL, "daemon-reload"])

    def remove_unit_file(self, name, expected_sha256):
        path = self.UNIT_DIR / name
        if guard.digest(self.read_unit_file(name)) != expected_sha256:
            raise ReconciliationError("runtime unit hash changed")
        os.unlink(path)
        if self.unit_file_exists(name):
            raise ReconciliationError("unit removal not verified")

    def quiescence_readback(self, state):
        """Read current state without a newly acquired historical reference.

        A reference acquired now cannot prove that an old service never ran.
        This readback therefore accepts only explicit current quiescence and a
        present, parseable timestamp. It never changes missing/unknown to zero.
        Historical positive observations remain refusals.
        """
        names = guard.unit_names(state["run_id"])
        service_name, timer_name = names
        service, timer = self.unit_info(service_name), self.unit_info(timer_name)
        jobs = self._jobs(names)
        if jobs:
            raise ReconciliationError("systemd job remains pending")
        if (service.get("ActiveState"), service.get("SubState")) != ("inactive", "dead"):
            raise ReconciliationError("service is not quiescent")
        if (timer.get("ActiveState"), timer.get("SubState")) != ("inactive", "dead"):
            raise ReconciliationError("timer is not stopped")
        if service.get("Result") != "success" or service.get("ExecMainStatus") != "0":
            raise ReconciliationError("service result is not a clean quiescent result")
        try:
            start_us = guard.service_start_value(service.get("ExecMainStartTimestampMonotonic"))
            next_us = guard.parse_systemd_next_elapse(timer.get("NextElapseUSecMonotonic"))
        except guard.GuardError as exc:
            raise ReconciliationError("systemd history or timer deadline is unknown") from exc
        previous = state.get("systemd_observation", {}).get("service", {}).get("start_us", 0)
        if previous > 0 or start_us > 0:
            raise ReconciliationError("positive service execution evidence blocks reconciliation")
        return {"service": {"active": service["ActiveState"], "sub": service["SubState"], "result": service["Result"], "status": 0, "start_us": start_us},
                "timer": {"active": timer["ActiveState"], "sub": timer["SubState"], "next_us": next_us}, "jobs": []}

    def cleanup_readback(self, names):
        jobs = self._jobs(names)
        if jobs:
            raise ReconciliationError("systemd job remains pending after daemon-reload")
        for name in names:
            if self.unit_file_exists(name):
                raise ReconciliationError("unit file remains after unlink")
            info = self.unit_info(name)
            if info.get("LoadState") != "not-found":
                raise ReconciliationError("daemon-reload did not clear removed unit")
            if info.get("ActiveState") not in (None, "inactive") or info.get("SubState") not in (None, "dead"):
                raise ReconciliationError("removed unit is active")
        return {"units_absent": True, "jobs": []}


class Reconciler:
    """Durable cleanup with explicit intent, readbacks, and safe retry."""

    SCHEMA = 2
    INTERRUPT_POINTS = ("after-evidence", "after-unlink", "after-daemon-reload", "after-archive-create", "after-active-unlink")

    def __init__(self, root, backend, timeout=30, interruption_hook=None, ipv4_evidence=None):
        self.store = guard.Store(root)
        self.backend = backend
        self.timeout = timeout
        self.interruption_hook = interruption_hook
        self.ipv4_evidence = ipv4_evidence

    def evidence_path(self, run_id):
        guard.chain_name(run_id)
        return self.store.root / ("reconciliation-" + run_id + ".json")

    def archive_path(self, run_id):
        guard.chain_name(run_id)
        return self.store.root / ("active.reconciled-" + run_id + ".json")

    def _checkpoint(self, point, evidence):
        if self.interruption_hook is not None:
            self.interruption_hook(point, evidence)

    def _archive_provenance_check(self, run_id, evidence):
        archive = self.archive_path(run_id)
        status = (evidence or {}).get("archive", {}).get("status", "pending")
        if archive.exists() and status == "pending":
            raise ReconciliationError("preexisting archive collision has no prior provenance")
        if archive.exists() and status not in ("archive-intent", "archive-created", "archived"):
            raise ReconciliationError("archive provenance state is invalid")

    def _load_state(self, run_id):
        if run_id != RUN_ID:
            raise ReconciliationError("run identity is outside the reviewed legacy reconciliation scope")
        try:
            state = self.store.read(run_id)
        except FileNotFoundError as exc:
            raise ReconciliationError("run identity or journal missing") from exc
        if state.get("phase") != "rollback_incomplete":
            raise ReconciliationError("run phase is not rollback_incomplete")
        if self.backend.boot_id() != state.get("boot_id"):
            raise ReconciliationError("boot changed; reconciliation refused")
        return state

    def _read_active(self, run_id):
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

    def _validate_ipv4(self, state):
        proof = self.ipv4_evidence
        if not isinstance(proof, dict) or proof.get("run_id") != state["run_id"]:
            raise ReconciliationError("independent IPv4 active evidence is missing or unbound")
        if proof.get("boot_id") != state.get("boot_id"):
            raise ReconciliationError("IPv4 evidence boot binding mismatch")
        if proof.get("manifest_sha256") != state.get("manifest_sha256"):
            raise ReconciliationError("IPv4 evidence manifest binding mismatch")
        raw = proof.get("active_bytes")
        if not isinstance(raw, (bytes, bytearray)) or not raw:
            raise ReconciliationError("IPv4 evidence bytes are missing")
        if guard.digest(bytes(raw)) != proof.get("active_sha256"):
            raise ReconciliationError("IPv4 evidence digest mismatch")
        if proof.get("source") != "external-private-observation" or not proof.get("observed_monotonic_ns"):
            raise ReconciliationError("IPv4 evidence provenance is not a prior private observation")
        current = self.backend.ipv4_active()
        if guard.digest(current) != proof.get("active_sha256"):
            raise ReconciliationError("active IPv4 differs from prior run evidence")
        return {key: value for key, value in proof.items() if key != "active_bytes"}

    def _validate_bundle(self, state):
        directory = self.store.directory(state["run_id"])
        script = directory / "ipv6_guard.py"
        backup = directory / "persistence.before.json"
        if guard.digest(guard.private_read(script)) != state.get("script_sha256"):
            raise ReconciliationError("original rollback script hash mismatch")
        if guard.digest(guard.private_read(backup)) != state.get("backup_sha256"):
            raise ReconciliationError("original persistence backup hash mismatch")
        names = guard.unit_names(state["run_id"])
        for name in names:
            if guard.digest(guard.private_read(directory / name)) != state["unit_sha256"].get(name):
                raise ReconciliationError("bundle unit hash mismatch")
        return names

    def _validate_restoration(self, state, require_systemd=True):
        if self.backend.snapshot() != state.get("before"):
            raise ReconciliationError("restoration snapshot differs from bundle before")
        expected = state.get("persistence_sha256", {})
        actual = {name: None if data is None else guard.digest(data) for name, data in self.backend.persistence_files().items()}
        if actual != expected:
            raise ReconciliationError("persistence differs from bundle")
        self._validate_ipv4(state)
        if require_systemd:
            observed = self.backend.quiescence_readback(state)
            if observed.get("timer", {}).get("next_us") != 0:
                raise ReconciliationError("timer next_us must be zero")
            if observed.get("jobs"):
                raise ReconciliationError("systemd jobs remain pending")
            return observed
        return {"snapshot": "match", "persistence": "match", "ipv4": "match"}

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

    def _validate_evidence_links(self, state, evidence, active_raw=None):
        if evidence.get("manifest_sha256") != state.get("manifest_sha256"):
            raise ReconciliationError("reconciliation evidence manifest link mismatch")
        manifest_path = self.store.directory(state["run_id"]) / "manifest.json"
        manifest_raw = guard.private_read(manifest_path)
        if guard.digest(manifest_raw) != state.get("manifest_sha256"):
            raise ReconciliationError("manifest integrity mismatch")
        manifest = json.loads(manifest_raw)
        if any(state.get(key) != value for key, value in manifest.items()):
            raise ReconciliationError("journal/manifest identity mismatch")
        journal = self.store.directory(state["run_id"]) / "journal.json"
        if guard.digest(guard.private_read(journal)) != evidence.get("journal_sha256"):
            raise ReconciliationError("reconciliation evidence journal link mismatch")
        if evidence.get("boot_id") != self.backend.boot_id():
            raise ReconciliationError("reconciliation evidence boot mismatch")
        if active_raw is not None and evidence.get("active_sha256") != guard.digest(active_raw):
            raise ReconciliationError("active.json differs from reconciliation evidence")
        self._validate_bundle(state)
        self._validate_ipv4(state)
        self._validate_restoration(state, require_systemd=False)

    def _validate_units(self, state, evidence):
        """Remove only units journaled as acquired and installed by the old run."""
        directory = self.store.directory(state["run_id"])
        journal_units = state.get("units", {})
        names = guard.unit_names(state["run_id"])
        for name in names:
            record = journal_units.get(name, {})
            if record.get("acquired") is not True or record.get("installed") is not True:
                raise ReconciliationError("unit ownership acquisition evidence missing")
            entry = evidence["units"].get(name)
            if not isinstance(entry, dict):
                raise ReconciliationError("unit evidence missing")
            status = entry.get("status")
            bundle_hash = state["unit_sha256"].get(name)
            bundle_path = directory / name
            if not bundle_path.is_file() or bundle_path.is_symlink():
                raise ReconciliationError("original bundle unit unavailable during retry")
            if guard.digest(guard.private_read(bundle_path)) != bundle_hash or entry.get("sha256") != bundle_hash:
                raise ReconciliationError("unit evidence or bundle hash mismatch")
            if status in ("remove-intent", "unlinked"):
                if self.backend.unit_file_exists(name):
                    if status == "unlinked":
                        raise ReconciliationError("unit reappeared after unlink")
                elif status == "remove-intent":
                    entry["status"] = "unlinked"
                    self._save_evidence(evidence)
                continue
            if status != "present":
                raise ReconciliationError("unknown unit evidence state")
            info = self.backend.unit_info(name)
            expected_path = str(self.backend.UNIT_DIR / name)
            if info.get("LoadState") != "loaded" or info.get("FragmentPath") != expected_path:
                raise ReconciliationError("unit ownership/path mismatch")
            if guard.digest(self.backend.read_unit_file(name)) != bundle_hash:
                raise ReconciliationError("runtime unit hash mismatch")
        return names

    def _remove_unit(self, name, evidence):
        entry = evidence["units"][name]
        if entry["status"] == "unlinked":
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
        self._checkpoint("after-unlink", evidence)
        if self.backend.unit_file_exists(name):
            raise ReconciliationError("unit file remains after unlink")
        entry["status"] = "unlinked"
        self._save_evidence(evidence)

    def _write_exclusive(self, path, raw):
        if path.exists():
            raise ReconciliationError("archive collision")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
        except Exception:
            try:
                path.unlink()
            except FileNotFoundError:
                pass
            raise

    def _archive(self, run_id, active_raw, evidence):
        active, archive = self.store.root / "active.json", self.archive_path(run_id)
        archive_state = evidence.get("archive", {}).get("status", "pending")
        if archive_state == "pending":
            if archive.exists():
                raise ReconciliationError("preexisting archive collision has no prior provenance")
            evidence["archive"] = {"status": "archive-intent", "sha256": guard.digest(active_raw), "bytes": len(active_raw)}
            self._save_evidence(evidence)
            archive_state = "archive-intent"
        if evidence["archive"].get("sha256") != guard.digest(active_raw):
            raise ReconciliationError("archive evidence bytes mismatch")
        if evidence.get("archive", {}).get("status") == "archive-intent":
            if not archive.exists():
                if not active.exists() or guard.private_read(active) != active_raw:
                    raise ReconciliationError("active.json changed before archive retry")
                self._write_exclusive(archive, active_raw)
                self._checkpoint("after-archive-create", evidence)
            if guard.private_read(archive) != active_raw:
                raise ReconciliationError("archive readback mismatch")
            evidence["archive"]["status"] = "archive-created"
            self._save_evidence(evidence)
        if evidence["archive"]["status"] != "archive-created":
            if evidence["archive"]["status"] == "archived":
                return
            raise ReconciliationError("unknown archive evidence state")
        if active.exists():
            if guard.private_read(active) != active_raw:
                raise ReconciliationError("active.json changed before removal")
            active.unlink()
            self._checkpoint("after-active-unlink", evidence)
        elif guard.private_read(archive) != active_raw:
            raise ReconciliationError("archive provenance readback mismatch")
        if active.exists():
            raise ReconciliationError("active.json removal not verified")
        evidence["archive"]["status"] = "archived"
        self._save_evidence(evidence)

    def _noop(self, run_id, evidence):
        state = self._load_state(run_id)
        self._validate_evidence_links(state, evidence)
        self._validate_restoration(state, require_systemd=False)
        archive = self.archive_path(run_id)
        if evidence.get("archive", {}).get("status") != "archived" or not archive.is_file():
            raise ReconciliationError("completion evidence incomplete")
        if (self.store.root / "active.json").exists():
            raise ReconciliationError("completed reconciliation has residual active.json")
        if guard.digest(guard.private_read(archive)) != evidence["archive"].get("sha256"):
            raise ReconciliationError("archived active.json evidence invalid")
        self._validate_units(state, evidence)
        names = guard.unit_names(run_id)
        if (self.store.root / "active.json").exists() or not self.backend.units_absent(names) or self.backend.list_jobs(names):
            raise ReconciliationError("completed reconciliation has residual state")
        return {"phase": "complete", "run_id": run_id, "noop": True}

    def reconcile(self, run_id):
        with self.store.lock(timeout=self.timeout):
            path = self.evidence_path(run_id)
            evidence = self._load_evidence(run_id) if path.exists() else None
            if evidence is not None:
                evidence = self._load_evidence(run_id)
                self._archive_provenance_check(run_id, evidence)
                if evidence.get("phase") == "complete":
                    return self._noop(run_id, evidence)
                if evidence.get("boot_id") != self.backend.boot_id():
                    raise ReconciliationError("evidence boot changed; retry refused")
            state = self._load_state(run_id)
            self._archive_provenance_check(run_id, evidence)
            active_path = self.store.root / "active.json"
            active_raw = None if evidence and evidence.get("archive", {}).get("status") in ("archive-created", "archived") and not active_path.exists() else self._read_active(run_id)
            if active_raw is None:
                archive_path = self.archive_path(run_id)
                if not archive_path.is_file():
                    raise ReconciliationError("archived active.json provenance missing")
                active_raw = guard.private_read(archive_path)
            if path.exists():
                evidence = self._load_evidence(run_id)
                self._validate_evidence_links(state, evidence, active_raw)
                self._validate_restoration(state, require_systemd=True)
            else:
                observed = self._validate_restoration(state, require_systemd=True)
                names = self._validate_bundle(state)
                journal = self.store.directory(run_id) / "journal.json"
                evidence = {"schema": self.SCHEMA, "run_id": run_id, "phase": "removing", "boot_id": state["boot_id"],
                            "journal_sha256": guard.digest(guard.private_read(journal)), "manifest_sha256": state["manifest_sha256"],
                            "active_sha256": guard.digest(active_raw), "observed": observed,
                            "units": {name: {"status": "present", "sha256": state["unit_sha256"][name]} for name in names},
                            "cleanup": {"status": "pending"}, "archive": {"status": "pending"},
                            "created_monotonic_ns": time.monotonic_ns()}
                self._save_evidence(evidence)
                self._checkpoint("after-evidence", evidence)
            names = self._validate_units(state, evidence)
            if evidence.get("cleanup", {}).get("status") == "verified":
                self._validate_restoration(state, require_systemd=False)
                cleanup = self.backend.cleanup_readback(names)
                evidence["cleanup"]["readback"] = cleanup
                self._save_evidence(evidence)
                self._archive(run_id, active_raw, evidence)
            else:
                for name in names:
                    self._remove_unit(name, evidence)
                self.backend.daemon_reload()
                self._checkpoint("after-daemon-reload", evidence)
                cleanup = self.backend.cleanup_readback(names)
                evidence["cleanup"] = {"status": "verified", "readback": cleanup}
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
    parser.add_argument("--ipv4-evidence")
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args(argv)
    ipv4_evidence = load_ipv4_evidence(args.ipv4_evidence) if args.ipv4_evidence else None
    if args.command == "status":
        result = Reconciler(args.state_dir, ReconciliationLinuxBackend(), args.timeout, ipv4_evidence=ipv4_evidence).status(args.run_id)
    else:
        if not args.execute_reviewed_linux or sys.platform != "linux" or os.geteuid() != 0:
            raise ReconciliationError("reconcile requires explicit reviewed Linux/root execution")
        if args.state_dir != "/var/lib/stk-ipv6":
            raise ReconciliationError("one fixed state directory is required for the global operation lock")
        result = Reconciler(args.state_dir, ReconciliationLinuxBackend(), args.timeout, ipv4_evidence=ipv4_evidence).reconcile(args.run_id)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ReconciliationError, guard.GuardError, OSError, ValueError, KeyError, TypeError) as exc:
        print("REFUSED (" + type(exc).__name__ + "): no success claim; inspect private evidence", file=sys.stderr)
        raise SystemExit(2)
