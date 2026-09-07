import copy
import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from manifest import manifest
from publication import unpack_approved, verify_images, publish, registry_readback
from test_oci import fixture, SHA
from verify_oci import TARGETS, verify


def candidate(directory):
    directory.mkdir()
    (directory / "source-validation.json").write_text(json.dumps({"version": 1, "sourceSha": SHA, "ciRunId": 123, "checks": [
        "format-check", "application-check", "application-arm64-check", "network-security-simulation", "recovery-check"]}))
    for target in TARGETS:
        with tempfile.TemporaryDirectory() as tmp:
            archive, metadata = fixture(Path(tmp), target=target)
            destination = directory / (target + ".oci.tar")
            destination.write_bytes(archive.read_bytes())
            (directory / (target + ".metadata.json")).write_text(json.dumps(metadata))
            (directory / (target + ".verified.json")).write_text(json.dumps(verify(destination, metadata, SHA, "arm64", target)))
    result = manifest(directory, SHA, "arm64")
    return {"sourceSha": SHA, "sourceCiRunId": 123, "candidateRunId": 456, "architecture": "arm64", "visibility": "public",
            "images": [{"target": item["target"], "repository": "ghcr.io/rhianb14/stakeframe-" + item["target"], "digest": item["indexDigest"]} for item in result["images"]]}


def bundle(directory, approval, extra=None):
    archive = directory.parent / "approved.zip"
    with zipfile.ZipFile(archive, "w") as output:
        for path in directory.iterdir():
            output.write(path, path.name)
        if extra:
            output.writestr(extra, "refused")
    approval["artifact"] = {"bytes": archive.stat().st_size, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}
    return archive


class PublicationTests(unittest.TestCase):
    def test_exact_approved_zip_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            approval = candidate(root / "source")
            archive = bundle(root / "source", approval)
            unpack_approved(archive, root / "archives", approval)
            self.assertEqual(len(verify_images(root / "archives", approval)["images"]), 5)

    def test_zip_digest_and_unexpected_entries_fail_before_extraction(self):
        for extra in (None, "../outside", "candidate.json"):
            with self.subTest(extra=extra), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                approval = candidate(root / "source")
                archive = bundle(root / "source", approval, extra)
                if extra is None:
                    approval["artifact"]["sha256"] = "0" * 64
                with self.assertRaises(ValueError):
                    unpack_approved(archive, root / "archives", approval)
                self.assertFalse((root / "archives").exists())

    def test_last_target_tamper_or_unapproved_digest_blocks_all_registry_writes(self):
        for mutation in ("bytes", "digest", "destination", "manifest"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                approval = candidate(root / "archives")
                if mutation == "bytes":
                    (root / "archives" / "operations.oci.tar").write_bytes(b"corrupt")
                elif mutation == "digest":
                    approval["images"][-1]["digest"] = "sha256:" + "0" * 64
                elif mutation == "destination":
                    approval["images"][-1]["repository"] = "ghcr.io/other/repo"
                else:
                    report = json.loads((root / "archives" / "candidate.json").read_text())
                    report["images"] = []
                    (root / "archives" / "candidate.json").write_text(json.dumps(report))
                with patch("publication.subprocess.run") as command:
                    with self.assertRaises(Exception):
                        publish(root, copy.deepcopy(approval))
                    command.assert_not_called()

    def test_registry_readback_hashes_actual_bytes(self):
        with patch("publication.subprocess.check_output", return_value=b"wrong manifest"):
            with self.assertRaisesRegex(ValueError, "REGISTRY_DIGEST_MISMATCH"):
                registry_readback("ghcr.io/rhianb14/stakeframe-api", "sha256:" + "0" * 64, [])


if __name__ == "__main__":
    unittest.main()
