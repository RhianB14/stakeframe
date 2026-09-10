"""STK-M0-33: versioned, idempotent and reversible IPv6 boot persistence.

Owns exactly one stable IPv6 filter chain, its single INPUT reference and the
INPUT/FORWARD policies confirmed by STK-M0-23. The delta is applied as ONE
atomic ip6tables-nft transaction (``ip6tables-restore --noflush``), never as
independent commands and never as a full-ruleset capture/restore: IPv4, IPv6
OUTPUT, NAT, Docker, Fail2Ban and foreign rules are never captured for
rewriting, flushed, reordered or removed.

The state machine treats EVERY step after the firewall commit as recoverable:
the pre-transaction journal is durable, the readback, the acquisition journal
and the terminal receipt are all inside the recovery path, and the receipt is
the last marker of success. A failure or a crash after the commit rolls back
only the owned delta; external drift refuses without overwriting anything.

Linux execution requires root plus the explicit ``--execute-reviewed-linux``
flag. Tests inject a deterministic in-memory backend and never spawn a real
firewall, systemd or shell command.
"""
import argparse
import contextlib
import hashlib
import json
import os
import platform
import re
import secrets
import stat
import subprocess
import sys
import time
from pathlib import Path

POLICY_VERSION = 1
CHAIN = "STK6_BOOT"
TAG = "stk6:boot:v1"
DEFAULT_STATE_DIR = "/var/lib/stk6-persistence"
INSTALLED_CONTROLLER = "/usr/lib/stk6-persistence/ipv6_persistence.py"
UNIT_NAME = "stk6-ipv6-persistence.service"
UNIT_PATH = "infra/systemd/" + UNIT_NAME
SCHEMA = 1
ORDERING = {"after": ["netfilter-persistent.service"], "before": ["docker.service", "network-online.target"]}
PROTECTED_PERSISTENCE_FILES = ("/etc/iptables/rules.v4", "/etc/iptables/rules.v6",
                               "/etc/default/netfilter-persistent", "/etc/default/iptables")
BUILTIN_CHAINS = ("INPUT", "FORWARD", "OUTPUT")
OWNERSHIP_PREFIX = "STK6"
REFERENCE_TOKENS = ("-j", "--jump", "-g", "--goto")
HEX64 = re.compile(r"[0-9a-f]{64}")
# The receipt is the terminal success/rollback marker; the journal narrates the
# attempt and may legitimately stay in a non-terminal phase after a crash.
RECEIPT_PHASES = ("applied", "rolled_back")
JOURNAL_PHASES = ("applying", "acquired", "failed", "failed_rolled_back", "rollback_required",
                  "interrupted_rolled_back", "rolled_back_unrecorded")


class PersistenceError(RuntimeError):
    """A refusal: the caller must not claim success or mutate foreign state."""


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode("utf-8")


def private_read(path, expected_uid=None):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink():
        raise PersistenceError("expected a regular, non-symlink private file")
    if os.name == "posix" and (info.st_uid != (os.geteuid() if expected_uid is None else expected_uid)
                              or info.st_mode & 0o077):
        raise PersistenceError("private file must be owned by the effective user with mode 0600")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
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


def policy_document():
    """The single declarative policy. Must mirror NETWORK-SECURITY.md and M0-31-VALIDATION.md."""
    return {
        "schema": SCHEMA,
        "policy_version": POLICY_VERSION,
        "chain": CHAIN,
        "tag": TAG,
        "rules": policy_rules(),
        "policies": {"INPUT": "DROP", "FORWARD": "DROP", "OUTPUT": "preserved"},
        "reference": {"chain": CHAIN, "position": 1, "count": 1},
    }


def policy_sha256():
    return digest(json.dumps(policy_document(), sort_keys=True, separators=(",", ":")).encode("utf-8"))


def controller_sha256():
    return digest(Path(__file__).read_bytes())


def policy_rules(tag=TAG):
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


def owned_jump(tag=TAG):
    return ["-m", "comment", "--comment", tag, "-j", CHAIN]


def apply_transaction_text(policy=None):
    policy = policy or policy_document()
    lines = ["*filter", "-N " + CHAIN]
    for rule in policy["rules"]:
        lines.append("-A " + CHAIN + " " + " ".join(rule))
    lines.append("-I INPUT 1 " + " ".join(owned_jump()))
    lines.append(":INPUT DROP [0:0]")
    lines.append(":FORWARD DROP [0:0]")
    lines.append("COMMIT")
    return "\n".join(lines) + "\n"


def rollback_transaction_text(before_policies):
    input_policy = before_policies.get("INPUT")
    forward_policy = before_policies.get("FORWARD")
    if input_policy not in ("ACCEPT", "DROP") or forward_policy not in ("ACCEPT", "DROP"):
        raise PersistenceError("recorded previous policies are not restorable")
    return "\n".join([
        "*filter",
        "-D INPUT " + " ".join(owned_jump()),
        "-F " + CHAIN,
        "-X " + CHAIN,
        ":INPUT " + input_policy + " [0:0]",
        ":FORWARD " + forward_policy + " [0:0]",
        "COMMIT",
    ]) + "\n"


def parse_filter(text):
    """Parse ``ip6tables -t filter -S`` into policies and ordered chain rules."""
    snapshot = {"policies": {}, "chains": {}}
    for line in text.splitlines():
        args = re.findall(r'"[^"]*"|\S+', line)
        if not args:
            continue
        args = [arg[1:-1] if len(arg) >= 2 and arg.startswith('"') and arg.endswith('"') else arg for arg in args]
        if args[0] == "-P" and len(args) == 3:
            snapshot["policies"][args[1]] = args[2]
            snapshot["chains"][args[1]] = []
        elif args[0] == "-N" and len(args) == 2:
            snapshot["chains"][args[1]] = []
        elif args[0] == "-A" and len(args) >= 3 and args[1] in snapshot["chains"]:
            rule = args[2:]
            if "--ctstate" in rule:
                index = rule.index("--ctstate") + 1
                rule[index] = ",".join(sorted(rule[index].split(",")))
            snapshot["chains"][args[1]].append(rule)
        else:
            raise PersistenceError("unexpected ip6tables -S output")
    if set(snapshot["policies"]) != set(BUILTIN_CHAINS):
        raise PersistenceError("missing built-in IPv6 policies")
    return snapshot


def references_to_owned_chain(snapshot):
    """Every jump/goto that targets the owned chain, in deterministic order.

    Counting only the exact owned rule inside INPUT would miss a second
    reference with another comment, a reference in FORWARD, a reference in a
    foreign chain or a ``--goto``. All of them are inventoried here.
    """
    found = []
    for name, rules in snapshot["chains"].items():
        for index, rule in enumerate(rules):
            tokens = list(rule)
            for position, token in enumerate(tokens):
                if token in REFERENCE_TOKENS and position + 1 < len(tokens) and tokens[position + 1] == CHAIN:
                    found.append((name, index, list(rule)))
                    break
    return found


def verify_owned_reference(snapshot, tag=TAG):
    """The only acceptable reference state: exactly one, INPUT, index 0, reviewed spec."""
    references = references_to_owned_chain(snapshot)
    if len(references) != 1:
        raise PersistenceError("owned chain must be referenced exactly once in the filter table")
    name, index, rule = references[0]
    if name != "INPUT" or index != 0:
        raise PersistenceError("owned INPUT reference is not in the reviewed position")
    if rule != owned_jump(tag):
        raise PersistenceError("owned reference specification diverges from the reviewed jump")
    return references[0]


def classify(snapshot, tag=TAG):
    """Return {"state": "clean"|"applied", "reason": "..."} or raise PersistenceError."""
    chains, policies = snapshot["chains"], snapshot["policies"]
    foreign = sorted(name for name in chains if name.startswith(OWNERSHIP_PREFIX) and name != CHAIN)
    if foreign:
        raise PersistenceError("unknown STK6 chain present; refuse adoption of external state")
    for name in BUILTIN_CHAINS:
        if policies.get(name) not in ("ACCEPT", "DROP"):
            raise PersistenceError("unsupported IPv6 policy on " + name)
    ours = chains.get(CHAIN)
    if ours is None:
        if references_to_owned_chain(snapshot):
            raise PersistenceError("owned reference without its chain")
        if policies["INPUT"] != "ACCEPT" or policies["FORWARD"] != "ACCEPT":
            raise PersistenceError("divergent policy without an owned chain")
        return {"state": "clean", "reason": "expected pre-application state"}
    if ours != policy_rules(tag):
        raise PersistenceError("owned chain exists with partial or foreign content")
    verify_owned_reference(snapshot, tag)
    if policies["INPUT"] != "DROP" or policies["FORWARD"] != "DROP":
        raise PersistenceError("owned chain present with divergent policies")
    return {"state": "applied", "reason": "exactly the reviewed delta"}


def is_delta_persisted(files, tag=TAG):
    """Read-only check: the delta must never live in the persistence files."""
    for name, data in files.items():
        if data is None:
            continue
        blob = data.decode("utf-8", "replace")
        if CHAIN in blob or tag in blob:
            return name
    return None


def validate_document(document, name):
    """Structural validation before any field is used as proof of ownership."""
    if not isinstance(document, dict):
        raise PersistenceError("record is not a JSON object: " + name)
    strings = ("boot_id", "controller_sha256", "policy_sha256", "chain", "tag", "phase")
    for key in strings:
        value = document.get(key)
        if not isinstance(value, str) or not value.strip():
            raise PersistenceError("record is missing a valid " + key + ": " + name)
    for key in ("schema", "policy_version"):
        value = document.get(key)
        if not isinstance(value, int) or isinstance(value, bool):
            raise PersistenceError("record is missing a valid " + key + ": " + name)
    if document["schema"] != SCHEMA or document["policy_version"] != POLICY_VERSION:
        raise PersistenceError("record schema/version is not the reviewed one: " + name)
    if document["chain"] != CHAIN or document["tag"] != TAG:
        raise PersistenceError("record describes a different owned resource: " + name)
    if not HEX64.fullmatch(document["controller_sha256"]) or not HEX64.fullmatch(document["policy_sha256"]):
        raise PersistenceError("record hashes are malformed: " + name)
    policies = document.get("before_policies")
    if not isinstance(policies, dict) or set(policies) != {"INPUT", "FORWARD"} \
            or any(policies[key] not in ("ACCEPT", "DROP") for key in policies):
        raise PersistenceError("record previous policies are invalid: " + name)
    phases = RECEIPT_PHASES if name.startswith("receipt") else JOURNAL_PHASES
    if document["phase"] not in phases:
        raise PersistenceError("record phase is not valid for this record: " + name)
    return document


def validate_receipt(document):
    return validate_document(document, "receipt.json")


def validate_journal(document):
    return validate_document(document, "journal.json")


class Store:
    """Private state directory with a single global exclusive lock."""

    def __init__(self, root, require_private=True):
        self.root = Path(root).absolute()
        if self.root.exists() and not self.root.is_dir():
            raise PersistenceError("state path exists and is not a directory")
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = self.root.lstat()
        if not stat.S_ISDIR(info.st_mode) or self.root.is_symlink():
            raise PersistenceError("state directory must be a regular directory, not a symlink")
        if require_private and os.name == "posix" and (info.st_uid != os.geteuid() or info.st_mode & 0o077):
            raise PersistenceError("state directory must be private, owned, mode 0700")

    @contextlib.contextmanager
    def lock(self, timeout=0.0):
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(self.root / "operation.lock", flags, 0o600)
        locked = False
        deadline = time.monotonic() + timeout
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
                except (BlockingIOError, PermissionError, OSError):
                    if time.monotonic() >= deadline:
                        raise PersistenceError("operation lock busy; another boot/apply/rollback holds it")
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

    def write_record(self, name, document):
        data = encoded(document)
        private_write(self.root / name, data)
        private_write(self.root / (name + ".sha256"), (digest(data) + "\n").encode("ascii"))

    def read_record(self, name):
        path = self.root / name
        if not path.exists():
            return None
        data = private_read(path)
        try:
            sidecar = private_read(self.root / (name + ".sha256"))
        except (FileNotFoundError, PersistenceError) as exc:
            raise PersistenceError("truncated or tampered record: " + name) from exc
        if sidecar.decode("ascii", "replace").strip() != digest(data):
            raise PersistenceError("truncated or tampered record: " + name)
        document = json.loads(data)
        if not isinstance(document, dict):
            raise PersistenceError("record is not a JSON object: " + name)
        return document

    def discard_record(self, name):
        """Best-effort removal so no stale receipt survives a rollback."""
        removed = []
        for target in (self.root / name, self.root / (name + ".sha256")):
            try:
                if target.exists() and not target.is_symlink():
                    target.unlink()
                    removed.append(target.name)
            except OSError:
                pass
        return removed

    def receipt(self):
        return self.read_record("receipt.json")

    def journal(self):
        return self.read_record("journal.json")


def plan():
    """Offline contract only: no state directory, writes, commands or network."""
    return {
        "schema": SCHEMA,
        "mode": "plan",
        "policy_version": POLICY_VERSION,
        "chain": CHAIN,
        "tag": TAG,
        "rules": len(policy_rules()),
        "policies": policy_document()["policies"],
        "input_reference": policy_document()["reference"],
        "transaction": "single atomic ip6tables-restore --noflush document",
        "ordering": ORDERING,
        "unit": UNIT_PATH,
        "modes": ["plan", "apply-on-boot", "status", "rollback"],
        "controller_sha256": controller_sha256(),
        "policy_sha256": policy_sha256(),
        "writes": "none",
    }


class Controller:
    def __init__(self, root, backend, require_private=True):
        self.store = Store(root, require_private=require_private)
        self.backend = backend

    def plan(self):
        return plan()

    def _preflight(self):
        self.backend.validate_host()
        files = self.backend.persistence_files()
        persisted = is_delta_persisted(files)
        if persisted:
            raise PersistenceError("delta already present in a persistence file; refuse double application")
        return files

    def _record_phase(self, record, phase, error=None, note=None):
        """Best-effort journal update.

        A failure to persist recovery metadata must never hide the firewall
        result nor turn a failed attempt into an apparent success, so this
        never raises: the caller keeps its primary, visible failure.
        """
        document = {**record, "phase": phase}
        if error is not None:
            document["error"] = type(error).__name__
        if note is not None:
            document["note"] = note
        try:
            self.store.write_record("journal.json", document)
            return True
        except BaseException:
            return False

    def _attempt_identity_matches(self, document, boot_id, controller_hash):
        return (document.get("boot_id") == boot_id
                and document.get("controller_sha256") == controller_hash
                and document.get("policy_sha256") == policy_sha256())

    def _rollback_delta(self, before_policies):
        """Remove ONLY the owned delta and restore the recorded previous policies.

        The rollback refuses BEFORE any transaction when the live state is not
        provably the owned delta: diverging chain content, any additional or
        divergent reference and drifted INPUT/FORWARD policies are all refusals.
        """
        snapshot = self.backend.snapshot()
        chains, policies = snapshot["chains"], snapshot["policies"]
        present = CHAIN in chains
        references = references_to_owned_chain(snapshot)
        if not present and not references:
            return {"state": "no-op"}
        if not present:
            raise PersistenceError("owned reference without its chain; refuse rollback")
        if chains[CHAIN] != policy_rules():
            raise PersistenceError("owned chain content diverged; refuse destructive rollback")
        verify_owned_reference(snapshot)
        if policies["INPUT"] != "DROP" or policies["FORWARD"] != "DROP":
            raise PersistenceError("IPv6 policies drifted while the owned delta is present; refuse rollback")
        self.backend.apply_transaction(rollback_transaction_text(before_policies))
        after = self.backend.snapshot()
        if CHAIN in after["chains"] or references_to_owned_chain(after):
            raise PersistenceError("rollback readback still shows the owned delta")
        return {"state": "rolled_back"}

    def _post_acquisition_failure(self, record, before, before_policies, error):
        """Recover from any failure after the firewall commit. Always raises."""
        current = self.backend.snapshot()
        if current == before:
            saved = self._record_phase(record, "failed", error)
            suffix = "" if saved else " (recovery journal write also failed)"
            raise PersistenceError("apply failed before any commit; no change was made" + suffix) from error
        try:
            self._rollback_delta(before_policies)
        except BaseException as recovery:
            saved = self._record_phase(record, "rollback_required", recovery,
                                       note="external drift or lost proof; nothing was overwritten")
            suffix = "" if saved else " (recovery journal write also failed)"
            raise PersistenceError("apply failed after acquisition and the owned delta could not be proven; "
                                  "rollback_required" + suffix) from recovery
        self.store.discard_record("receipt.json")
        saved = self._record_phase(record, "failed_rolled_back", error)
        suffix = "" if saved else " (recovery journal write also failed)"
        raise PersistenceError("apply failed after acquisition; only the owned delta was rolled back" + suffix) from error

    def _recover_interrupted(self, journal, boot_id, controller_hash):
        """Roll back a delta left by an interrupted attempt. Always raises."""
        if journal is None:
            raise PersistenceError("applied state without a durable receipt or journal; refuse adoption")
        validate_journal(journal)
        if not self._attempt_identity_matches(journal, boot_id, controller_hash):
            raise PersistenceError("journal does not match this controller/policy/boot; refuse adoption")
        if journal["phase"] not in ("applying", "acquired"):
            raise PersistenceError("journal does not describe an interrupted attempt; refuse without mutation")
        try:
            self._rollback_delta(journal["before_policies"])
        except BaseException as recovery:
            self._record_phase(journal, "rollback_required", recovery,
                               note="interrupted attempt with external drift; nothing was overwritten")
            raise PersistenceError("interrupted attempt could not be proven; rollback_required") from recovery
        self.store.discard_record("receipt.json")
        self._record_phase(journal, "interrupted_rolled_back", note="crash after commit, before the receipt")
        raise PersistenceError("interrupted attempt (commit without receipt) rolled back; no adoption; re-run to apply")

    def apply_on_boot(self):
        controller_hash = controller_sha256()
        with self.store.lock():
            files = self._preflight()
            boot_id = self.backend.boot_id()
            before = self.backend.snapshot()
            before_policies = {"INPUT": before["policies"]["INPUT"], "FORWARD": before["policies"]["FORWARD"]}
            kind = classify(before)
            receipt = self.store.receipt()
            if receipt is not None:
                validate_receipt(receipt)
            if kind["state"] == "applied":
                if receipt is not None and receipt["phase"] == "applied":
                    if receipt["boot_id"] != boot_id:
                        raise PersistenceError("receipt belongs to another boot; reconcile manually")
                    if receipt["controller_sha256"] != controller_hash:
                        raise PersistenceError("receipt controller hash differs from the running controller")
                    if receipt["policy_sha256"] != policy_sha256():
                        raise PersistenceError("receipt policy hash differs from the reviewed policy")
                    return {"schema": SCHEMA, "mode": "apply-on-boot", "phase": "no-op",
                            "policy_version": POLICY_VERSION, "state": "applied", "writes": "none"}
                # No applicable applied receipt: only a matching interrupted
                # journal may authorize a conservative rollback of the delta.
                journal = self.store.journal()
                if journal is not None:
                    self._recover_interrupted(journal, boot_id, controller_hash)
                raise PersistenceError("applied state without a matching receipt/journal; refuse adoption")
            # Clean state: nothing owned is present, so a durable journal that
            # identifies this attempt is written before the firewall changes.
            record = {"schema": SCHEMA, "policy_version": POLICY_VERSION, "boot_id": boot_id,
                      "controller_sha256": controller_hash, "policy_sha256": policy_sha256(),
                      "chain": CHAIN, "tag": TAG, "before_policies": before_policies,
                      "phase": "applying", "persistence_files": sorted(files)}
            self.store.write_record("journal.json", record)
            try:
                self.backend.apply_transaction(apply_transaction_text())
                if classify(self.backend.snapshot())["state"] != "applied":
                    raise PersistenceError("readback after apply is not the reviewed delta")
                self.store.write_record("journal.json", {**record, "phase": "acquired"})
                receipt = {**record, "phase": "applied", "state": "applied",
                           "applied_monotonic_ns": self.backend.monotonic_ns()}
                # Terminal marker: nothing fallible runs after a successful receipt.
                self.store.write_record("receipt.json", receipt)
            except BaseException as exc:
                self._post_acquisition_failure(record, before, before_policies, exc)
            return {"schema": SCHEMA, "mode": "apply-on-boot", "phase": "applied",
                    "policy_version": POLICY_VERSION, "state": "applied", "writes": "owned-delta-only",
                    "controller_sha256": controller_hash, "policy_sha256": policy_sha256()}

    def status(self):
        receipt = self.store.receipt()
        journal = self.store.journal()
        if receipt is not None:
            validate_receipt(receipt)
        if journal is not None:
            validate_journal(journal)
        return {
            "schema": SCHEMA,
            "mode": "status",
            "policy_version": POLICY_VERSION,
            "state": receipt["state"] if isinstance(receipt, dict) and "state" in receipt else
                     ("clean" if receipt is not None else "never-applied"),
            "phase": (receipt or journal or {}).get("phase", "absent"),
            "controller_sha256": (receipt or {}).get("controller_sha256"),
            "policy_sha256": (receipt or {}).get("policy_sha256"),
            "current_policy_sha256": policy_sha256(),
            "writes": "none",
        }

    def rollback(self):
        with self.store.lock():
            receipt = self.store.receipt()
            if receipt is None:
                raise PersistenceError("no durable receipt; nothing owned to roll back")
            validate_receipt(receipt)
            if receipt["controller_sha256"] != controller_sha256():
                raise PersistenceError("receipt controller hash differs from the running controller")
            snapshot = self.backend.snapshot()
            if receipt["phase"] == "rolled_back":
                if CHAIN not in snapshot["chains"] and not references_to_owned_chain(snapshot):
                    return {"schema": SCHEMA, "mode": "rollback", "phase": "no-op",
                            "policy_version": POLICY_VERSION, "writes": "none"}
                raise PersistenceError("receipt says rolled back but the owned delta is still present")
            if receipt["boot_id"] != self.backend.boot_id():
                raise PersistenceError("receipt belongs to another boot; refuse stale rollback")
            outcome = self._rollback_delta(receipt["before_policies"])
            try:
                self.store.write_record("receipt.json", {**receipt, "phase": "rolled_back", "state": "clean"})
            except BaseException as exc:
                self._record_phase(receipt, "rolled_back_unrecorded", exc,
                                   note="firewall already rolled back; terminal receipt could not be persisted")
                raise PersistenceError("rollback executed but its terminal receipt could not be persisted") from exc
            return {"schema": SCHEMA, "mode": "rollback", "phase": outcome["state"],
                    "policy_version": POLICY_VERSION, "writes": "owned-delta-only"}


class LinuxAdapter:
    """Only this adapter can reach Linux. Tests inject a deterministic runner.

    No shell, no ``nft flush``, no netfilter-persistent save/reload, no IPv4
    tooling, no SSH and no service management are provided here.
    """

    IP6 = "/usr/sbin/ip6tables"
    IP6_RESTORE = "/usr/sbin/ip6tables-restore"
    BOOT_ID = "/proc/sys/kernel/random/boot_id"
    OS_RELEASE = "/usr/lib/os-release"
    REVIEWED_BACKEND = "ip6tables v1.8.10 (nf_tables)"
    PLATFORM = None  # Tests inject the reviewed target; None means the real one.
    MACHINE = None

    def __init__(self, runner=None, execute_reviewed=False, file_reader=None):
        self.runner = runner
        self.execute_reviewed = execute_reviewed
        self.file_reader = file_reader or self._system_read

    @staticmethod
    def _system_read(name):
        path = Path(name)
        info = path.lstat()
        if path.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise PersistenceError("system prerequisite must be root-owned, regular and not writable by others")
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as stream:
            return stream.read()

    def _call(self, argv, ok=(0,), input_text=None):
        if self.runner is not None:
            return self.runner(list(argv), input_text)
        if not self.execute_reviewed or sys.platform != "linux" or os.geteuid() != 0:
            raise PersistenceError("live operations require the reviewed Linux/root execution flag")
        result = subprocess.run(argv, capture_output=True, text=True, timeout=30, check=False, input=input_text,
                                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
        if result.returncode not in ok:
            # No raw firewall output leaks to the console or CI log.
            raise PersistenceError(Path(argv[0]).name + " failed with exit " + str(result.returncode))
        return result.stdout

    def validate_host(self):
        platform_name = self.PLATFORM or sys.platform
        if platform_name != "linux":
            raise PersistenceError("reviewed target is Linux only")
        if self.runner is None and os.geteuid() != 0:
            raise PersistenceError("reviewed target requires root")
        machine = self.MACHINE or platform.machine()
        release = self.file_reader(self.OS_RELEASE).decode()
        values = dict(line.split("=", 1) for line in release.splitlines() if "=" in line and not line.startswith("#"))
        if values.get("ID", "").strip('"') != "ubuntu" or values.get("VERSION_ID", "").strip('"') != "24.04" \
                or machine != "aarch64":
            raise PersistenceError("reviewed target is Ubuntu 24.04 ARM64 only")
        if not re.fullmatch(r"ip6tables v1\.8\.10 \(nf_tables\)\s*", self._call([self.IP6, "--version"])):
            raise PersistenceError("reviewed backend must be ip6tables 1.8.10 nf_tables")

    @staticmethod
    def monotonic_ns():
        return time.monotonic_ns()

    def boot_id(self):
        return self.file_reader(self.BOOT_ID).decode().strip()

    def snapshot(self):
        return parse_filter(self._call([self.IP6, "-w", "5", "-t", "filter", "-S"]))

    def persistence_files(self):
        files = {}
        for name in PROTECTED_PERSISTENCE_FILES:
            try:
                files[name] = self.file_reader(name)
            except FileNotFoundError:
                files[name] = None  # Absence is a real before-state, not empty bytes.
        return files

    def apply_transaction(self, document):
        """One atomic nf_tables transaction. Never a sequence of independent commands."""
        return self._call([self.IP6_RESTORE, "--noflush", "-w", "5"], input_text=document)

    def validate_transaction(self, document):
        """Syntax-only check. It does NOT detect collisions with the live ruleset."""
        return self._call([self.IP6_RESTORE, "--noflush", "--test", "-w", "5"], input_text=document)


def public_status(result):
    allowed = ("schema", "mode", "phase", "state", "policy_version", "writes", "chain", "tag",
               "policy_sha256", "controller_sha256", "current_policy_sha256")
    return {key: result[key] for key in allowed if key in result}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("plan", help="offline contract only; no files, commands or network")
    for name in ("apply-on-boot", "rollback"):
        command = commands.add_parser(name)
        command.add_argument("--state-dir", default=DEFAULT_STATE_DIR)
        command.add_argument("--execute-reviewed-linux", action="store_true", required=True)
    status = commands.add_parser("status", help="read-only durable state")
    status.add_argument("--state-dir", default=DEFAULT_STATE_DIR)
    args = parser.parse_args(argv)
    try:
        if args.command == "plan":
            print(json.dumps(plan(), indent=2, sort_keys=True))
            return 0
        if args.command == "status":
            if not Path(args.state_dir).is_dir():
                raise PersistenceError("state directory does not exist")
            controller = Controller(args.state_dir, backend=None)
            print(json.dumps(public_status(controller.status()), indent=2, sort_keys=True))
            return 0
        if sys.platform != "linux" or os.geteuid() != 0:
            raise PersistenceError("live path requires Linux/root and separate authorization")
        backend = LinuxAdapter(execute_reviewed=True)
        controller = Controller(args.state_dir, backend)
        if args.command == "apply-on-boot":
            result = controller.apply_on_boot()
        else:
            result = controller.rollback()
        print(json.dumps(public_status(result), indent=2, sort_keys=True))
        return 0
    except (PersistenceError, OSError, ValueError, KeyError, TypeError):
        # Details stay private; the console and journal never carry a ruleset.
        print("REFUSED: no success claim; inspect the private journal and the M0-33 runbook", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
