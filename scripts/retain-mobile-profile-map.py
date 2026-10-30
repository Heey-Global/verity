"""Retain only the composed source map whose identity is embedded in the IPA."""

import hashlib
import json
from pathlib import Path
import plistlib
import re
import shutil
import sys
import zipfile


def retain(root, ipa, commit, destination):
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Full profile commit required")
    with zipfile.ZipFile(ipa) as archive:
        names = archive.namelist()
        manifests = [n for n in names if re.fullmatch(r"Payload/[^/]+\.app/verity-profile-map\.json", n)]
        if len(manifests) != 1:
            raise ValueError("Expected exactly one embedded profile identity")
        embedded = json.loads(archive.read(manifests[0]))
        app = manifests[0].rsplit("/", 1)[0]
        info = plistlib.loads(archive.read(app + "/Info.plist"))
        updates = plistlib.loads(archive.read(app + "/Expo.plist"))
        if info.get("VerityProfileCommit") != commit or updates.get("EXUpdatesEnabled") is not False:
            raise ValueError("IPA must bind the profile commit and disable OTA")
    if embedded.get("commit") != commit:
        raise ValueError("Embedded map belongs to another commit")
    matches = []
    for manifest in Path(root).rglob("profiling-artifacts/manifest.json"):
        source_map = manifest.with_name("main.jsbundle.map")
        if not source_map.is_file():
            continue
        identity = json.loads(manifest.read_text())
        digest = hashlib.sha256(source_map.read_bytes()).hexdigest()
        if identity == embedded and identity.get("mapSha256") == digest:
            matches.append((manifest, source_map))
    if len(matches) != 1:
        raise ValueError("Expected exactly one source map matching the built IPA")
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=False)
    for source in matches[0]:
        shutil.copyfile(source, destination / source.name)
    with open(ipa, "rb") as binary:
        ipa_digest = hashlib.file_digest(binary, "sha256").hexdigest()
    (destination / "build.json").write_text(json.dumps({
        "commit": commit,
        "buildNumber": info["CFBundleVersion"],
        "ipaSha256": ipa_digest,
    }, indent=2) + "\n")


if __name__ == "__main__":
    retain(*sys.argv[1:])
