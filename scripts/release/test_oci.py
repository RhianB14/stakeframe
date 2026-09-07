import hashlib
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from verify_oci import ATTESTATION, CONFIG, INDEX, MANIFEST, SOURCE, TARGETS, verify
from manifest import manifest

SHA = "a" * 40


def fixture(directory, *, revision=SHA, arch="arm64", subject=None, provenance_sha=SHA,
            target="api", user="node", repository=SOURCE + ".git", mutation=None):
    files = {"oci-layout": json.dumps({"imageLayoutVersion": "1.0.0"}).encode()}

    def blob(content, media):
        data = content if isinstance(content, bytes) else json.dumps(content).encode()
        digest = hashlib.sha256(data).hexdigest()
        files["blobs/sha256/" + digest] = data
        return {"mediaType": media, "digest": "sha256:" + digest, "size": len(data)}

    config = blob({"os": "linux", "architecture": arch, "config": {"User": user, "Labels": {
        "org.opencontainers.image.source": SOURCE,
        "org.opencontainers.image.revision": revision}}}, CONFIG)
    image = blob({"schemaVersion": 2, "mediaType": MANIFEST, "config": config,
                  "layers": [blob(b"fictional-layer", "application/vnd.oci.image.layer.v1.tar+gzip")]}, MANIFEST)
    image["platform"] = {"os": "linux", "architecture": arch}
    proof = blob({"subject": [{"digest": {"sha256": subject or image["digest"][7:]}}],
                  "predicateType": "https://slsa.dev/provenance/v0.2", "predicate": {
                      "buildType": "https://mobyproject.org/buildkit@v1", "buildConfig": {},
                      "invocation": {"configSource": {"uri": repository, "digest": {"sha1": provenance_sha}},
                                     "parameters": {"args": {"target": target}}}}}, ATTESTATION)
    attestation = blob({"schemaVersion": 2, "mediaType": MANIFEST, "config": blob({}, CONFIG), "layers": [proof]}, MANIFEST)
    attestation.update({"platform": {"os": "unknown", "architecture": "unknown"}, "annotations": {
        "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": image["digest"]}})
    root = blob({"schemaVersion": 2, "mediaType": INDEX, "manifests": [image, attestation]}, INDEX)
    files["index.json"] = json.dumps({"schemaVersion": 2, "mediaType": INDEX, "manifests": [root]}).encode()
    if mutation:
        mutation(files)
    path = directory / "api.oci.tar"
    with tarfile.open(path, "w") as archive:
        for name, data in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    return path, {"containerimage.digest": root["digest"]}


class OciTests(unittest.TestCase):
    def test_complete_manifest_rechecks_five_archives_and_refuses_a_changed_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            source = {"version": 1, "sourceSha": SHA, "ciRunId": 123, "checks": [
                "format-check", "application-check", "application-arm64-check",
                "network-security-simulation", "recovery-check"]}
            (directory / "source-validation.json").write_text(json.dumps(source))
            for target in TARGETS:
                folder = directory / target
                folder.mkdir()
                archive, metadata = fixture(folder, target=target)
                destination = directory / (target + ".oci.tar")
                archive.rename(destination)
                (directory / (target + ".metadata.json")).write_text(json.dumps(metadata))
                (directory / (target + ".verified.json")).write_text(json.dumps(verify(destination, metadata, SHA, "arm64", target)))
            result = manifest(directory, SHA, "arm64")
            self.assertEqual(len(result["images"]), 5)
            self.assertFalse(result["productionAuthorized"])
            self.assertFalse(result["published"])
            (directory / "operations.oci.tar").write_bytes(b"corrupt")
            with self.assertRaises((ValueError, tarfile.TarError)):
                manifest(directory, SHA, "arm64")

    def test_verifies_all_blobs_and_binds_provenance_to_runtime_and_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            path, metadata = fixture(Path(tmp))
            result = verify(path, metadata, SHA, "arm64", "api")
            self.assertTrue(result["provenanceVerified"])
            self.assertEqual(result["archiveSha256"], hashlib.sha256(path.read_bytes()).hexdigest())

    def test_refuses_revision_architecture_root_and_provenance_mismatches(self):
        cases = [{"revision": "b" * 40}, {"arch": "amd64"}, {"subject": "b" * 64},
                 {"provenance_sha": "b" * 40}, {"target": "worker"}, {"user": "root"},
                 {"repository": "https://github.com/other/repo.git"}]
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                path, metadata = fixture(Path(tmp), **case)
                with self.assertRaises(ValueError):
                    verify(path, metadata, SHA, "arm64", "api")
        with tempfile.TemporaryDirectory() as tmp:
            path, metadata = fixture(Path(tmp))
            metadata["containerimage.digest"] = "sha256:" + "b" * 64
            with self.assertRaisesRegex(ValueError, "METADATA_MISMATCH"):
                verify(path, metadata, SHA, "arm64", "api")

    def test_refuses_corrupt_or_missing_blob_and_traversal(self):
        def corrupt(files):
            name = next(name for name in files if name.startswith("blobs/"))
            files[name] = b"corrupted"
        def missing(files):
            del files[next(name for name in files if name.startswith("blobs/"))]
        def traversal(files):
            files["../outside"] = b"refused"
        for mutation in [corrupt, missing, traversal]:
            with self.subTest(mutation=mutation.__name__), tempfile.TemporaryDirectory() as tmp:
                path, metadata = fixture(Path(tmp), mutation=mutation)
                with self.assertRaises(ValueError):
                    verify(path, metadata, SHA, "arm64", "api")
                self.assertFalse((Path(tmp).parent / "outside").exists())

    def test_refuses_links_and_duplicate_entries_without_extraction(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.REGTYPE]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                path, metadata = fixture(Path(tmp))
                with tarfile.open(path, "a") as archive:
                    entry = tarfile.TarInfo("index.json")
                    entry.type = kind
                    entry.linkname = "../outside"
                    entry.size = 0
                    archive.addfile(entry, io.BytesIO(b""))
                with self.assertRaises(ValueError):
                    verify(path, metadata, SHA, "arm64", "api")


if __name__ == "__main__":
    unittest.main()
