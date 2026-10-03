import copy
import hashlib
import json
import os
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from manifest import manifest
from publication import unpack_approved, verify_images, publish, registry_readback
from test_oci import fixture, SHA
from verify_oci import TARGETS, verify

PUBLISH_ENVIRONMENT = {"GITHUB_ACTOR": "RhianB14", "GITHUB_TOKEN": "token-value", "GITHUB_STEP_SUMMARY": ""}


def candidate(directory):
    directory.mkdir()
    (directory / "source-validation.json").write_text(json.dumps({"version": 1, "sourceSha": SHA, "ciRunId": 123, "checks": [
        "format-check", "application-check", "application-arm64-check", "network-security-simulation", "recovery-check", "promotion-check"]}))
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


def index_bytes(directory, target, digest):
    """The real OCI index blob whose sha256 IS `digest`, so the readback
    verification in publication.py runs for real instead of against a stub."""
    with tarfile.open(directory / (target + ".oci.tar"), "r") as archive:
        member = archive.extractfile("blobs/sha256/" + digest[7:])
        if member is None:
            raise AssertionError("index blob absent from fixture")
        return member.read()


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

    @patch.dict(os.environ, PUBLISH_ENVIRONMENT)
    def test_absent_tag_is_copied_and_readback_verified(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            approval = candidate(root / "archives")
            summary = root / "summary.md"
            summary.write_text("")
            digests = [(item["target"], item["digest"]) for item in approval["images"]]
            with patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}), \
                 patch("publication.read_tag_digest", return_value=None), \
                 patch("publication.subprocess.run") as command, \
                 patch("publication.subprocess.check_output",
                       side_effect=[index_bytes(root / "archives", target, digest)
                                    for target, digest in digests]) as readback:
                publish(root, approval)
            copies = [call for call in command.call_args_list if call.args[0][1] == "copy"]
            self.assertEqual(len(copies), 5)
            for call in copies:
                self.assertIn("--preserve-digests", call.args[0])
                self.assertTrue(call.args[0][-1].endswith(":candidate-" + SHA + "-arm64"))
            self.assertEqual(readback.call_count, 5)
            self.assertTrue(json.loads((root / "published.json").read_text())["published"])

    @patch.dict(os.environ, PUBLISH_ENVIRONMENT)
    def test_existing_tag_with_same_digest_is_left_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            approval = candidate(root / "archives")
            summary = root / "summary.md"
            summary.write_text("")
            with patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}), \
                 patch("publication.read_tag_digest", side_effect=[item["digest"] for item in approval["images"]]), \
                 patch("publication.subprocess.run") as command, \
                 patch("publication.subprocess.check_output") as readback:
                publish(root, approval)
            self.assertEqual([call for call in command.call_args_list if call.args[0][1] == "copy"], [])
            readback.assert_not_called()
            self.assertEqual(json.loads((root / "published.json").read_text())["published"], True)

    @patch.dict(os.environ, PUBLISH_ENVIRONMENT)
    def test_moving_an_existing_tag_is_refused_before_any_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            approval = candidate(root / "archives")
            summary = root / "summary.md"
            summary.write_text("")
            with patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}), \
                 patch("publication.read_tag_digest", return_value="sha256:" + "b" * 64), \
                 patch("publication.subprocess.run") as command, \
                 patch("publication.subprocess.check_output") as readback:
                with self.assertRaisesRegex(ValueError, "PUBLICATION_TAG_IMMUTABLE_REFUSED"):
                    publish(root, approval)
            self.assertEqual([call for call in command.call_args_list if call.args[0][1] == "copy"], [])
            readback.assert_not_called()
            self.assertFalse((root / "published.json").exists())




if __name__ == "__main__":
    unittest.main()
