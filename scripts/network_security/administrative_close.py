"""Explicit administrative closure when the legacy IPv4 history is unavailable.

This is not historical reconciliation. The reviewed current IPv4 fingerprint
is accepted by an operator; original journal/manifest bytes remain unchanged.
Only the existing cleanup engine may remove the two owned, quiescent units and
archive the old active pointer. No firewall or persistence writes are added.
"""
import argparse
import json
import os
import re
import sys

try:
    import ipv6_guard as guard
    from reconciliation import Reconciler, ReconciliationError, ReconciliationLinuxBackend, regular_file_present
except ModuleNotFoundError:
    from . import ipv6_guard as guard
    from .reconciliation import Reconciler, ReconciliationError, ReconciliationLinuxBackend, regular_file_present


KIND = "administrative-closure-current-ipv4-accepted"


class AdministrativeCloser(Reconciler):
    """Separate evidence namespace and claim; original reconciliation is intact."""

    def __init__(self, root, backend, *, reviewed_ipv4_sha256, approval_reference,
                 timeout=30, interruption_hook=None):
        # Validate opt-in inputs before Store can create a directory or lock.
        if not isinstance(reviewed_ipv4_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", reviewed_ipv4_sha256):
            raise ReconciliationError("an explicitly reviewed current IPv4 SHA-256 is required")
        if (not isinstance(approval_reference, str)
                or not re.fullmatch(r"https://github\.com/RhianB14/stakeframe/(?:issues|pull)/[1-9][0-9]*#issuecomment-[1-9][0-9]*", approval_reference)):
            raise ReconciliationError("a project issue comment recording explicit authorization is required")
        self.reviewed_ipv4_sha256 = reviewed_ipv4_sha256
        self.approval_reference = approval_reference
        super().__init__(root, backend, timeout=timeout, interruption_hook=interruption_hook)

    def evidence_path(self, run_id):
        guard.chain_name(run_id)
        return self.store.root / ("administrative-closure-" + run_id + ".json")

    def archive_path(self, run_id):
        guard.chain_name(run_id)
        return self.store.root / ("active.administratively-closed-" + run_id + ".json")

    def _load_state(self, run_id):
        # Never adopt, replace or mix evidence from historical reconciliation.
        for path in (Reconciler.evidence_path(self, run_id), Reconciler.archive_path(self, run_id)):
            if regular_file_present(path):
                raise ReconciliationError("historical reconciliation evidence exists; administrative closure refused")
        return super()._load_state(run_id)

    def _validate_ipv4(self, state):
        if guard.digest(self.backend.ipv4_active()) != self.reviewed_ipv4_sha256:
            raise ReconciliationError("current IPv4 differs from the explicitly accepted fingerprint")
        return {"kind": KIND, "run_id": state["run_id"], "boot_id": state["boot_id"],
                "manifest_sha256": state["manifest_sha256"],
                "accepted_current_sha256": self.reviewed_ipv4_sha256,
                "approval_reference": self.approval_reference,
                "prior_ipv4_preservation_proven": False}

    def _validate_restoration(self, state, require_systemd=True, removed=()):
        result = super()._validate_restoration(state, require_systemd=require_systemd, removed=removed)
        if not require_systemd:
            result["ipv4"] = "current-state-accepted; historical-preservation-unproven"
        return result

    def _save_evidence(self, evidence):
        evidence["operation_kind"] = KIND
        evidence["prior_ipv4_preservation_proven"] = False
        super()._save_evidence(evidence)

    def _load_evidence(self, run_id):
        evidence = super()._load_evidence(run_id)
        if (evidence.get("operation_kind") != KIND
                or evidence.get("prior_ipv4_preservation_proven") is not False):
            raise ReconciliationError("administrative closure evidence claim is invalid")
        return evidence

    def close(self, run_id):
        result = self.reconcile(run_id)
        return {"phase": "administratively_closed", "run_id": result["run_id"],
                "noop": result["noop"], "operation_kind": KIND,
                "prior_ipv4_preservation_proven": False,
                "approval_reference": self.approval_reference}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("close",))
    parser.add_argument("--state-dir", default="/var/lib/stk-ipv6")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--reviewed-current-ipv4-sha256", required=True)
    parser.add_argument("--approval-reference", required=True)
    parser.add_argument("--acknowledge-missing-historical-ipv4", action="store_true")
    parser.add_argument("--execute-reviewed-linux", action="store_true")
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args(argv)
    if (not args.execute_reviewed_linux or not args.acknowledge_missing_historical_ipv4
            or sys.platform != "linux" or os.geteuid() != 0):
        raise ReconciliationError("administrative closure requires explicit historical-gap acceptance and reviewed Linux/root execution")
    if args.state_dir != "/var/lib/stk-ipv6":
        raise ReconciliationError("one fixed state directory is required for the global operation lock")
    result = AdministrativeCloser(args.state_dir, ReconciliationLinuxBackend(),
                                  reviewed_ipv4_sha256=args.reviewed_current_ipv4_sha256,
                                  approval_reference=args.approval_reference,
                                  timeout=args.timeout).close(args.run_id)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ReconciliationError, guard.GuardError, OSError, ValueError, KeyError, TypeError) as exc:
        print("REFUSED (" + type(exc).__name__ + "): no closure claim; inspect private evidence", file=sys.stderr)
        raise SystemExit(2)
