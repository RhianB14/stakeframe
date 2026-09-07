"""Publish only the owner-approved archives, preserving their OCI indexes."""
import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from verify_oci import TARGETS, require, verify

APPROVAL = Path("infra/release/approved-arm64.json")
DIRECTORY = Path(".cache/publication")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def validate_approval(approval):
    require(approval["architecture"] == "arm64", "PUBLICATION_ARM64_REQUIRED")
    require(approval["visibility"] == "public", "PUBLICATION_VISIBILITY_REQUIRED")
    require([item["target"] for item in approval["images"]] == list(TARGETS), "PUBLICATION_TARGETS_REQUIRED")
    for item in approval["images"]:
        require(item["repository"] == "ghcr.io/rhianb14/stakeframe-" + item["target"], "PUBLICATION_DESTINATION_REFUSED")


def unpack_approved(archive, directory, approval):
    validate_approval(approval)
    require(archive.stat().st_size == approval["artifact"]["bytes"], "PUBLICATION_ZIP_SIZE_MISMATCH")
    with archive.open("rb") as stream:
        require(hashlib.file_digest(stream, "sha256").hexdigest() == approval["artifact"]["sha256"], "PUBLICATION_ZIP_DIGEST_MISMATCH")
    allowed = {target + suffix for target in TARGETS for suffix in (".oci.tar", ".metadata.json", ".verified.json")}
    allowed.update(("candidate.json", "source-validation.json", "summary.md"))
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        require(len(entries) == len(allowed) and {item.filename for item in entries} == allowed, "PUBLICATION_ZIP_ENTRIES_REFUSED")
        require(sum(item.file_size for item in entries) <= 2 * 1024 ** 3, "PUBLICATION_ZIP_TOO_LARGE")
        for item in entries:
            mode = item.external_attr >> 16
            require(not item.is_dir() and (stat.S_IFMT(mode) in (0, stat.S_IFREG)), "PUBLICATION_ZIP_SPECIAL_REFUSED")
            require(not item.flag_bits & 1, "PUBLICATION_ZIP_ENCRYPTED_REFUSED")
            limit = 1024 ** 3 if item.filename.endswith(".oci.tar") else 8 * 1024 ** 2
            require(item.file_size <= limit, "PUBLICATION_ZIP_ENTRY_TOO_LARGE")
        directory.mkdir()
        for item in entries:
            with bundle.open(item) as source, (directory / item.filename).open("xb") as output:
                while chunk := source.read(1024 * 1024):
                    output.write(chunk)


def verify_images(directory, approval):
    validate_approval(approval)
    source = read_json(directory / "source-validation.json")
    require(source["sourceSha"] == approval["sourceSha"] and source["ciRunId"] == approval["sourceCiRunId"], "PUBLICATION_SOURCE_MISMATCH")
    candidate = read_json(directory / "candidate.json")
    require(candidate["sourceSha"] == approval["sourceSha"] and candidate["architecture"] == "arm64", "PUBLICATION_CANDIDATE_MISMATCH")
    images = []
    for approved in approval["images"]:
        target = approved["target"]
        result = verify(directory / (target + ".oci.tar"), read_json(directory / (target + ".metadata.json")), approval["sourceSha"], "arm64", target)
        require(result["indexDigest"] == approved["digest"], "PUBLICATION_INDEX_NOT_APPROVED")
        require(result == read_json(directory / (target + ".verified.json")), "PUBLICATION_ARCHIVE_CHANGED")
        images.append(result)
    require(images == candidate["images"], "PUBLICATION_MANIFEST_CHANGED")
    return {"sourceSha": approval["sourceSha"], "candidateRunId": approval["candidateRunId"], "images": images}


def registry_readback(repository, digest, auth):
    raw = subprocess.check_output(["skopeo", "inspect", "--raw", *auth, "docker://" + repository + "@" + digest])
    require("sha256:" + hashlib.sha256(raw).hexdigest() == digest, "PUBLICATION_REGISTRY_DIGEST_MISMATCH")


def publish(directory, approval):
    # Recheck all five files before the first write, including on a resumed run.
    result = verify_images(directory / "archives", approval)
    tag = "candidate-" + approval["sourceSha"] + "-arm64"
    with tempfile.TemporaryDirectory(prefix="stk-registry-auth-") as temporary:
        authfile = str(Path(temporary) / "auth.json")
        subprocess.run(["skopeo", "login", "--authfile", authfile, "--username", os.environ["GITHUB_ACTOR"], "--password-stdin", "ghcr.io"], input=os.environ["GITHUB_TOKEN"], text=True, check=True)
        auth = ["--authfile", authfile]
        for item in approval["images"]:
            subprocess.run(["skopeo", "copy", *auth, "--all", "--preserve-digests", "oci-archive:" + str(directory / "archives" / (item["target"] + ".oci.tar")), "docker://" + item["repository"] + ":" + tag], check=True)
            registry_readback(item["repository"], item["digest"], auth)
            print("PUBLICATION_REGISTRY_VERIFIED", item["target"], item["digest"], flush=True)
    result.update({"published": True, "publicAccessVerified": False, "productionDeployed": False, "tag": tag})
    (directory / "published.json").write_text(json.dumps(result, indent=2) + "\n")
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as summary:
        summary.write("## Approved ARM64 publication\n\nSource: `" + approval["sourceSha"] + "`\n\n")
        for item in approval["images"]:
            summary.write("- `" + item["repository"] + "@" + item["digest"] + "`\n")
        summary.write("\nRegistry digests verified. Public visibility and anonymous reads require the separate post-publication check. Production deployment remains pending.\n")


if __name__ == "__main__":
    approval = read_json(APPROVAL)
    if sys.argv[1:] == ["verify"]:
        unpack_approved(DIRECTORY / "approved.zip", DIRECTORY / "archives", approval)
        result = verify_images(DIRECTORY / "archives", approval)
        (DIRECTORY / "verified.json").write_text(json.dumps(result, indent=2) + "\n")
        print("PUBLICATION_FIVE_APPROVED_ARCHIVES_VERIFIED")
    elif sys.argv[1:] == ["publish"]:
        publish(DIRECTORY, approval)
    else:
        raise ValueError("PUBLICATION_COMMAND_REQUIRED")
