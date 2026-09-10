"""Simulation ONLY. No subprocess, privilege escalation, firewall or networking."""
import contextlib
import copy
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

# An accidental call from the production Linux adapter must fail before spawning.
PROCESS_GUARDS = [patch.object(subprocess, "Popen", side_effect=AssertionError("REAL SUBPROCESS FORBIDDEN")),
                  patch.object(os, "system", side_effect=AssertionError("REAL SHELL FORBIDDEN"))]
for guard in PROCESS_GUARDS:
    guard.start()
sys.path.insert(0, str(Path(__file__).parent))
try:
    import ipv6_persistence as persistence
except ModuleNotFoundError:
    persistence = None

REPO = Path(__file__).resolve().parents[2]
UNIT = REPO / "infra" / "systemd" / "stk6-ipv6-persistence.service"


class FakeLinux:
    """Deterministic in-memory ip6tables-nft double.

    ``apply_transaction`` reproduces the validated backend semantics: the whole
    document is parsed and validated first, then committed atomically.
    """

    def __init__(self):
        self.policies = {"INPUT": "ACCEPT", "FORWARD": "ACCEPT", "OUTPUT": "ACCEPT"}
        self.chains = {"INPUT": [], "FORWARD": [], "OUTPUT": [],
                       "DOCKER-FORWARD": [["-o", "eth0", "-j", "ACCEPT"]],
                       "f2b-sshd": [["-j", "RETURN"]]}
        # Untouched sentinels proving IPv4/NAT/OUTPUT are never rewritten.
        self.ipv4 = {"INPUT": ["-j", "ACCEPT"], "DOCKER": [["-j", "DOCKER-BRIDGE"]]}
        self.files = {"/etc/iptables/rules.v4": b"*filter\n:INPUT ACCEPT\nCOMMIT\n",
                      "/etc/iptables/rules.v6": b"*filter\n:INPUT ACCEPT\nCOMMIT\n",
                      "/etc/default/netfilter-persistent": None,
                      "/etc/default/iptables": None}
        self.boot = "boot-A"
        self.now = 1_000_000_000
        self.transactions = []
        self.fail_before = None
        self.fail_after = None
        self.after_commit_hook = None

    # --- adapter surface -------------------------------------------------
    def validate_host(self):
        return None

    def boot_id(self):
        return self.boot

    def monotonic_ns(self):
        self.now += 1_000_000
        return self.now

    def snapshot(self):
        return {"policies": dict(self.policies), "chains": copy.deepcopy(self.chains)}

    def persistence_files(self):
        return dict(self.files)

    def apply_transaction(self, document):
        self.transactions.append(document)
        staged = copy.deepcopy(self.chains)
        staged_policies = dict(self.policies)
        for line in document.splitlines():
            line = line.strip()
            if not line or line.startswith("*") or line == "COMMIT":
                continue
            if line.startswith(":"):
                name, _, rest = line[1:].partition(" ")
                staged_policies[name] = rest.split(" ")[0]
            elif line.startswith("-N "):
                name = line[3:]
                if name in staged:
                    raise persistence.PersistenceError("Chain already exists.")
                staged[name] = []
            elif line.startswith("-F "):
                staged[line[3:]] = []
            elif line.startswith("-X "):
                name = line[3:]
                if staged.get(name) or any(name in rule for rules in staged.values() for rule in rules):
                    raise persistence.PersistenceError("chain is still referenced")
                del staged[name]
            elif line.startswith("-A "):
                name, _, spec = line[3:].partition(" ")
                if name not in staged:
                    raise persistence.PersistenceError("no chain/target/match by that name")
                staged[name].append(spec.split(" "))
            elif line.startswith("-I "):
                name, _, spec = line[3:].partition(" ")
                number, _, rule = spec.partition(" ")
                staged[name].insert(int(number) - 1, rule.split(" "))
            elif line.startswith("-D "):
                name, _, spec = line[3:].partition(" ")
                staged[name].remove(spec.split(" "))
            elif line.startswith("-P "):
                name, _, value = line[3:].partition(" ")
                staged_policies[name] = value
            else:
                raise persistence.PersistenceError("unexpected restore line")
        if self.fail_before:
            self.fail_before = None  # Fires exactly once, before any commit.
            raise persistence.PersistenceError("simulated failure before commit")
        self.chains, self.policies = staged, staged_policies
        if self.after_commit_hook:
            hook, self.after_commit_hook = self.after_commit_hook, None
            hook()
        if self.fail_after:
            self.fail_after = None  # A lost acknowledgement fires exactly once.
            raise persistence.PersistenceError("simulated lost acknowledgement after commit")

    # --- helpers ---------------------------------------------------------
    def owned(self):
        return persistence.CHAIN in self.chains

    def foreign_intact(self):
        return (self.chains["DOCKER-FORWARD"] == [["-o", "eth0", "-j", "ACCEPT"]]
                and self.chains["f2b-sshd"] == [["-j", "RETURN"]]
                and self.chains["OUTPUT"] == [])


class Base(unittest.TestCase):
    def setUp(self):
        self.assertTrue(persistence is not None, "IPv6 persistence implementation is missing")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "state"
        self.backend = FakeLinux()
        self.controller = persistence.Controller(self.root, self.backend)
        self.ipv4_sentinel = copy.deepcopy(self.backend.ipv4)
        self.files_sentinel = dict(self.backend.files)

    def assert_no_mutation(self, snapshot):
        """The whole host state must be untouched after a refusal."""
        self.assertEqual(self.backend.snapshot(), snapshot)
        self.assertEqual(self.backend.ipv4, self.ipv4_sentinel)
        self.assertEqual(self.backend.files, self.files_sentinel)

    def craft_record(self, name, **overrides):
        document = {"schema": persistence.SCHEMA, "policy_version": persistence.POLICY_VERSION,
                    "boot_id": self.backend.boot_id(),
                    "controller_sha256": persistence.controller_sha256(),
                    "policy_sha256": persistence.policy_sha256(),
                    "chain": persistence.CHAIN, "tag": persistence.TAG,
                    "before_policies": {"INPUT": "ACCEPT", "FORWARD": "ACCEPT"},
                    "phase": "applied"}
        document.update(overrides)
        self.controller.store.write_record(name, document)
        return document

    def crash_after_commit(self, phase="applying", **overrides):
        """Reproduce a process death between the firewall commit and the receipt."""
        self.backend.apply_transaction(persistence.apply_transaction_text())
        record = {"schema": persistence.SCHEMA, "policy_version": persistence.POLICY_VERSION,
                  "boot_id": self.backend.boot_id(),
                  "controller_sha256": persistence.controller_sha256(),
                  "policy_sha256": persistence.policy_sha256(),
                  "chain": persistence.CHAIN, "tag": persistence.TAG,
                  "before_policies": {"INPUT": "ACCEPT", "FORWARD": "ACCEPT"},
                  "phase": phase}
        record.update(overrides)
        if record.get("_drop", False):
            record.pop("_drop")
            return record
        self.controller.store.write_record("journal.json", record)
        return record

    @contextlib.contextmanager
    def inject_write_failure(self, target_name=None, stage="write", occurrence=1):
        """Fail the n-th write/fsync/replace of a record file, exactly once."""
        real_write = persistence.private_write
        state = {"seen": 0, "fired": False}

        def wrapper(path, data):
            name = Path(path).name
            if not state["fired"] and (target_name is None or name == target_name):
                state["seen"] += 1
                if state["seen"] >= occurrence:
                    state["fired"] = True
                    if stage == "write":
                        raise OSError("injected write failure: " + name)
                    if stage == "fsync":
                        with patch.object(os, "fsync", side_effect=OSError("injected fsync failure: " + name)):
                            return real_write(path, data)
                    if stage == "replace":
                        with patch.object(os, "replace", side_effect=OSError("injected replace failure: " + name)):
                            return real_write(path, data)
                    raise AssertionError("unknown injection stage")
            return real_write(path, data)

        with patch.object(persistence, "private_write", wrapper):
            yield state

    def journal_phase(self):
        return json.loads((self.root / "journal.json").read_text())["phase"]


# ---------------------------------------------------------------- rules
class PolicyTests(Base):
    def test_policy_matches_the_documented_matrix(self):
        policy = persistence.policy_document()
        self.assertEqual(policy["chain"], "STK6_BOOT")
        self.assertEqual(policy["policies"], {"INPUT": "DROP", "FORWARD": "DROP", "OUTPUT": "preserved"})
        rules = policy["rules"]
        self.assertEqual(len(rules), 5)
        self.assertEqual(rules[0][:2], ["-i", "lo"])
        self.assertIn("ESTABLISHED,RELATED", rules[1])
        self.assertIn("ipv6-icmp", rules[2])
        self.assertIn("22", rules[3])
        self.assertEqual(rules[-1][-2:], ["-j", "DROP"])
        self.assertNotIn("RETURN", sum(rules, []))

    def test_transaction_is_one_atomic_document(self):
        document = persistence.apply_transaction_text()
        self.assertEqual(document.count("*filter"), 1)
        self.assertEqual(document.count("COMMIT"), 1)
        self.assertIn("-I INPUT 1", document)
        self.assertIn(":INPUT DROP [0:0]", document)
        self.assertIn(":FORWARD DROP [0:0]", document)
        # No IPv4/NAT/OUTPUT rewriting and no full-ruleset restore instruction.
        self.assertNotIn("OUTPUT", document)
        self.assertNotIn("nat", document)
        self.assertNotIn("flush", document)

    def test_plan_is_offline_and_write_free(self):
        result = persistence.plan()
        self.assertEqual(result["writes"], "none")
        self.assertEqual(result["ordering"]["after"], ["netfilter-persistent.service"])
        self.assertEqual(result["ordering"]["before"], ["docker.service", "network-online.target"])
        self.assertEqual(persistence.main(["plan"]), 0)


# ---------------------------------------------------------------- state machine
class ApplyTests(Base):
    def test_clean_application_and_preservation(self):
        result = self.controller.apply_on_boot()
        self.assertEqual(result["phase"], "applied")
        self.assertTrue(self.backend.owned())
        self.assertEqual(self.backend.policies["INPUT"], "DROP")
        self.assertEqual(self.backend.policies["FORWARD"], "DROP")
        self.assertEqual(self.backend.policies["OUTPUT"], "ACCEPT")
        self.assertTrue(self.backend.foreign_intact())
        self.assertEqual(self.backend.ipv4, self.ipv4_sentinel)
        self.assertEqual(self.backend.chains["INPUT"][0], persistence.owned_jump())
        self.assertTrue(self.root.joinpath("receipt.json").exists())

    def test_repeated_application_is_a_noop(self):
        self.controller.apply_on_boot()
        before = copy.deepcopy(self.backend.chains)
        result = self.controller.apply_on_boot()
        self.assertEqual(result["phase"], "no-op")
        self.assertEqual(result["writes"], "none")
        self.assertEqual(self.backend.chains, before)

    def test_unknown_stk6_chain_is_refused(self):
        self.backend.chains["STK6_FOREIGN"] = [["-j", "RETURN"]]
        with self.assertRaisesRegex(persistence.PersistenceError, "unknown STK6"):
            self.controller.apply_on_boot()

    def test_partial_owned_chain_is_refused(self):
        self.backend.chains[persistence.CHAIN] = [["-i", "lo", "-j", "ACCEPT"]]
        with self.assertRaisesRegex(persistence.PersistenceError, "partial or foreign"):
            self.controller.apply_on_boot()

    def test_duplicate_input_reference_is_refused(self):
        self.controller.apply_on_boot()
        self.backend.chains["INPUT"].append(persistence.owned_jump())
        before = self.backend.snapshot()
        with self.assertRaisesRegex(persistence.PersistenceError, "exactly once"):
            self.controller.apply_on_boot()
        self.assert_no_mutation(before)

    def test_displaced_input_reference_is_refused(self):
        self.controller.apply_on_boot()
        # A foreign rule ahead of the owned reference must not be skipped.
        self.backend.chains["INPUT"].insert(0, ["-p", "ipv6-icmp", "-j", "ACCEPT"])
        before = self.backend.snapshot()
        with self.assertRaisesRegex(persistence.PersistenceError, "reviewed position"):
            self.controller.apply_on_boot()
        self.assert_no_mutation(before)

    def test_unexpected_policy_is_refused(self):
        self.backend.policies["INPUT"] = "REJECT"
        with self.assertRaisesRegex(persistence.PersistenceError, "unsupported IPv6 policy"):
            self.controller.apply_on_boot()

    def test_divergent_policy_without_chain_is_refused(self):
        self.backend.policies["FORWARD"] = "DROP"
        with self.assertRaisesRegex(persistence.PersistenceError, "divergent policy"):
            self.controller.apply_on_boot()

    def test_persisted_delta_blocks_application(self):
        self.backend.files["/etc/iptables/rules.v6"] = b"*filter\n-A INPUT -j STK6_BOOT\nCOMMIT\n"
        with self.assertRaisesRegex(persistence.PersistenceError, "persistence file"):
            self.controller.apply_on_boot()
        self.assertFalse(self.backend.owned())

    def test_failure_before_commit_leaves_no_partial_state(self):
        self.backend.fail_before = True
        with self.assertRaisesRegex(persistence.PersistenceError, "before any commit"):
            self.controller.apply_on_boot()
        self.assertFalse(self.backend.owned())
        self.assertEqual(self.backend.policies["INPUT"], "ACCEPT")
        self.assertTrue(self.backend.foreign_intact())
        self.assertEqual(self.journal_phase(), "failed")

    def test_failure_after_acquisition_rolls_back_only_the_owned_delta(self):
        self.backend.fail_after = True
        with self.assertRaisesRegex(persistence.PersistenceError, "owned delta was rolled back"):
            self.controller.apply_on_boot()
        self.assertFalse(self.backend.owned())
        self.assertEqual(self.backend.policies["INPUT"], "ACCEPT")
        self.assertEqual(self.backend.policies["FORWARD"], "ACCEPT")
        self.assertTrue(self.backend.foreign_intact())
        self.assertEqual(self.journal_phase(), "failed_rolled_back")
        self.assertIsNone(self.controller.store.receipt())

    def test_simulated_reboot_with_previous_persistent_state(self):
        self.controller.apply_on_boot()
        receipt = json.loads((self.root / "receipt.json").read_text())
        self.assertEqual(receipt["boot_id"], "boot-A")
        # Reboot: the delta is not persistent, so the host returns to the
        # pre-existing ruleset; only the private state directory survives.
        self.backend.boot = "boot-B"
        self.backend.chains = {"INPUT": [], "FORWARD": [], "OUTPUT": [], "DOCKER-FORWARD": [["-o", "eth0", "-j", "ACCEPT"]]}
        self.backend.policies = {"INPUT": "ACCEPT", "FORWARD": "ACCEPT", "OUTPUT": "ACCEPT"}
        result = self.controller.apply_on_boot()
        self.assertEqual(result["phase"], "applied")
        self.assertTrue(self.backend.owned())

    def test_applied_state_with_receipt_from_another_boot_is_refused(self):
        self.controller.apply_on_boot()
        self.backend.boot = "boot-B"
        before = self.backend.snapshot()
        with self.assertRaisesRegex(persistence.PersistenceError, "another boot"):
            self.controller.apply_on_boot()
        self.assert_no_mutation(before)

    def test_divergent_controller_hash_is_refused(self):
        self.controller.apply_on_boot()
        self.craft_record("receipt.json", controller_sha256="0" * 64)
        before = self.backend.snapshot()
        with self.assertRaisesRegex(persistence.PersistenceError, "controller hash"):
            self.controller.apply_on_boot()
        self.assert_no_mutation(before)

    def test_tampered_or_truncated_receipt_is_refused(self):
        self.controller.apply_on_boot()
        raw = (self.root / "receipt.json").read_bytes()
        persistence.private_write(self.root / "receipt.json", raw[:-12])
        with self.assertRaisesRegex(persistence.PersistenceError, "truncated or tampered"):
            self.controller.status()
        before = self.backend.snapshot()
        with self.assertRaisesRegex(persistence.PersistenceError, "truncated or tampered"):
            self.controller.apply_on_boot()
        self.assert_no_mutation(before)

    def test_applied_state_without_receipt_or_journal_is_refused(self):
        self.backend.apply_transaction(persistence.apply_transaction_text())
        before = self.backend.snapshot()
        with self.assertRaisesRegex(persistence.PersistenceError, "refuse adoption"):
            self.controller.apply_on_boot()
        self.assert_no_mutation(before)
        self.assertTrue(self.backend.owned())


# ------------------------------------------------- post-commit failure coverage
class PostAcquisitionFailureTests(Base):
    """Failures after the firewall commit must never leave a false success."""

    def assert_failed_and_clean(self):
        self.assertFalse(self.backend.owned())
        self.assertEqual(self.backend.policies["INPUT"], "ACCEPT")
        self.assertEqual(self.backend.policies["FORWARD"], "ACCEPT")
        self.assertTrue(self.backend.foreign_intact())
        self.assertEqual(self.journal_phase(), "failed_rolled_back")
        # No valid applied receipt may survive a persistence-failure rollback.
        self.assertIsNone(self.controller.store.receipt())

    def test_receipt_write_failure_rolls_back(self):
        with self.inject_write_failure("receipt.json", "write"):
            with self.assertRaisesRegex(persistence.PersistenceError, "owned delta was rolled back"):
                self.controller.apply_on_boot()
        self.assert_failed_and_clean()

    def test_receipt_sidecar_write_failure_rolls_back(self):
        with self.inject_write_failure("receipt.json.sha256", "write"):
            with self.assertRaisesRegex(persistence.PersistenceError, "owned delta was rolled back"):
                self.controller.apply_on_boot()
        self.assert_failed_and_clean()

    def test_receipt_fsync_failure_rolls_back(self):
        with self.inject_write_failure("receipt.json", "fsync"):
            with self.assertRaisesRegex(persistence.PersistenceError, "owned delta was rolled back"):
                self.controller.apply_on_boot()
        self.assert_failed_and_clean()

    def test_receipt_replace_failure_rolls_back(self):
        with self.inject_write_failure("receipt.json", "replace"):
            with self.assertRaisesRegex(persistence.PersistenceError, "owned delta was rolled back"):
                self.controller.apply_on_boot()
        self.assert_failed_and_clean()

    def test_acquisition_journal_write_failure_rolls_back(self):
        with self.inject_write_failure("journal.json", "write", occurrence=2):
            with self.assertRaisesRegex(persistence.PersistenceError, "owned delta was rolled back"):
                self.controller.apply_on_boot()
        self.assert_failed_and_clean()

    def test_failed_rollback_is_reported_as_rollback_required(self):
        self.backend.fail_after = True
        # External drift appears right after the commit, before any recovery rollback.
        self.backend.after_commit_hook = lambda: self.backend.chains[persistence.CHAIN].append(["-j", "RETURN"])
        with self.assertRaisesRegex(persistence.PersistenceError, "rollback_required"):
            self.controller.apply_on_boot()
        # Nothing was overwritten and the drift is still visible.
        self.assertIn(["-j", "RETURN"], self.backend.chains[persistence.CHAIN])
        self.assertEqual(self.journal_phase(), "rollback_required")

    def test_rollback_terminal_receipt_failure_is_visible_and_keeps_the_result(self):
        self.controller.apply_on_boot()
        with self.inject_write_failure("receipt.json", "write"):
            with self.assertRaisesRegex(persistence.PersistenceError, "could not be persisted"):
                self.controller.rollback()
        # The firewall result is preserved and recorded as unrecorded.
        self.assertFalse(self.backend.owned())
        self.assertEqual(self.backend.policies["INPUT"], "ACCEPT")
        self.assertEqual(self.journal_phase(), "rolled_back_unrecorded")


# ---------------------------------------------------------------- crash recovery
class CrashRecoveryTests(Base):
    def assert_interrupted_clean(self):
        self.assertFalse(self.backend.owned())
        self.assertEqual(self.backend.policies["INPUT"], "ACCEPT")
        self.assertEqual(self.backend.policies["FORWARD"], "ACCEPT")
        self.assertTrue(self.backend.foreign_intact())
        self.assertIsNone(self.controller.store.receipt())

    def test_crash_with_applying_journal_recovers_by_rollback(self):
        self.crash_after_commit("applying")
        with self.assertRaisesRegex(persistence.PersistenceError, "interrupted"):
            self.controller.apply_on_boot()
        self.assert_interrupted_clean()
        self.assertEqual(self.journal_phase(), "interrupted_rolled_back")
        # A later run on the now-clean state applies safely.
        self.assertEqual(self.controller.apply_on_boot()["phase"], "applied")
        self.assertTrue(self.backend.owned())

    def test_crash_with_acquired_journal_recovers_by_rollback(self):
        self.crash_after_commit("acquired")
        with self.assertRaisesRegex(persistence.PersistenceError, "interrupted"):
            self.controller.apply_on_boot()
        self.assert_interrupted_clean()
        self.assertEqual(self.journal_phase(), "interrupted_rolled_back")

    def test_applied_delta_without_recovery_journal_is_refused_without_mutation(self):
        self.crash_after_commit(_drop=True)
        before = self.backend.snapshot()
        with self.assertRaisesRegex(persistence.PersistenceError, "refuse adoption"):
            self.controller.apply_on_boot()
        self.assert_no_mutation(before)
        self.assertTrue(self.backend.owned())

    def test_journal_from_another_boot_is_refused_without_mutation(self):
        self.crash_after_commit("applying", boot_id="boot-Z")
        before = self.backend.snapshot()
        with self.assertRaisesRegex(persistence.PersistenceError, "refuse adoption"):
            self.controller.apply_on_boot()
        self.assert_no_mutation(before)

    def test_journal_with_divergent_controller_hash_is_refused_without_mutation(self):
        self.crash_after_commit("applying", controller_sha256="0" * 64)
        before = self.backend.snapshot()
        with self.assertRaisesRegex(persistence.PersistenceError, "refuse adoption"):
            self.controller.apply_on_boot()
        self.assert_no_mutation(before)

    def test_tampered_journal_is_refused_without_mutation(self):
        self.crash_after_commit("applying")
        raw = (self.root / "journal.json").read_bytes()
        persistence.private_write(self.root / "journal.json", raw[:-9])
        before = self.backend.snapshot()
        with self.assertRaisesRegex(persistence.PersistenceError, "truncated or tampered"):
            self.controller.apply_on_boot()
        self.assert_no_mutation(before)

    def test_terminal_journal_phase_does_not_trigger_recovery(self):
        self.crash_after_commit("failed")
        before = self.backend.snapshot()
        with self.assertRaisesRegex(persistence.PersistenceError, "interrupted attempt"):
            self.controller.apply_on_boot()
        self.assert_no_mutation(before)


# ------------------------------------------------------- reference inventory
class ReferenceInventoryTests(Base):
    """Any additional or divergent reference to the owned chain is a refusal."""

    def refused_for(self, pattern, mutate):
        self.controller.apply_on_boot()
        mutate()
        before = self.backend.snapshot()
        with self.assertRaisesRegex(persistence.PersistenceError, pattern):
            self.controller.apply_on_boot()
        self.assert_no_mutation(before)
        with self.assertRaisesRegex(persistence.PersistenceError, pattern):
            self.controller.rollback()
        self.assert_no_mutation(before)
        self.assertTrue(self.backend.owned())

    def test_foreign_tagged_reference_in_input_is_refused(self):
        self.refused_for("specification diverges",
                         lambda: self.backend.chains["INPUT"].__setitem__(
                             0, ["-m", "comment", "--comment", "foreign", "-j", persistence.CHAIN]))

    def test_second_reference_in_input_is_refused(self):
        self.refused_for("exactly once", lambda: self.backend.chains["INPUT"].append(persistence.owned_jump()))

    def test_reference_in_forward_is_refused(self):
        self.refused_for("exactly once",
                         lambda: self.backend.chains["FORWARD"].append(
                             ["-m", "comment", "--comment", "other", "-j", persistence.CHAIN]))

    def test_reference_in_foreign_chain_is_refused(self):
        self.refused_for("exactly once",
                         lambda: self.backend.chains["DOCKER-FORWARD"].append(["-j", persistence.CHAIN]))

    def test_goto_reference_is_refused(self):
        self.refused_for("specification diverges",
                         lambda: self.backend.chains["INPUT"].__setitem__(0, ["-g", persistence.CHAIN]))

    def test_reference_without_chain_is_refused(self):
        self.controller.apply_on_boot()
        del self.backend.chains[persistence.CHAIN]
        before = self.backend.snapshot()
        with self.assertRaisesRegex(persistence.PersistenceError, "without its chain"):
            self.controller.apply_on_boot()
        self.assert_no_mutation(before)
        with self.assertRaisesRegex(persistence.PersistenceError, "without its chain"):
            self.controller.rollback()
        self.assert_no_mutation(before)

    def test_single_reviewed_reference_is_the_only_accepted_state(self):
        self.controller.apply_on_boot()
        references = persistence.references_to_owned_chain(self.backend.snapshot())
        self.assertEqual(references, [("INPUT", 0, persistence.owned_jump())])
        self.assertEqual(self.controller.apply_on_boot()["phase"], "no-op")


# ------------------------------------------------------------ rollback drift
class RollbackPolicyDriftTests(Base):
    def test_rollback_refuses_input_policy_drift_without_mutation(self):
        self.controller.apply_on_boot()
        self.backend.policies["INPUT"] = "ACCEPT"
        before = self.backend.snapshot()
        with self.assertRaisesRegex(persistence.PersistenceError, "policies drifted"):
            self.controller.rollback()
        self.assert_no_mutation(before)
        self.assertTrue(self.backend.owned())

    def test_rollback_refuses_forward_policy_drift_without_mutation(self):
        self.controller.apply_on_boot()
        self.backend.policies["FORWARD"] = "ACCEPT"
        before = self.backend.snapshot()
        with self.assertRaisesRegex(persistence.PersistenceError, "policies drifted"):
            self.controller.rollback()
        self.assert_no_mutation(before)
        self.assertTrue(self.backend.owned())


# ---------------------------------------------------------------- rollback
class RollbackTests(Base):
    def test_normal_rollback_restores_previous_policies(self):
        self.controller.apply_on_boot()
        result = self.controller.rollback()
        self.assertEqual(result["phase"], "rolled_back")
        self.assertFalse(self.backend.owned())
        self.assertEqual(self.backend.policies["INPUT"], "ACCEPT")
        self.assertEqual(self.backend.policies["FORWARD"], "ACCEPT")
        self.assertTrue(self.backend.foreign_intact())

    def test_repeated_rollback_is_a_proven_noop(self):
        self.controller.apply_on_boot()
        self.controller.rollback()
        before = copy.deepcopy(self.backend.chains)
        result = self.controller.rollback()
        self.assertEqual(result["phase"], "no-op")
        self.assertEqual(result["writes"], "none")
        self.assertEqual(self.backend.chains, before)

    def test_rollback_without_receipt_is_refused(self):
        with self.assertRaisesRegex(persistence.PersistenceError, "nothing owned"):
            self.controller.rollback()

    def test_stale_boot_rollback_is_refused(self):
        self.controller.apply_on_boot()
        self.backend.boot = "boot-B"
        before = self.backend.snapshot()
        with self.assertRaisesRegex(persistence.PersistenceError, "another boot"):
            self.controller.rollback()
        self.assert_no_mutation(before)

    def test_rollback_refuses_foreign_or_partial_chain(self):
        self.controller.apply_on_boot()
        self.backend.chains[persistence.CHAIN].append(["-j", "RETURN"])
        before = self.backend.snapshot()
        with self.assertRaisesRegex(persistence.PersistenceError, "diverged"):
            self.controller.rollback()
        self.assert_no_mutation(before)
        self.assertTrue(self.backend.owned())


# ------------------------------------------------------------ record validation
class RecordValidationTests(Base):
    def test_non_object_receipt_is_refused(self):
        data = b"[]"
        persistence.private_write(self.root / "receipt.json", data)
        persistence.private_write(self.root / "receipt.json.sha256", (persistence.digest(data) + "\n").encode())
        with self.assertRaisesRegex(persistence.PersistenceError, "not a JSON object"):
            self.controller.status()
        before = self.backend.snapshot()
        with self.assertRaisesRegex(persistence.PersistenceError, "not a JSON object"):
            self.controller.apply_on_boot()
        self.assert_no_mutation(before)

    def test_non_object_journal_with_applied_state_is_refused(self):
        # The journal is only proof in the crash-recovery path: with the owned
        # delta live and no receipt, a non-object journal must refuse.
        self.backend.apply_transaction(persistence.apply_transaction_text())
        data = b"[]"
        persistence.private_write(self.root / "journal.json", data)
        persistence.private_write(self.root / "journal.json.sha256", (persistence.digest(data) + "\n").encode())
        before = self.backend.snapshot()
        with self.assertRaisesRegex(persistence.PersistenceError, "not a JSON object"):
            self.controller.apply_on_boot()
        self.assert_no_mutation(before)
        self.assertTrue(self.backend.owned())

    def test_corrupt_journal_on_a_clean_state_is_superseded_safely(self):
        data = b"[]"
        persistence.private_write(self.root / "journal.json", data)
        persistence.private_write(self.root / "journal.json.sha256", (persistence.digest(data) + "\n").encode())
        # Nothing is owned and there is nothing to recover, so the fresh attempt
        # replaces the unusable record instead of blocking the boot.
        self.assertEqual(self.controller.apply_on_boot()["phase"], "applied")
        self.assertTrue(self.backend.owned())

    def test_invalid_receipt_schema_is_refused(self):
        self.craft_record("receipt.json", schema=99)
        with self.assertRaisesRegex(persistence.PersistenceError, "schema/version"):
            self.controller.apply_on_boot()

    def test_invalid_receipt_identity_fields_are_refused(self):
        cases = (("boot_id", "", "missing a valid boot_id"),
                 ("controller_sha256", "xyz", "hashes are malformed"),
                 ("chain", "OTHER_CHAIN", "different owned resource"),
                 ("phase", "acquired", "phase is not valid"))
        for field, value, pattern in cases:
            self.craft_record("receipt.json", **{field: value})
            with self.assertRaisesRegex(persistence.PersistenceError, pattern):
                self.controller.status()

    def test_invalid_before_policies_are_refused(self):
        self.craft_record("receipt.json", before_policies={"INPUT": "REJECT", "FORWARD": "ACCEPT"})
        with self.assertRaisesRegex(persistence.PersistenceError, "previous policies are invalid"):
            self.controller.apply_on_boot()

    def test_receipt_without_sidecar_is_refused(self):
        self.craft_record("receipt.json")
        (self.root / "receipt.json.sha256").unlink()
        with self.assertRaisesRegex(persistence.PersistenceError, "truncated or tampered"):
            self.controller.status()

    def test_invalid_journal_document_is_refused(self):
        self.craft_record("journal.json", policy_version=42)
        with self.assertRaisesRegex(persistence.PersistenceError, "schema/version"):
            self.controller.status()


# ---------------------------------------------------------------- lock
class LockTests(Base):
    def test_concurrent_operation_is_refused(self):
        holder = threading.Event()
        release = threading.Event()

        def hold():
            with self.controller.store.lock():
                holder.set()
                release.wait(5)

        thread = threading.Thread(target=hold, daemon=True)
        thread.start()
        self.assertTrue(holder.wait(2), "lock holder did not start")
        try:
            with self.assertRaisesRegex(persistence.PersistenceError, "lock busy"):
                with self.controller.store.lock(timeout=0.05):
                    self.fail("concurrent operation entered the exclusive lock")
        finally:
            release.set()
            thread.join(5)


# ---------------------------------------------------------------- host, state dir, output
class HostAndOutputTests(Base):
    def test_unreviewed_platform_is_refused(self):
        backend = persistence.LinuxAdapter(runner=lambda argv, text: "", execute_reviewed=True,
                                           file_reader=lambda name: b'ID=ubuntu\nVERSION_ID="24.04"\n')
        backend.PLATFORM = "win32"  # Any non-reviewed platform, independent of the test host.
        with self.assertRaisesRegex(persistence.PersistenceError, "Linux only"):
            backend.validate_host()

    def test_missing_or_incompatible_backend_is_refused(self):
        def reader(name):
            if name == persistence.LinuxAdapter.BOOT_ID:
                return b"boot-x\n"
            return b'ID=ubuntu\nVERSION_ID="24.04"\n'

        backend = persistence.LinuxAdapter(runner=lambda argv, text: "ip6tables v1.8.9 (legacy)\n",
                                           execute_reviewed=True, file_reader=reader)
        backend.PLATFORM, backend.MACHINE = "linux", "aarch64"
        with self.assertRaisesRegex(persistence.PersistenceError, "ip6tables 1.8.10"):
            backend.validate_host()

    def test_wrong_reviewed_target_is_refused(self):
        backend = persistence.LinuxAdapter(runner=lambda argv, text: "ip6tables v1.8.10 (nf_tables)\n",
                                           execute_reviewed=True,
                                           file_reader=lambda name: b'ID=debian\nVERSION_ID="12"\n')
        backend.PLATFORM, backend.MACHINE = "linux", "x86_64"
        with self.assertRaisesRegex(persistence.PersistenceError, "Ubuntu 24.04 ARM64"):
            backend.validate_host()

    @unittest.skipUnless(os.name == "posix", "POSIX symlink/permission semantics")
    def test_symlinked_state_directory_is_refused(self):
        real = Path(self.tmp.name) / "real"
        real.mkdir()
        link = Path(self.tmp.name) / "link"
        link.symlink_to(real, target_is_directory=True)
        with self.assertRaisesRegex(persistence.PersistenceError, "symlink"):
            persistence.Store(link)

    @unittest.skipUnless(os.name == "posix", "POSIX symlink/permission semantics")
    def test_permissive_state_directory_is_refused(self):
        loose = Path(self.tmp.name) / "loose"
        loose.mkdir(mode=0o755)
        os.chmod(loose, 0o755)
        with self.assertRaisesRegex(persistence.PersistenceError, "private, owned, mode 0700"):
            persistence.Store(loose)

    def test_state_path_that_is_not_a_directory_is_refused(self):
        target = Path(self.tmp.name) / "file"
        target.write_text("x")
        with self.assertRaisesRegex(persistence.PersistenceError, "not a directory"):
            persistence.Store(target)

    def test_public_output_carries_no_ruleset_address_or_secret(self):
        self.controller.apply_on_boot()
        payload = json.dumps(persistence.public_status(self.controller.status()), sort_keys=True)
        payload += json.dumps(persistence.plan(), sort_keys=True)
        self.assertNotRegex(payload, r"\d+\.\d+\.\d+\.\d+")
        self.assertNotRegex(payload, r"[0-9a-f]{0,4}::")
        for token in ("-A ", "-N ", "-j ", "COMMIT", "@", "hostname"):
            self.assertNotIn(token, payload)


# ---------------------------------------------------------------- systemd unit
class UnitTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(UNIT.is_file(), "versioned systemd unit is missing")
        self.text = UNIT.read_text()

    def test_unit_is_versioned_oneshot_with_explicit_ordering(self):
        self.assertIn("Type=oneshot", self.text)
        self.assertIn("RemainAfterExit=yes", self.text)
        self.assertIn("After=netfilter-persistent.service", self.text)
        self.assertRegex(self.text, r"Before=.*docker\.service")
        self.assertRegex(self.text, r"Before=.*network-online\.target")
        self.assertIn("Restart=no", self.text)
        self.assertIn("TimeoutStartSec=90", self.text)
        self.assertIn("ExecStart=/usr/bin/python3 -I -B /usr/lib/stk6-persistence/ipv6_persistence.py", self.text)
        self.assertIn("--execute-reviewed-linux", self.text)

    def test_unit_never_hides_a_missing_controller(self):
        # ConditionPathExists would silently skip the unit; an absent controller
        # must surface as a failed unit instead.
        self.assertNotIn("ConditionPathExists", self.text)
        self.assertNotIn("Condition", self.text)

    def test_unit_hardening_and_private_directories(self):
        for directive in ("NoNewPrivileges=true", "ProtectSystem=strict", "ProtectHome=true",
                          "PrivateTmp=true", "CapabilityBoundingSet=CAP_NET_ADMIN",
                          "RuntimeDirectory=stk6-persistence", "StateDirectory=stk6-persistence",
                          "RuntimeDirectoryMode=0700", "StateDirectoryMode=0700"):
            self.assertIn(directive, self.text)
        self.assertNotIn("CAP_SYS_ADMIN", self.text)

    def test_unit_has_no_credentials_or_private_variables(self):
        self.assertNotRegex(self.text, r"(?i)(password|token|secret|api[_-]?key|-----BEGIN)")

    def test_ordering_contract_has_no_cycle(self):
        after = set(re.findall(r"^After=(.*)$", self.text, re.M)[0].split())
        before = set(re.findall(r"^Before=(.*)$", self.text, re.M)[0].split())
        self.assertEqual(after, {"netfilter-persistent.service"})
        self.assertEqual(before, {"docker.service", "network-online.target"})
        self.assertFalse(after & before, "After/Before overlap could form a cycle")

    @unittest.skipUnless(hasattr(os, "posix_spawn") and shutil.which("systemd-analyze"),
                         "systemd-analyze/POSIX spawn are unavailable")
    def test_systemd_analyze_verify_accepts_the_unit(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            target = directory / UNIT.name
            shutil.copy(UNIT, target)
            os.chmod(target, 0o644)
            # os.posix_spawn bypasses subprocess.Popen, which this suite blocks on
            # purpose so that no production adapter can spawn a real command.
            out, err = directory / "stdout", directory / "stderr"
            argv = ["systemd-analyze", "verify", str(target)]
            pid = os.posix_spawn(shutil.which("systemd-analyze"), argv, dict(os.environ), file_actions=[
                (os.POSIX_SPAWN_OPEN, 1, str(out), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600),
                (os.POSIX_SPAWN_OPEN, 2, str(err), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600),
            ])
            _, status = os.waitpid(pid, 0)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0, err.read_text())


if __name__ == "__main__":
    unittest.main()
