import copy
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from promotion_record import prepare, validate_run
from verify_oci import TARGETS

SHA = "b" * 40
ENVIRONMENT = {"GITHUB_STEP_SUMMARY": ""}
RUN = {"id": 99, "name": "Candidate images", "event": "workflow_dispatch", "head_branch": "main",
       "status": "completed", "conclusion": "success", "head_sha": SHA,
       "html_url": "https://github.com/RhianB14/stakeframe/actions/runs/99",
       "repository": {"full_name": "RhianB14/stakeframe"}}


def digest_of(text):
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()


def evidence(directory, arch):
    directory.mkdir()
    tag = "candidate-" + SHA + "-" + arch
    images = [{"target": target, "indexDigest": digest_of(arch + "-raw-" + target)} for target in TARGETS]
    candidate = {"version": 1, "status": "candidate", "sourceSha": SHA, "architecture": arch,
                 "createdAt": "2026-09-25T00:00:00+00:00", "ciRunId": 99, "images": images,
                 "published": False, "productionAuthorized": False}
    (directory / "candidate.json").write_text(json.dumps(candidate))
    published = {"version": 1, "sourceSha": SHA, "architecture": arch, "tag": tag,
                 "published": True, "productionDeployed": False,
                 "images": [{"target": target, "repository": "ghcr.io/rhianb14/stakeframe-" + target, "tag": tag,
                             "digest": digest_of(arch + "-raw-" + target)} for target in TARGETS]}
    (directory / "published.json").write_text(json.dumps(published))
    return published


class PromotionRecordTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.amd64 = self.root / "amd64"
        self.arm64 = self.root / "arm64"
        evidence(self.amd64, "amd64")
        evidence(self.arm64, "arm64")
        self.output = self.root / "record" / "promotion-record.json"

    def tearDown(self):
        self.temporary.cleanup()

    @patch.dict(os.environ, ENVIRONMENT)
    def test_prepare_composes_the_record_from_both_architectures(self):
        prepare(copy.deepcopy(RUN), self.amd64, self.arm64, "stakeframe-v1", "RhianB14", self.output)
        record = json.loads(self.output.read_text())
        self.assertEqual(record["sourceSha"], SHA)
        self.assertEqual(record["candidateRunId"], 99)
        self.assertEqual(record["deploymentId"], "stakeframe-v1")
        self.assertEqual(record["environment"], "production")
        self.assertFalse(record["productionDeployed"])
        self.assertEqual([item["target"] for item in record["images"]], list(TARGETS))
        for item in record["images"]:
            self.assertEqual(item["amd64"]["tag"], "candidate-" + SHA + "-amd64")
            self.assertEqual(item["arm64"]["digest"], digest_of("arm64-raw-" + item["target"]))

    def test_run_validation_refuses_wrong_workflow_branch_or_result(self):
        for mutation, code in [
            ({"name": "Release candidate"}, "RUN_WORKFLOW_REFUSED"),
            ({"event": "push"}, "RUN_EVENT_REFUSED"),
            ({"head_branch": "develop"}, "RUN_BRANCH_REFUSED"),
            ({"conclusion": "failure"}, "RUN_NOT_SUCCESSFUL"),
            ({"status": "in_progress", "conclusion": None}, "RUN_NOT_SUCCESSFUL"),
            ({"head_sha": "bad"}, "RUN_SHA_REQUIRED"),
            ({"repository": {"full_name": "other/repo"}}, "RUN_REPOSITORY_REFUSED"),
        ]:
            run = copy.deepcopy(RUN)
            run.update(mutation)
            with self.subTest(mutation=mutation):
                with self.assertRaisesRegex(ValueError, code):
                    validate_run(run)

    @patch.dict(os.environ, ENVIRONMENT)
    def test_published_digest_divergence_is_refused(self):
        published = json.loads((self.arm64 / "published.json").read_text())
        published["images"][0]["digest"] = digest_of("tampered")
        (self.arm64 / "published.json").write_text(json.dumps(published))
        with self.assertRaisesRegex(ValueError, "DIGEST_MISMATCH"):
            prepare(copy.deepcopy(RUN), self.amd64, self.arm64, "stakeframe-v1", "RhianB14", self.output)

    @patch.dict(os.environ, ENVIRONMENT)
    def test_swapped_architecture_evidence_is_refused(self):
        with self.assertRaisesRegex(ValueError, "EVIDENCE_MISMATCH"):
            prepare(copy.deepcopy(RUN), self.arm64, self.arm64, "stakeframe-v1", "RhianB14", self.output)

    @patch.dict(os.environ, ENVIRONMENT)
    def test_missing_publication_evidence_is_refused(self):
        (self.arm64 / "published.json").unlink()
        with self.assertRaisesRegex(ValueError, "EVIDENCE_MISSING"):
            prepare(copy.deepcopy(RUN), self.amd64, self.arm64, "stakeframe-v1", "RhianB14", self.output)

    @patch.dict(os.environ, ENVIRONMENT)
    def test_invalid_deployment_id_or_requester_is_refused(self):
        with self.assertRaisesRegex(ValueError, "DEPLOYMENT_ID_REFUSED"):
            prepare(copy.deepcopy(RUN), self.amd64, self.arm64, "ab", "RhianB14", self.output)
        with self.assertRaisesRegex(ValueError, "REQUESTER_REFUSED"):
            prepare(copy.deepcopy(RUN), self.amd64, self.arm64, "stakeframe-v1", "not a user!", self.output)

    @patch.dict(os.environ, ENVIRONMENT)
    def test_sha_mismatch_between_run_and_evidence_is_refused(self):
        candidate = json.loads((self.amd64 / "candidate.json").read_text())
        candidate["sourceSha"] = "c" * 40
        (self.amd64 / "candidate.json").write_text(json.dumps(candidate))
        with self.assertRaisesRegex(ValueError, "EVIDENCE_MISMATCH"):
            prepare(copy.deepcopy(RUN), self.amd64, self.arm64, "stakeframe-v1", "RhianB14", self.output)


if __name__ == "__main__":
    unittest.main()
