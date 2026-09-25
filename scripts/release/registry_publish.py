"""Publish verified candidate indexes to GHCR preserving their digests.

Reads the verified `candidate.json` produced by `manifest.py`, copies each OCI
archive with `skopeo copy --all --preserve-digests` under an immutable
sha-specific tag (`candidate-<sha>-<arch>`), refuses to move an existing tag to
a different digest, and proves the registry readback by hashing the raw
manifest bytes. No `latest`, no mutable tags, no production access.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from verify_oci import TARGETS, require

REGISTRY = "ghcr.io"
NAMESPACE = "rhianb14"
DIGEST = re.compile(r"sha256:[a-f0-9]{64}\Z")
SOURCE_SHA = re.compile(r"[a-f0-9]{40}\Z")


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def validate_candidate(candidate, arch):
    require(candidate.get("version") == 1 and candidate.get("status") == "candidate", "PUBLICATION_CANDIDATE_INVALID")
    require(candidate.get("architecture") == arch, "PUBLICATION_ARCHITECTURE_MISMATCH")
    sha = candidate.get("sourceSha")
    require(bool(SOURCE_SHA.fullmatch(sha or "")), "PUBLICATION_SOURCE_REQUIRED")
    images = candidate.get("images", [])
    require([item.get("target") for item in images] == list(TARGETS), "PUBLICATION_TARGETS_REQUIRED")
    for item in images:
        require(item.get("architecture") == arch and item.get("sourceSha") == sha, "PUBLICATION_CANDIDATE_INVALID")
        require(bool(DIGEST.fullmatch(item.get("indexDigest", ""))), "PUBLICATION_DIGEST_INVALID")
    return sha, images


def read_tag_digest(repository, tag, auth):
    """None when the tag does not exist; the actual manifest digest otherwise."""
    result = subprocess.run(["skopeo", "inspect", "--raw", *auth, "docker://" + repository + ":" + tag], capture_output=True)
    if result.returncode == 0:
        return "sha256:" + hashlib.sha256(result.stdout).hexdigest()
    stderr = result.stderr.lower()
    if b"manifest unknown" in stderr or b"name unknown" in stderr:
        return None
    raise ValueError("PUBLICATION_TAG_INSPECT_FAILED")


def registry_readback(repository, digest, auth):
    raw = subprocess.check_output(["skopeo", "inspect", "--raw", *auth, "docker://" + repository + "@" + digest])
    require("sha256:" + hashlib.sha256(raw).hexdigest() == digest, "PUBLICATION_REGISTRY_DIGEST_MISMATCH")


def publish(directory, arch):
    candidate = read_json(Path(directory) / "candidate.json")
    sha, images = validate_candidate(candidate, arch)
    tag = "candidate-" + sha + "-" + arch
    published = []
    with tempfile.TemporaryDirectory(prefix="stk-registry-auth-") as temporary:
        authfile = str(Path(temporary) / "auth.json")
        subprocess.run(
            ["skopeo", "login", "--authfile", authfile, "--username", os.environ["GITHUB_ACTOR"], "--password-stdin", REGISTRY],
            input=os.environ["GITHUB_TOKEN"],
            text=True,
            check=True,
        )
        auth = ["--authfile", authfile]
        for item in images:
            target = item["target"]
            repository = REGISTRY + "/" + NAMESPACE + "/stakeframe-" + target
            existing = read_tag_digest(repository, tag, auth)
            if existing != item["indexDigest"]:
                require(existing is None, "PUBLICATION_TAG_IMMUTABLE_REFUSED")
                subprocess.run(
                    ["skopeo", "copy", *auth, "--all", "--preserve-digests",
                     "oci-archive:" + str(Path(directory) / (target + ".oci.tar")), "docker://" + repository + ":" + tag],
                    check=True,
                )
                registry_readback(repository, item["indexDigest"], auth)
                print("PUBLICATION_REGISTRY_VERIFIED", target, item["indexDigest"], flush=True)
            else:
                print("PUBLICATION_ALREADY_PRESENT", target, tag, flush=True)
            published.append({"target": target, "repository": repository, "tag": tag, "digest": item["indexDigest"]})
    evidence = {"version": 1, "sourceSha": sha, "architecture": arch, "tag": tag,
                "published": True, "productionDeployed": False, "images": published}
    (Path(directory) / "published.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    lines = ["## Candidate publication " + arch, "", "Source: `" + sha + "`", ""]
    lines.extend("- `" + item["repository"] + "@" + item["digest"] + "` (`" + tag + "`)" for item in published)
    lines.extend(["", "Registry digests verified by readback. Production deployment remains pending", "and is manual, by digest, in a separate authorized window.", ""])
    summary = Path(directory) / "summary.md"
    if summary.is_file():
        with summary.open("a", encoding="utf-8") as stream:
            stream.write("\n" + "\n".join(lines))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a", encoding="utf-8") as stream:
            stream.write("\n".join(lines) + "\n")
    print("PUBLICATION_FIVE_INDEXES_PUBLISHED", arch, tag)


if __name__ == "__main__":
    try:
        arguments = sys.argv[1:]
        require(len(arguments) >= 1 and arguments[0] == "publish", "PUBLICATION_COMMAND_REQUIRED")
        flags = dict(zip(arguments[1::2], arguments[2::2]))
        require(set(flags) == {"--directory", "--arch"} and len(arguments) == 5, "PUBLICATION_COMMAND_REQUIRED")
        publish(flags["--directory"], flags["--arch"])
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print("PUBLICATION_FAILED", str(error) if isinstance(error, ValueError) else type(error).__name__, file=sys.stderr)
        sys.exit(1)
