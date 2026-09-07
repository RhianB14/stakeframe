"""Inspect OCI bytes without extracting archive paths or executing image content."""
import hashlib
import json
import re
import sys
import tarfile
from pathlib import Path

INDEX = "application/vnd.oci.image.index.v1+json"
MANIFEST = "application/vnd.oci.image.manifest.v1+json"
CONFIG = "application/vnd.oci.image.config.v1+json"
ATTESTATION = "application/vnd.in-toto+json"
SOURCE = "https://github.com/RhianB14/stakeframe"
TARGETS = ("api", "worker", "migrate", "web-production", "operations")
SHA = re.compile(r"sha256:[a-f0-9]{64}\Z")
MAX_ARCHIVE = 2 * 1024**3
MAX_JSON = 8 * 1024**2


def require(condition, code):
    if not condition:
        raise ValueError(code)


def read_archive(path):
    require(path.is_file() and not path.is_symlink(), "OCI_FILE_REQUIRED")
    require(0 < path.stat().st_size <= MAX_ARCHIVE, "OCI_ARCHIVE_LIMIT")
    blobs, documents, seen = {}, {}, set()
    total = 0
    with tarfile.open(path, mode="r|") as archive:
        for member in archive:
            name = member.name
            require(name not in seen and len(seen) < 10000, "OCI_DUPLICATE_OR_ENTRY_LIMIT")
            seen.add(name)
            if member.isdir():
                require(name.rstrip("/") in ("blobs", "blobs/sha256"), "OCI_DIRECTORY_REFUSED")
                continue
            require(member.isfile(), "OCI_LINK_OR_SPECIAL_REFUSED")
            require(name in ("index.json", "oci-layout") or re.fullmatch(r"blobs/sha256/[a-f0-9]{64}", name), "OCI_PATH_REFUSED")
            total += member.size
            require(0 <= member.size <= MAX_ARCHIVE and total <= MAX_ARCHIVE, "OCI_CONTENT_LIMIT")
            digest, chunks = hashlib.sha256(), []
            stream = archive.extractfile(member)
            count = 0
            while chunk := stream.read(1024**2):
                count += len(chunk)
                digest.update(chunk)
                if member.size <= MAX_JSON:
                    chunks.append(chunk)
            require(count == member.size, "OCI_TRUNCATED")
            actual = digest.hexdigest()
            if name.startswith("blobs/"):
                require(actual == name.split("/")[-1], "OCI_BLOB_CHECKSUM_FAILED")
                blobs["sha256:" + actual] = member.size
            if member.size <= MAX_JSON:
                try:
                    value = json.loads(b"".join(chunks))
                except (ValueError, UnicodeDecodeError):
                    continue
                if isinstance(value, dict):
                    documents[name if not name.startswith("blobs/") else "sha256:" + actual] = value
    require(documents.get("oci-layout") == {"imageLayoutVersion": "1.0.0"}, "OCI_LAYOUT_REQUIRED")
    require("index.json" in documents, "OCI_INDEX_REQUIRED")
    return blobs, documents


def verify(path, metadata, source_sha, arch, target):
    require(bool(re.fullmatch(r"[a-f0-9]{40}", source_sha)), "OCI_SOURCE_SHA_REQUIRED")
    require(arch in ("amd64", "arm64") and target in TARGETS, "OCI_TARGET_REQUIRED")
    blobs, documents = read_archive(path)

    def descriptor(value, media=None):
        require(isinstance(value, dict) and bool(SHA.fullmatch(value.get("digest", ""))), "OCI_DESCRIPTOR_REQUIRED")
        digest = value["digest"]
        require(digest in blobs and blobs[digest] == value.get("size"), "OCI_DESCRIPTOR_SIZE_FAILED")
        if media:
            require(value.get("mediaType") == media, "OCI_MEDIA_TYPE_REFUSED")
            require(digest in documents, "OCI_JSON_REQUIRED")
        return documents.get(digest)

    outer = documents["index.json"]
    require(outer.get("schemaVersion") == 2 and outer.get("mediaType") == INDEX, "OCI_INDEX_INVALID")
    roots = outer.get("manifests", [])
    require(len(roots) == 1, "OCI_SINGLE_ROOT_REQUIRED")
    root = descriptor(roots[0], INDEX)
    require(roots[0]["digest"] == metadata.get("containerimage.digest"), "OCI_BUILD_METADATA_MISMATCH")
    require(root.get("schemaVersion") == 2 and root.get("mediaType") == INDEX, "OCI_ROOT_INVALID")
    manifests = root.get("manifests", [])
    require(len(manifests) == 2, "OCI_RUNTIME_AND_PROVENANCE_REQUIRED")
    images = [item for item in manifests if item.get("platform", {}).get("os") == "linux"]
    require(len(images) == 1 and images[0]["platform"].get("architecture") == arch, "OCI_PLATFORM_MISMATCH")
    image_ref = images[0]
    image = descriptor(image_ref, MANIFEST)
    config = descriptor(image.get("config"), CONFIG)
    require(config.get("os") == "linux" and config.get("architecture") == arch, "OCI_CONFIG_PLATFORM_MISMATCH")
    labels = config.get("config", {}).get("Labels", {})
    require(labels.get("org.opencontainers.image.source") == SOURCE and labels.get("org.opencontainers.image.revision") == source_sha, "OCI_REVISION_MISMATCH")
    require(config.get("config", {}).get("User") in ("node", "1000:1000"), "OCI_NONROOT_REQUIRED")
    layers = image.get("layers", [])
    require(layers, "OCI_LAYERS_REQUIRED")
    for layer in layers:
        require(layer.get("mediaType") in ("application/vnd.oci.image.layer.v1.tar+gzip", "application/vnd.oci.image.layer.v1.tar+zstd", "application/vnd.oci.image.layer.v1.tar"), "OCI_LAYER_TYPE_REFUSED")
        descriptor(layer)
    attestations = [item for item in manifests if item is not image_ref]
    ref = attestations[0]
    annotations = ref.get("annotations", {})
    require(ref.get("platform") == {"architecture": "unknown", "os": "unknown"}, "OCI_ATTESTATION_PLATFORM_INVALID")
    require(annotations.get("vnd.docker.reference.type") == "attestation-manifest" and annotations.get("vnd.docker.reference.digest") == image_ref["digest"], "OCI_ATTESTATION_BINDING_FAILED")
    attestation = descriptor(ref, MANIFEST)
    descriptor(attestation.get("config"), CONFIG)
    proofs = []
    for layer in attestation.get("layers", []):
        statement = descriptor(layer, ATTESTATION)
        if statement.get("predicateType") == "https://slsa.dev/provenance/v0.2":
            proofs.append(statement)
    require(len(proofs) == 1, "OCI_PROVENANCE_REQUIRED")
    proof = proofs[0]
    require(any(subject.get("digest", {}).get("sha256") == image_ref["digest"][7:] for subject in proof.get("subject", [])), "OCI_PROVENANCE_SUBJECT_MISMATCH")
    predicate = proof.get("predicate", {})
    source = predicate.get("invocation", {}).get("configSource", {})
    require(source.get("uri", "").split("#")[0] in (SOURCE + ".git", "git+" + SOURCE + ".git"), "OCI_PROVENANCE_REPOSITORY_MISMATCH")
    require(source.get("digest", {}).get("sha1") == source_sha, "OCI_PROVENANCE_COMMIT_MISMATCH")
    require(predicate.get("buildType") == "https://mobyproject.org/buildkit@v1", "OCI_BUILDER_REQUIRED")
    require(isinstance(predicate.get("buildConfig"), dict), "OCI_MAX_PROVENANCE_REQUIRED")
    require(predicate.get("invocation", {}).get("parameters", {}).get("args", {}).get("target") == target, "OCI_PROVENANCE_TARGET_MISMATCH")
    with path.open("rb") as stream:
        archive_sha = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"version": 1, "sourceSha": source_sha, "architecture": arch, "target": target,
            "archive": path.name, "archiveBytes": path.stat().st_size, "archiveSha256": archive_sha,
            "indexDigest": roots[0]["digest"], "runtimeDigest": image_ref["digest"],
            "provenanceDigest": ref["digest"], "provenanceVerified": True, "nonRootVerified": True}


if __name__ == "__main__":
    try:
        archive, metadata_file, sha, architecture, build_target = sys.argv[1:]
        archive_path = Path(archive)
        result = verify(archive_path, json.loads(Path(metadata_file).read_text()), sha, architecture, build_target)
        output = archive_path.with_name(build_target + ".verified.json")
        with output.open("x", encoding="utf-8") as stream:
            json.dump(result, stream, indent=2)
            stream.write("\n")
        print("OCI_VERIFIED", build_target, architecture, result["indexDigest"])
    except (ValueError, KeyError, TypeError, OSError, tarfile.TarError) as error:
        print("OCI_VERIFICATION_FAILED", str(error) if isinstance(error, ValueError) else type(error).__name__, file=sys.stderr)
        sys.exit(1)
