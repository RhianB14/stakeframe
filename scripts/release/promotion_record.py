"""Compose the promotion record from an approved candidate run (no deploy).

Verifies the run of the `Candidate images` workflow (main, dispatch, success),
cross-checks the downloaded candidate evidence of both architectures against
its publication evidence, and emits the immutable promotion record that the
manual SSH window consumes: fixed digests per target and architecture, the
deployment identifier and the requester. This script never touches production.
"""
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from verify_oci import TARGETS, require

WORKFLOW_NAME = "Candidate images"
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
    require(run.get("name") == WORKFLOW_NAME, "PROMOTION_RUN_WORKFLOW_REFUSED")
    require(run.get("repository", {}).get("full_name") == REPOSITORY, "PROMOTION_RUN_REPOSITORY_REFUSED")
    require(run.get("event") == "workflow_dispatch", "PROMOTION_RUN_EVENT_REFUSED")
    require(run.get("head_branch") == "main", "PROMOTION_RUN_BRANCH_REFUSED")
    require(run.get("status") == "completed" and run.get("conclusion") == "success", "PROMOTION_RUN_NOT_SUCCESSFUL")
    require(bool(SHA.fullmatch(run.get("head_sha", ""))), "PROMOTION_RUN_SHA_REQUIRED")
    return run


def load_arch_evidence(directory, arch, sha):
    candidate = read_json(Path(directory) / "candidate.json")
    require(candidate.get("version") == 1 and candidate.get("status") == "candidate", "PROMOTION_EVIDENCE_INVALID")
    require(candidate.get("sourceSha") == sha and candidate.get("architecture") == arch, "PROMOTION_EVIDENCE_MISMATCH")
    images = candidate.get("images", [])
    require([item.get("target") for item in images] == list(TARGETS), "PROMOTION_EVIDENCE_INVALID")
    for item in images:
        require(bool(DIGEST.fullmatch(item.get("indexDigest", ""))), "PROMOTION_EVIDENCE_INVALID")
    published = read_json(Path(directory) / "published.json")
    require(published.get("published") is True and published.get("productionDeployed") is False, "PROMOTION_EVIDENCE_INVALID")
    require(published.get("sourceSha") == sha and published.get("architecture") == arch, "PROMOTION_EVIDENCE_MISMATCH")
    tag = "candidate-" + sha + "-" + arch
    require(published.get("tag") == tag, "PROMOTION_TAG_REFUSED")
    registry_images = published.get("images", [])
    require([item.get("target") for item in registry_images] == list(TARGETS), "PROMOTION_EVIDENCE_INVALID")
    resolved = []
    for reviewed, actual in zip(images, registry_images):
        repository = REGISTRY + "/" + NAMESPACE + "/stakeframe-" + reviewed["target"]
        require(actual.get("repository") == repository and actual.get("tag") == tag, "PROMOTION_EVIDENCE_INVALID")
        require(actual.get("digest") == reviewed["indexDigest"], "PROMOTION_DIGEST_MISMATCH")
        resolved.append({"target": reviewed["target"], "repository": repository, "tag": tag, "digest": reviewed["indexDigest"]})
    return resolved


def prepare(run, evidence_amd64, evidence_arm64, deployment_id, requested_by, output):
    validate_run(run)
    sha = run["head_sha"]
    require(bool(DEPLOYMENT_ID.fullmatch(deployment_id or "")), "PROMOTION_DEPLOYMENT_ID_REFUSED")
    require(bool(REQUESTER.fullmatch(requested_by or "")), "PROMOTION_REQUESTER_REFUSED")
    amd64 = load_arch_evidence(evidence_amd64, "amd64", sha)
    arm64 = load_arch_evidence(evidence_arm64, "arm64", sha)
    record = {
        "version": 1,
        "kind": "stakeframe-promotion-record",
        "sourceSha": sha,
        "candidateRunId": run.get("id"),
        "candidateRunUrl": run.get("html_url"),
        "deploymentId": deployment_id,
        "environment": "production",
        "requestedBy": requested_by,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "productionDeployed": False,
        "images": [
            {"target": left["target"], "repository": left["repository"],
             "amd64": {"tag": left["tag"], "digest": left["digest"]},
             "arm64": {"tag": right["tag"], "digest": right["digest"]}}
            for left, right in zip(amd64, arm64)
        ],
    }
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    lines = ["## Promotion record — " + deployment_id, "",
             "Source: `" + sha + "` (candidate run [" + str(run.get("id")) + "](" + str(run.get("html_url")) + "))", "",
             "| Target | Digest (arm64, deployment) | Digest (amd64) |", "| --- | --- | --- |"]
    lines.extend("| " + item["target"] + " | `" + item["arm64"]["digest"] + "` | `" + item["amd64"]["digest"] + "` |" for item in record["images"])
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
        require(len(arguments) % 2 == 1 and len(arguments) >= 11, "PROMOTION_COMMAND_REQUIRED")
        allowed = {"--run-json", "--evidence-amd64", "--evidence-arm64", "--deployment-id", "--requested-by", "--output"}
        require(set(flags) <= allowed and {"--run-json", "--evidence-amd64", "--evidence-arm64", "--deployment-id", "--requested-by"} <= set(flags), "PROMOTION_COMMAND_REQUIRED")
        prepare(
            read_json(flags["--run-json"]),
            flags["--evidence-amd64"],
            flags["--evidence-arm64"],
            flags["--deployment-id"],
            flags["--requested-by"],
            flags.get("--output", DEFAULT_OUTPUT),
        )
    except (ValueError, KeyError, OSError) as error:
        print("PROMOTION_FAILED", str(error) if isinstance(error, ValueError) else type(error).__name__, file=sys.stderr)
        sys.exit(1)
