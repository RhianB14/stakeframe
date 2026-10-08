"""Compose the promotion record from approved candidate evidence (no deploy).

Verifies a run of one of the explicitly reviewed candidate workflows (main,
dispatch, success), cross-checks the downloaded candidate evidence of the
deployment architecture against its publication evidence, and emits the immutable
promotion record that the manual SSH window consumes: the fixed digests per
target, the deployment identifier and the requester. This script never touches
production.

Candidate workflows are identified by their `path`, not by their display
`name`: `name` is a human label that may be reworded without breaking any
contract, while `path` is the reviewed file this repository ships. The
release-candidate path uses `publication-<run id>` evidence; candidate-images
uses the candidate and candidate-evidence artifacts from that same run.

The record is arm64-only, and deliberately so. Production runs on ARM64 and
only the ARM64 indexes are approved and published: publication is a single
ARM64 job (scripts/release/publication.py), so no amd64 evidence exists to
attest. A record carrying an amd64 digest could only ever assert that the
build produced it, never that the registry served it. Asserting less than the
evidence proves would make the record weaker, so it asserts exactly what was
published.

The registry never proves which build was promoted, so digests alone cannot
identify the build: the record is bound to the approval registry
(infra/release/approved-arm64.json) through the candidate run id it names. A
build without an entry there cannot obtain a record.
"""
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from verify_oci import TARGETS, require

# Reviewed workflow files that may produce promotion evidence, not labels.
CANDIDATE_WORKFLOW_PATH = ".github/workflows/release-candidate.yml"
CANDIDATE_IMAGES_WORKFLOW_PATH = ".github/workflows/candidate-images.yml"
CANDIDATE_WORKFLOW_PATHS = (CANDIDATE_WORKFLOW_PATH, CANDIDATE_IMAGES_WORKFLOW_PATH)
# Where the approved digests live; the gate that names the build.
APPROVAL_PATH = "infra/release/approved-arm64.json"
# Production is ARM64; only this architecture is approved and published.
DEPLOYMENT_ARCHITECTURE = "arm64"
REPOSITORY = "RhianB14/stakeframe"
REGISTRY = "ghcr.io"
NAMESPACE = "rhianb14"
DEFAULT_OUTPUT = ".cache/promotion/promotion-record.json"
SHA = re.compile(r"[a-f0-9]{40}\Z")
DIGEST = re.compile(r"sha256:[a-f0-9]{64}\Z")
DEPLOYMENT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{2,63}\Z")
REQUESTER = re.compile(r"[A-Za-z0-9-]{1,39}\Z")


def read_json(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink(), "PROMOTION_EVIDENCE_MISSING")
    return json.loads(path.read_text(encoding="utf-8"))


def validate_run(run):
    require(run.get("path") in CANDIDATE_WORKFLOW_PATHS, "PROMOTION_RUN_WORKFLOW_REFUSED")
    require(run.get("repository", {}).get("full_name") == REPOSITORY, "PROMOTION_RUN_REPOSITORY_REFUSED")
    require(run.get("event") == "workflow_dispatch", "PROMOTION_RUN_EVENT_REFUSED")
    require(run.get("head_branch") == "main", "PROMOTION_RUN_BRANCH_REFUSED")
    require(run.get("status") == "completed" and run.get("conclusion") == "success", "PROMOTION_RUN_NOT_SUCCESSFUL")
    require(bool(SHA.fullmatch(run.get("head_sha", ""))), "PROMOTION_RUN_SHA_REQUIRED")
    return run


def read_approval(path):
    """Read the reviewed approval registry: the gate that names the build."""
    approval = read_json(path)
    require(bool(SHA.fullmatch(approval.get("sourceSha", ""))), "PROMOTION_APPROVAL_INVALID")
    require(isinstance(approval.get("candidateRunId"), int), "PROMOTION_APPROVAL_INVALID")
    require([item.get("target") for item in approval.get("images", [])] == list(TARGETS),
            "PROMOTION_APPROVAL_INVALID")
    return approval


def validate_approval(run, published, approval):
    """Bind the record to the approved build, not merely to some build.

    The run id and sha must be the ones the approval registry names. The
    release-candidate publication artifact also repeats candidateRunId and
    must match it. candidate-images published.json has no candidateRunId; for
    that explicit path, the workflow requires both input run ids to be equal
    and the run itself must be the approved run.
    """
    require(run.get("id") == approval["candidateRunId"], "PROMOTION_RUN_NOT_APPROVED")
    require(run.get("head_sha") == approval["sourceSha"], "PROMOTION_RUN_NOT_APPROVED")
    if run["path"] == CANDIDATE_WORKFLOW_PATH:
        require(published.get("candidateRunId") == approval["candidateRunId"],
                "PROMOTION_PUBLICATION_NOT_APPROVED")
    elif "candidateRunId" in published:
        require(published.get("candidateRunId") == approval["candidateRunId"],
                "PROMOTION_PUBLICATION_NOT_APPROVED")
    require(published.get("sourceSha") == approval["sourceSha"], "PROMOTION_PUBLICATION_NOT_APPROVED")


def load_evidence(directory, sha, workflow_path):
    """Cross-check what the build claimed against what the registry served.

    `candidate.json` carries the index digest each build verified. The
    release-candidate publication artifact uses verified image records with
    `indexDigest` and `provenanceVerified`; candidate-images retains a smaller
    `published.json` with registry `digest` values. The latter path requires
    provenance and non-root claims in candidate.json before accepting the
    deliberately absent per-image fields in published.json.
    """
    candidate = read_json(Path(directory) / "candidate.json")
    require(candidate.get("version") == 1 and candidate.get("status") == "candidate", "PROMOTION_EVIDENCE_INVALID")
    require(candidate.get("sourceSha") == sha, "PROMOTION_EVIDENCE_MISMATCH")
    require(candidate.get("architecture") == DEPLOYMENT_ARCHITECTURE, "PROMOTION_EVIDENCE_MISMATCH")
    if workflow_path == CANDIDATE_IMAGES_WORKFLOW_PATH:
        require(candidate.get("published") is False and candidate.get("productionAuthorized") is False,
                "PROMOTION_EVIDENCE_INVALID")
    images = candidate.get("images", [])
    require([item.get("target") for item in images] == list(TARGETS), "PROMOTION_EVIDENCE_INVALID")
    for item in images:
        require(bool(DIGEST.fullmatch(item.get("indexDigest", ""))), "PROMOTION_EVIDENCE_INVALID")
        if workflow_path == CANDIDATE_IMAGES_WORKFLOW_PATH:
            require(item.get("sourceSha") == sha and item.get("architecture") == DEPLOYMENT_ARCHITECTURE,
                    "PROMOTION_EVIDENCE_MISMATCH")
            require(item.get("provenanceVerified") is True and item.get("nonRootVerified") is True,
                    "PROMOTION_EVIDENCE_INVALID")
    published = read_json(Path(directory) / "published.json")
    require(published.get("published") is True and published.get("productionDeployed") is False, "PROMOTION_EVIDENCE_INVALID")
    require(published.get("sourceSha") == sha, "PROMOTION_EVIDENCE_MISMATCH")
    tag = "candidate-" + sha + "-" + DEPLOYMENT_ARCHITECTURE
    require(published.get("tag") == tag, "PROMOTION_TAG_REFUSED")
    if workflow_path == CANDIDATE_IMAGES_WORKFLOW_PATH:
        require(published.get("version") == 1, "PROMOTION_EVIDENCE_INVALID")
        require(published.get("architecture") == DEPLOYMENT_ARCHITECTURE, "PROMOTION_EVIDENCE_MISMATCH")
    registry_images = published.get("images", [])
    require([item.get("target") for item in registry_images] == list(TARGETS), "PROMOTION_EVIDENCE_INVALID")
    resolved = []
    for reviewed, actual in zip(images, registry_images):
        repository = REGISTRY + "/" + NAMESPACE + "/stakeframe-" + reviewed["target"]
        if workflow_path == CANDIDATE_WORKFLOW_PATH:
            require(actual.get("architecture") == DEPLOYMENT_ARCHITECTURE, "PROMOTION_EVIDENCE_MISMATCH")
            require(actual.get("indexDigest") == reviewed["indexDigest"], "PROMOTION_DIGEST_MISMATCH")
            require(actual.get("provenanceVerified") is True, "PROMOTION_EVIDENCE_INVALID")
        else:
            require(actual.get("repository") == repository, "PROMOTION_EVIDENCE_INVALID")
            require(actual.get("tag") == tag, "PROMOTION_TAG_REFUSED")
            require(actual.get("digest") == reviewed["indexDigest"], "PROMOTION_DIGEST_MISMATCH")
            if "architecture" in actual:
                require(actual.get("architecture") == DEPLOYMENT_ARCHITECTURE, "PROMOTION_EVIDENCE_MISMATCH")
            if "provenanceVerified" in actual:
                require(actual.get("provenanceVerified") is True, "PROMOTION_EVIDENCE_INVALID")
            if "nonRootVerified" in actual:
                require(actual.get("nonRootVerified") is True, "PROMOTION_EVIDENCE_INVALID")
        resolved.append({"target": reviewed["target"], "repository": repository, "tag": tag,
                         "digest": reviewed["indexDigest"]})
    return resolved


def prepare(run, evidence, deployment_id, requested_by, output, approval_path=APPROVAL_PATH):
    validate_run(run)
    sha = run["head_sha"]
    require(bool(DEPLOYMENT_ID.fullmatch(deployment_id or "")), "PROMOTION_DEPLOYMENT_ID_REFUSED")
    require(bool(REQUESTER.fullmatch(requested_by or "")), "PROMOTION_REQUESTER_REFUSED")
    approval = read_approval(Path(approval_path))
    # Bind to the approved build before trusting any digest comparison.
    validate_approval(run, read_json(Path(evidence) / "published.json"), approval)
    images = load_evidence(evidence, sha, run["path"])

    # The registry digests must be exactly the approved ones: this is what
    # turns a verified build into an approved build.
    approved = {item["target"]: item["digest"] for item in approval["images"]}
    for item in images:
        require(item["digest"] == approved[item["target"]], "PROMOTION_DIGEST_NOT_APPROVED")

    record = {
        "version": 1,
        "kind": "stakeframe-promotion-record",
        "sourceSha": sha,
        "candidateRunId": run.get("id"),
        "candidateRunUrl": run.get("html_url"),
        "approvalSourceSha": approval["sourceSha"],
        "approvalCandidateRunId": approval["candidateRunId"],
        "deploymentId": deployment_id,
        "environment": "production",
        "architecture": DEPLOYMENT_ARCHITECTURE,
        "requestedBy": requested_by,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "productionDeployed": False,
        "images": images,
    }
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    lines = ["## Promotion record — " + deployment_id, "",
             "Source: `" + sha + "` (candidate run [" + str(run.get("id")) + "](" + str(run.get("html_url")) + "))",
             "",
             "Approved by `infra/release/approved-arm64.json` (candidate run "
             + str(approval["candidateRunId"]) + ").", "",
             "| Target | Digest (arm64, deployment) |", "| --- | --- |"]
    lines.extend("| " + item["target"] + " | `" + item["digest"] + "` |" for item in record["images"])
    lines.extend(["", "The production environment gate was approved for this run. Deployment remains",
                  "manual, over restricted SSH, by the arm64 digests above — never `latest` —",
                  "following docs/deploy/promotion-runbook.md.", ""])
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a", encoding="utf-8") as stream:
            stream.write("\n".join(lines) + "\n")
    print("PROMOTION_RECORD_READY", sha, deployment_id, len(record["images"]))


if __name__ == "__main__":
    try:
        arguments = sys.argv[1:]
        require(len(arguments) >= 1 and arguments[0] == "prepare", "PROMOTION_COMMAND_REQUIRED")
        flags = dict(zip(arguments[1::2], arguments[2::2]))
        require(len(arguments) % 2 == 1 and len(arguments) >= 9, "PROMOTION_COMMAND_REQUIRED")
        allowed = {"--run-json", "--evidence", "--deployment-id", "--requested-by", "--output", "--approval"}
        require(set(flags) <= allowed and {"--run-json", "--evidence", "--deployment-id", "--requested-by"} <= set(flags), "PROMOTION_COMMAND_REQUIRED")
        prepare(
            read_json(flags["--run-json"]),
            flags["--evidence"],
            flags["--deployment-id"],
            flags["--requested-by"],
            flags.get("--output", DEFAULT_OUTPUT),
            flags.get("--approval", APPROVAL_PATH),
        )
    except (ValueError, KeyError, OSError) as error:
        print("PROMOTION_FAILED", str(error) if isinstance(error, ValueError) else type(error).__name__, file=sys.stderr)
        sys.exit(1)
