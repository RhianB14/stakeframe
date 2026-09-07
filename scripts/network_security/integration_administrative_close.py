"""Exercise administrative closure against disposable systemd, fictional firewall."""
import unittest

try:
    import ipv6_guard as guard
    import integration_reconciliation as legacy
    from administrative_close import AdministrativeCloser, KIND
except ModuleNotFoundError:
    from . import ipv6_guard as guard
    from . import integration_reconciliation as legacy
    from .administrative_close import AdministrativeCloser, KIND


class AdministrativeClosureSystemdIntegration(legacy.ReconciliationSystemdIntegration):
    def setUp(self):
        super().setUp()
        self.reconciler = AdministrativeCloser(self.root, self.backend, timeout=10,
            reviewed_ipv4_sha256=guard.digest(self.backend.simulated_ipv4),
            approval_reference="https://github.com/RhianB14/stakeframe/issues/53#issuecomment-123")

    def _assert_complete(self):
        super()._assert_complete()
        result = self.reconciler.close(legacy.RUN_ID)
        self.assertEqual(result["phase"], "administratively_closed")
        self.assertTrue(result["noop"])
        self.assertIs(result["prior_ipv4_preservation_proven"], False)
        evidence = self.reconciler._load_evidence(legacy.RUN_ID)
        self.assertEqual(evidence["operation_kind"], KIND)


if __name__ == "__main__":
    legacy.require_disposable_systemd()
    unittest.main()
