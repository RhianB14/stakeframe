"""Produce the review manifest only after verifying every archived target again."""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from verify_oci import TARGETS, require, verify


def manifest(directory, sha, arch):
    source = json.loads((directory / "source-validation.json").read_text())
    require(source.get("version") == 1 and source.get("sourceSha") == sha, "RELEASE_SOURCE_MISMATCH")
    require(type(source.get("ciRunId")) is int and source["ciRunId"] > 0, "RELEASE_CI_REQUIRED")
    require(sorted(source.get("checks", [])) == sorted([
        "format-check", "application-check", "application-arm64-check",
        "network-security-simulation", "recovery-check"]), "RELEASE_CHECKS_REQUIRED")
    images = []
    for target in TARGETS:
        metadata = json.loads((directory / (target + ".metadata.json")).read_text())
        verified = verify(directory / (target + ".oci.tar"), metadata, sha, arch, target)
        require(verified == json.loads((directory / (target + ".verified.json")).read_text()), "RELEASE_ARCHIVE_CHANGED")
        images.append(verified)
    result = {"version": 1, "status": "candidate", "sourceSha": sha,
              "architecture": arch, "createdAt": datetime.now(timezone.utc).isoformat(),
              "ciRunId": source["ciRunId"], "images": images,
              "published": False, "productionAuthorized": False}
    with (directory / "candidate.json").open("x", encoding="utf-8") as output:
        json.dump(result, output, indent=2)
        output.write("\n")
    lines = ["# Stakeframe — candidato " + arch, "", "Commit: `" + sha + "`.", "",
             "Arquivos OCI verificados. Publicação e produção ainda não autorizadas.", "",
             "| Target | Digest do índice OCI | Bytes |", "| --- | --- | --- |"]
    lines.extend(f"| {image['target']} | `{image['indexDigest']}` | {image['archiveBytes']} |" for image in images)
    lines.extend(["", "O manifesto JSON registra checksums dos arquivos, manifests executáveis e proveniência.",
                  "Retenção no GitHub: 1 dia. Um novo build exige nova conferência dos digests.", ""])
    (directory / "summary.md").write_text("\n".join(lines), encoding="utf-8")
    return result


if __name__ == "__main__":
    folder, source_sha, architecture = sys.argv[1:]
    manifest(Path(folder), source_sha, architecture)
    print("RELEASE_CANDIDATE_VERIFIED", architecture)
