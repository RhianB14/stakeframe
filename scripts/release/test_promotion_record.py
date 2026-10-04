import copy
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from promotion_record import CANDIDATE_WORKFLOW_PATH, prepare, validate_run
from verify_oci import TARGETS

SHA = "b" * 40
OTHER_SHA = "c" * 40
RUN_ID = 99
ENVIRONMENT = {"GITHUB_STEP_SUMMARY": ""}
# The candidate is identified by its reviewed path, not by its display label.
RUN = {"id": RUN_ID, "name": "Release candidate", "path": CANDIDATE_WORKFLOW_PATH,
       "event": "workflow_dispatch", "head_branch": "main",
       "status": "completed", "conclusion": "success", "head_sha": SHA,
       "html_url": "https://github.com/RhianB14/stakeframe/actions/runs/99",
       "repository": {"full_name": "RhianB14/stakeframe"}}


def digest_of(text):
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()


def image_entry(arch, target):
    return {"target": target, "indexDigest": digest_of(arch + "-raw-" + target),
            "architecture": arch, "provenanceVerified": True}


def evidence(directory, arch, sha=SHA, run_id=RUN_ID, tag_arch=None):
    directory.mkdir()
    tag = "candidate-" + sha + "-" + (tag_arch or arch)
    images = [image_entry(arch, target) for target in TARGETS]
    candidate = {"version": 1, "status": "candidate", "sourceSha": sha, "architecture": arch,
                 "createdAt": "2026-09-25T00:00:00+00:00", "ciRunId": run_id, "images": images,
                 "published": False, "productionAuthorized": False}
    (directory / "candidate.json").write_text(json.dumps(candidate))
    published = {"sourceSha": sha, "candidateRunId": run_id, "tag": tag,
                 "published": True, "productionDeployed": False,
                 "images": [image_entry(arch, target) for target in TARGETS]}
    (directory / "published.json").write_text(json.dumps(published))
    return published


def approval_file(path, sha=SHA, run_id=RUN_ID, digests=None):
    approval = {"version": 1, "sourceSha": sha, "candidateRunId": run_id,
                "images": [{"target": target,
                            "repository": "ghcr.io/rhianb14/stakeframe-" + target,
                            "digest": (digests or {}).get(target, digest_of("arm64-raw-" + target))}
                           for target in TARGETS]}
    path.write_text(json.dumps(approval))
    return path


class PromotionRecordTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.evidence = self.root / "evidence"
        evidence(self.evidence, "arm64")
        self.approval = approval_file(self.root / "approved-arm64.json")
        self.output = self.root / "record" / "promotion-record.json"

    def tearDown(self):
        self.temporary.cleanup()

    @patch.dict(os.environ, ENVIRONMENT)
    def test_prepare_composes_the_record_from_the_approved_evidence(self):
        prepare(copy.deepcopy(RUN), self.evidence, "stakeframe-v1", "RhianB14",
                self.output, self.approval)
        record = json.loads(self.output.read_text())
        self.assertEqual(record["sourceSha"], SHA)
        self.assertEqual(record["candidateRunId"], RUN_ID)
        self.assertEqual(record["approvalSourceSha"], SHA)
        self.assertEqual(record["approvalCandidateRunId"], RUN_ID)
        self.assertEqual(record["deploymentId"], "stakeframe-v1")
        self.assertEqual(record["environment"], "production")
        self.assertEqual(record["architecture"], "arm64")
        self.assertFalse(record["productionDeployed"])
        self.assertEqual([item["target"] for item in record["images"]], list(TARGETS))
        for item in record["images"]:
            self.assertEqual(item["tag"], "candidate-" + SHA + "-arm64")
            self.assertEqual(item["digest"], digest_of("arm64-raw-" + item["target"]))

    @patch.dict(os.environ, ENVIRONMENT)
    def test_record_asserts_no_other_architecture(self):
        # Only arm64 is approved and published, so the record must not carry an
        # amd64 digest nobody verified against the registry.
        prepare(copy.deepcopy(RUN), self.evidence, "stakeframe-v1", "RhianB14",
                self.output, self.approval)
        record = json.loads(self.output.read_text())
        self.assertNotIn("amd64", json.dumps(record))

    def test_run_validation_refuses_wrong_workflow_branch_or_result(self):
        for mutation, code in [
            ({"path": ".github/workflows/candidate-images.yml"}, "RUN_WORKFLOW_REFUSED"),
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

    def test_run_validation_accepts_the_release_candidate_path(self):
        # The live path: the label may be reworded, the reviewed file may not.
        run = copy.deepcopy(RUN)
        run["name"] = "anything the maintainer chooses"
        validate_run(run)

    @patch.dict(os.environ, ENVIRONMENT)
    def test_publication_from_another_build_is_refused(self):
        # The decisive case: a published.json whose digests are internally
        # consistent and whose sha matches the run, but which was produced for
        # a different candidate run than the approval registry names. Without
        # the cross-check this would yield a record attesting to no build.
        published = json.loads((self.evidence / "published.json").read_text())
        published["candidateRunId"] = RUN_ID + 1
        (self.evidence / "published.json").write_text(json.dumps(published))
        with self.assertRaisesRegex(ValueError, "PUBLICATION_NOT_APPROVED"):
            prepare(copy.deepcopy(RUN), self.evidence, "stakeframe-v1", "RhianB14",
                    self.output, self.approval)

    @patch.dict(os.environ, ENVIRONMENT)
    def test_candidate_run_not_named_by_the_approval_is_refused(self):
        with self.assertRaisesRegex(ValueError, "RUN_NOT_APPROVED"):
            prepare(copy.deepcopy(RUN), self.evidence, "stakeframe-v1", "RhianB14",
                    self.output, approval_file(self.root / "other.json", run_id=RUN_ID + 1))

    @patch.dict(os.environ, ENVIRONMENT)
    def test_digest_outside_the_approval_is_refused(self):
        # Evidence that matches itself but not the approved digests: a build
        # that was verified and published without ever being approved.
        approval_file(self.root / "strict.json",
                      digests={target: digest_of("other-raw-" + target) for target in TARGETS})
        with self.assertRaisesRegex(ValueError, "DIGEST_NOT_APPROVED"):
            prepare(copy.deepcopy(RUN), self.evidence, "stakeframe-v1", "RhianB14",
                    self.output, self.root / "strict.json")

    @patch.dict(os.environ, ENVIRONMENT)
    def test_published_digest_divergence_is_refused(self):
        published = json.loads((self.evidence / "published.json").read_text())
        published["images"][0]["indexDigest"] = digest_of("tampered")
        (self.evidence / "published.json").write_text(json.dumps(published))
        with self.assertRaisesRegex(ValueError, "DIGEST_MISMATCH"):
            prepare(copy.deepcopy(RUN), self.evidence, "stakeframe-v1", "RhianB14",
                    self.output, self.approval)

    @patch.dict(os.environ, ENVIRONMENT)
    def test_missing_publication_evidence_is_refused(self):
        (self.evidence / "published.json").unlink()
        with self.assertRaisesRegex(ValueError, "EVIDENCE_MISSING"):
            prepare(copy.deepcopy(RUN), self.evidence, "stakeframe-v1", "RhianB14",
                    self.output, self.approval)

    @patch.dict(os.environ, ENVIRONMENT)
    def test_evidence_path_must_be_the_download_directory_not_a_file(self):
        with self.assertRaisesRegex(ValueError, "EVIDENCE_MISSING"):
            prepare(
                copy.deepcopy(RUN),
                self.evidence / "candidate.json",
                "stakeframe-v1",
                "RhianB14",
                self.output,
                self.approval,
            )

    @patch.dict(os.environ, ENVIRONMENT)
    def test_invalid_deployment_id_or_requester_is_refused(self):
        with self.assertRaisesRegex(ValueError, "DEPLOYMENT_ID_REFUSED"):
            prepare(copy.deepcopy(RUN), self.evidence, "ab", "RhianB14", self.output, self.approval)
        with self.assertRaisesRegex(ValueError, "REQUESTER_REFUSED"):
            prepare(copy.deepcopy(RUN), self.evidence, "stakeframe-v1", "not a user!", self.output, self.approval)

    @patch.dict(os.environ, ENVIRONMENT)
    def test_sha_mismatch_between_run_and_evidence_is_refused(self):
        candidate = json.loads((self.evidence / "candidate.json").read_text())
        candidate["sourceSha"] = OTHER_SHA
        (self.evidence / "candidate.json").write_text(json.dumps(candidate))
        with self.assertRaisesRegex(ValueError, "EVIDENCE_MISMATCH"):
            prepare(copy.deepcopy(RUN), self.evidence, "stakeframe-v1", "RhianB14",
                    self.output, self.approval)

    @patch.dict(os.environ, ENVIRONMENT)
    def test_amd64_evidence_is_refused_for_the_deployment_architecture(self):
        other = self.root / "amd64"
        evidence(other, "amd64")
        with self.assertRaisesRegex(ValueError, "EVIDENCE_MISMATCH"):
            prepare(copy.deepcopy(RUN), other, "stakeframe-v1", "RhianB14",
                    self.output, self.approval)


if __name__ == "__main__":
    unittest.main()
