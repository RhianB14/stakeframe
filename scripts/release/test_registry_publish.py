import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from registry_publish import publish, registry_readback
from verify_oci import TARGETS

SHA = "a" * 40
ENVIRONMENT = {"GITHUB_ACTOR": "RhianB14", "GITHUB_TOKEN": "token-value", "GITHUB_STEP_SUMMARY": ""}


def digest_of(text):
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()


def candidate(directory, arch="arm64", targets=TARGETS):
    directory.mkdir(exist_ok=True)
    images = []
    for target in targets:
        images.append({"version": 1, "sourceSha": SHA, "architecture": arch, "target": target,
                       "archive": target + ".oci.tar", "archiveBytes": 1, "archiveSha256": digest_of("archive-" + target),
                       "releaseVersion": "1.0.0", "releaseCreated": "2026-09-25T00:00:00Z",
                       "indexDigest": digest_of(arch + "-raw-" + target), "runtimeDigest": digest_of("runtime-" + target),
                       "provenanceDigest": digest_of("proof-" + target), "provenanceVerified": True, "nonRootVerified": True})
    payload = {"version": 1, "status": "candidate", "sourceSha": SHA, "architecture": arch,
               "createdAt": "2026-09-25T00:00:00+00:00", "ciRunId": 123, "images": images,
               "published": False, "productionAuthorized": False}
    (directory / "candidate.json").write_text(json.dumps(payload))
    return payload


class RegistryPublishTests(unittest.TestCase):
    @patch.dict(os.environ, ENVIRONMENT)
    def test_publishes_every_target_and_records_verified_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate(root)
            with patch("registry_publish.read_tag_digest", return_value=None), \
                 patch("registry_publish.subprocess.run") as command, \
                 patch("registry_publish.subprocess.check_output",
                       side_effect=[("arm64-raw-" + target).encode() for target in TARGETS]) as readback:
                publish(root, "arm64")
            copies = [call for call in command.call_args_list if call.args[0][1] == "copy"]
            self.assertEqual(len(copies), 5)
            for call in copies:
                self.assertIn("--preserve-digests", call.args[0])
                self.assertTrue(call.args[0][-1].startswith("docker://ghcr.io/rhianb14/stakeframe-"))
                self.assertTrue(call.args[0][-1].endswith(":candidate-" + SHA + "-arm64"))
            self.assertEqual(readback.call_count, 5)
            evidence = json.loads((root / "published.json").read_text())
            self.assertTrue(evidence["published"] and not evidence["productionDeployed"])
            self.assertEqual([item["target"] for item in evidence["images"]], list(TARGETS))
            self.assertEqual(evidence["tag"], "candidate-" + SHA + "-arm64")

    @patch.dict(os.environ, ENVIRONMENT)
    def test_existing_tag_with_same_digest_is_left_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate(root)
            digests = [digest_of("arm64-raw-" + target) for target in TARGETS]
            with patch("registry_publish.read_tag_digest", side_effect=digests), \
                 patch("registry_publish.subprocess.run") as command, \
                 patch("registry_publish.subprocess.check_output") as readback:
                publish(root, "arm64")
            self.assertEqual([call for call in command.call_args_list if call.args[0][1] == "copy"], [])
            readback.assert_not_called()
            self.assertEqual(json.loads((root / "published.json").read_text())["published"], True)

    @patch.dict(os.environ, ENVIRONMENT)
    def test_moving_an_existing_tag_is_refused_before_any_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate(root)
            with patch("registry_publish.read_tag_digest", return_value=digest_of("other-content")), \
                 patch("registry_publish.subprocess.run") as command:
                with self.assertRaisesRegex(ValueError, "TAG_IMMUTABLE_REFUSED"):
                    publish(root, "arm64")
            self.assertEqual([call for call in command.call_args_list if call.args[0][1] == "copy"], [])
            self.assertFalse((root / "published.json").exists())

    @patch.dict(os.environ, ENVIRONMENT)
    def test_architecture_mismatch_refuses_before_registry_access(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate(root, arch="arm64")
            with patch("registry_publish.subprocess.run") as command:
                with self.assertRaisesRegex(ValueError, "ARCHITECTURE_MISMATCH"):
                    publish(root, "amd64")
            command.assert_not_called()

    @patch.dict(os.environ, ENVIRONMENT)
    def test_missing_target_refuses_before_registry_access(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate(root, targets=TARGETS[:-1])
            with patch("registry_publish.subprocess.run") as command:
                with self.assertRaisesRegex(ValueError, "TARGETS_REQUIRED"):
                    publish(root, "arm64")
            command.assert_not_called()

    def test_registry_readback_hashes_actual_bytes(self):
        with patch("registry_publish.subprocess.check_output", return_value=b"wrong manifest"):
            with self.assertRaisesRegex(ValueError, "REGISTRY_DIGEST_MISMATCH"):
                registry_readback("ghcr.io/rhianb14/stakeframe-api", "sha256:" + "0" * 64, [])


if __name__ == "__main__":
    unittest.main()
