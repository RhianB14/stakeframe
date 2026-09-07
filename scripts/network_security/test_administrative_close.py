"""Simulation tests for explicit current-state acceptance, never historical proof."""
import copy
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import ipv6_guard as guard
import test_reconciliation as legacy_tests
import administrative_close as administrative
from reconciliation import ReconciliationError, Reconciler

RUN_ID = legacy_tests.RUN_ID
APPROVAL = "https://github.com/RhianB14/stakeframe/issues/53#issuecomment-123"


class AdministrativeClosureTests(unittest.TestCase):
    def setUp(self):
        legacy_tests.ReconciliationTests.setUp(self)
        self.closer = self.make_closer()

    def make_closer(self, **kwargs):
        return administrative.AdministrativeCloser(self.root, self.backend,
            reviewed_ipv4_sha256=kwargs.get("fingerprint", guard.digest(b"ipv4-active")),
            approval_reference=kwargs.get("approval", APPROVAL), timeout=0.2,
            interruption_hook=kwargs.get("hook"))

    def assert_preserved(self):
        self.assertTrue((self.root / "active.json").exists())
        self.assertEqual(set(self.backend.units), set(self.unit_names))

    def test_closes_without_claiming_history_and_preserves_all_original_bytes(self):
        original = {file.name: file.read_bytes() for file in self.run_dir.iterdir()}
        result = self.closer.close(RUN_ID)
        self.assertEqual(result["phase"], "administratively_closed")
        self.assertIs(result["prior_ipv4_preservation_proven"], False)
        self.assertEqual(result["approval_reference"], APPROVAL)
        self.assertEqual(original, {file.name: file.read_bytes() for file in self.run_dir.iterdir()})
        self.assertEqual(self.closer.archive_path(RUN_ID).read_bytes(), self.active_bytes)
        self.assertFalse((self.root / "active.json").exists())
        self.assertFalse(Reconciler.evidence_path(self.closer, RUN_ID).exists())
        self.assertFalse(Reconciler.archive_path(self.closer, RUN_ID).exists())
        evidence = self.closer._load_evidence(RUN_ID)
        self.assertEqual(evidence["operation_kind"], administrative.KIND)
        self.assertIs(evidence["prior_ipv4_preservation_proven"], False)
        self.assertIs(evidence["ipv4_evidence"]["prior_ipv4_preservation_proven"], False)
        self.assertNotIn("observed_monotonic_ns", evidence["ipv4_evidence"])
        self.assertTrue(self.closer.close(RUN_ID)["noop"])

    def test_legacy_reconciler_still_refuses_post_preparation_observation(self):
        self.reconciler.ipv4_evidence["observed_monotonic_ns"] = 2
        with self.assertRaisesRegex(ReconciliationError, "precede preparation"):
            self.reconciler.reconcile(RUN_ID)
        self.assert_preserved()

    def test_invalid_opt_in_is_rejected_before_state_directory_creation(self):
        root = self.root / "must-not-be-created"
        for fingerprint, approval in [("bad", APPROVAL), ("0" * 64, "approved"), ("0" * 64, "https://example.com/approval")]:
            with self.subTest(fingerprint=fingerprint, approval=approval):
                with self.assertRaises(ReconciliationError):
                    administrative.AdministrativeCloser(root, self.backend,
                        reviewed_ipv4_sha256=fingerprint, approval_reference=approval)
                self.assertFalse(root.exists())

    def test_current_ipv4_drift_blocks_before_any_removal(self):
        self.backend.ipv4_active = lambda: b"changed-ipv4"
        with self.assertRaisesRegex(ReconciliationError, "explicitly accepted fingerprint"):
            self.closer.close(RUN_ID)
        self.assert_preserved()

    def test_ipv6_or_persistence_drift_is_not_accepted(self):
        self.backend.current["policies"]["INPUT"] = "DROP"
        with self.assertRaisesRegex(ReconciliationError, "restoration snapshot"):
            self.closer.close(RUN_ID)
        self.assert_preserved()
        self.backend.current = copy.deepcopy(self.before)
        self.backend.persistence["rules.v4"] = b"changed-persistence"
        with self.assertRaisesRegex(ReconciliationError, "persistence differs"):
            self.closer.close(RUN_ID)
        self.assert_preserved()

    def test_execution_or_pending_timer_remains_a_refusal(self):
        self.backend.readback["service_never_started"] = False
        with self.assertRaisesRegex(ReconciliationError, "execution evidence"):
            self.closer.close(RUN_ID)
        self.assert_preserved()
        self.backend.readback["service_never_started"] = True
        self.backend.readback["timer_stopped"] = False
        with self.assertRaisesRegex(ReconciliationError, "timer state"):
            self.closer.close(RUN_ID)
        self.assert_preserved()

    def test_boot_change_refused(self):
        self.backend.boot = "different-boot"
        with self.assertRaisesRegex(ReconciliationError, "boot changed"):
            self.closer.close(RUN_ID)
        self.assert_preserved()

    def test_other_run_refused(self):
        with self.assertRaisesRegex(ReconciliationError, "outside the reviewed"):
            self.closer.close("0123456789abcdefabcd")
        self.assert_preserved()

    def test_historical_reconciliation_record_cannot_be_adopted(self):
        path = Reconciler.evidence_path(self.closer, RUN_ID)
        guard.private_write(path, b"existing historical operation")
        with self.assertRaisesRegex(ReconciliationError, "historical reconciliation evidence exists"):
            self.closer.close(RUN_ID)
        self.assert_preserved()

    def test_historical_archive_cannot_be_adopted(self):
        path = Reconciler.archive_path(self.closer, RUN_ID)
        guard.private_write(path, self.active_bytes)
        with self.assertRaisesRegex(ReconciliationError, "historical reconciliation evidence exists"):
            self.closer.close(RUN_ID)
        self.assert_preserved()

    def test_owned_unit_hash_still_required(self):
        self.backend.units[self.unit_names[0]] = b"foreign runtime unit"
        with self.assertRaisesRegex(ReconciliationError, "runtime unit hash"):
            self.closer.close(RUN_ID)
        self.assert_preserved()

    def test_ipv4_change_between_unlinks_preserves_remaining_unit_and_pointer(self):
        def change(point, evidence):
            if point == "after-unlink":
                self.backend.ipv4_active = lambda: b"drift-between-unlinks"
        self.closer.interruption_hook = change
        with self.assertRaisesRegex(ReconciliationError, "explicitly accepted fingerprint"):
            self.closer.close(RUN_ID)
        self.assertNotIn(self.unit_names[0], self.backend.units)
        self.assertIn(self.unit_names[1], self.backend.units)
        self.assertTrue((self.root / "active.json").exists())

    def test_resume_cannot_replace_the_accepted_fingerprint(self):
        def interrupt(point, evidence):
            if point == "after-evidence":
                raise OSError("interrupted")
        self.closer.interruption_hook = interrupt
        with self.assertRaises(OSError):
            self.closer.close(RUN_ID)
        self.backend.ipv4_active = lambda: b"new-ipv4"
        replacement = self.make_closer(fingerprint=guard.digest(b"new-ipv4"))
        with self.assertRaisesRegex(ReconciliationError, "reference differs"):
            replacement.close(RUN_ID)
        self.assert_preserved()

    def test_resume_cannot_replace_approval_reference(self):
        self.closer.close(RUN_ID)
        replacement = self.make_closer(approval=APPROVAL + "4")
        with self.assertRaisesRegex(ReconciliationError, "reference differs"):
            replacement.close(RUN_ID)

    def test_tampered_historical_success_claim_is_refused(self):
        self.closer.close(RUN_ID)
        evidence = self.closer._load_evidence(RUN_ID)
        evidence["prior_ipv4_preservation_proven"] = True
        guard.private_write(self.closer.evidence_path(RUN_ID), guard.encoded(evidence))
        with self.assertRaisesRegex(ReconciliationError, "claim is invalid"):
            self.closer.close(RUN_ID)

    def test_missing_archive_blocks_repeat(self):
        self.closer.close(RUN_ID)
        self.closer.archive_path(RUN_ID).unlink()
        with self.assertRaisesRegex(ReconciliationError, "archive missing"):
            self.closer.close(RUN_ID)

    def test_all_durable_interruption_points_resume(self):
        for point in Reconciler.INTERRUPT_POINTS:
            with self.subTest(point=point):
                self.setUp()
                def interrupt(current, evidence):
                    if current == point:
                        raise OSError("interrupted")
                self.closer.interruption_hook = interrupt
                with self.assertRaises(OSError):
                    self.closer.close(RUN_ID)
                self.closer.interruption_hook = None
                self.assertEqual(self.closer.close(RUN_ID)["phase"], "administratively_closed")
                self.assertTrue(self.closer.close(RUN_ID)["noop"])

    def test_cli_requires_both_explicit_flags_without_initializing_backend(self):
        base = ["close", "--run-id", RUN_ID, "--reviewed-current-ipv4-sha256", "0" * 64,
                "--approval-reference", APPROVAL]
        with mock.patch.object(administrative, "ReconciliationLinuxBackend") as backend:
            for flags in [[], ["--execute-reviewed-linux"], ["--acknowledge-missing-historical-ipv4"]]:
                with self.subTest(flags=flags), self.assertRaises(ReconciliationError):
                    administrative.main(base + flags)
            backend.assert_not_called()


if __name__ == "__main__":
    unittest.main()
