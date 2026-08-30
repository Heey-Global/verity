import hashlib, importlib.util, io, json, pathlib, tarfile, tempfile, unittest, urllib.error, urllib.request
from unittest import mock

SPEC = importlib.util.spec_from_file_location("import_snapshot", pathlib.Path(__file__).parents[1] / "scripts/import_snapshot.py")
mod = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(mod)
POLICY = {"allowed_paths": [], "allowed_prefixes": ["public"], "protected_prefixes": [".git", ".github", "scripts"], "max_files": 10, "max_file_bytes": 1024, "max_total_bytes": 4096}

def fixture(name="public/example.txt", data=b"public fixture\n"):
    entry = {"path": name, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "mode": "0644"}
    config = {"files": [entry], "license": "Apache-2.0", "notice_required": False, "notice_sha256": None, "schema": mod.SCHEMA, "source_sha": "1" * 40}
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:gz") as tf:
        info = tarfile.TarInfo(name); info.size = len(data); info.mode = 0o644; info.mtime = 0
        tf.addfile(info, io.BytesIO(data))
    return mod.canonical(config), out.getvalue()

class ImportSnapshotTests(unittest.TestCase):
    def test_redirect_chain_rejects_an_unsafe_later_hop(self):
        class Opener:
            def __init__(self): self.urls = []
            def open(self, request):
                self.urls.append(request.full_url)
                target = "https://cdn.example/two" if len(self.urls) == 1 else "http://metadata.internal/latest"
                raise urllib.error.HTTPError(request.full_url, 302, "redirect", {"Location": target}, None)
        opener = Opener()
        with self.assertRaisesRegex(ValueError, "unsafe registry redirect"):
            mod.open_redirect_chain(opener, urllib.request.Request("https://ghcr.io/one"), 10)
        self.assertEqual(opener.urls, ["https://ghcr.io/one", "https://cdn.example/two"])

    def test_valid_synthetic_snapshot(self):
        config, files = mod.verify(*fixture(), POLICY)
        self.assertEqual(config["source_sha"], "1" * 40)
        self.assertEqual(files[pathlib.PurePosixPath("public/example.txt")], b"public fixture\n")

    def test_rejects_path_traversal(self):
        with self.assertRaisesRegex(ValueError, "unsafe path"):
            mod.verify(*fixture("../secret"), POLICY)

    def test_rejects_noncanonical_path(self):
        with self.assertRaisesRegex(ValueError, "unsafe path"):
            mod.verify(*fixture("public//example.txt"), POLICY)

    def test_rejects_disallowed_destination(self):
        with self.assertRaisesRegex(ValueError, "disallowed"):
            mod.verify(*fixture("private/example.txt"), POLICY)

    def test_rejects_noncanonical_manifest(self):
        config, layer = fixture()
        with self.assertRaisesRegex(ValueError, "canonical"):
            mod.verify(json.dumps(json.loads(config), indent=2).encode(), layer, POLICY)

    def test_rejects_symlink(self):
        config, _ = fixture(); out = io.BytesIO()
        with tarfile.open(fileobj=out, mode="w:gz") as tf:
            info = tarfile.TarInfo("public/example.txt"); info.type = tarfile.SYMTYPE; info.linkname = "/etc/passwd"; tf.addfile(info)
        with self.assertRaisesRegex(ValueError, "non-regular"):
            mod.verify(config, out.getvalue(), POLICY)

    def test_apply_rejects_destination_symlink(self):
        config_raw, layer = fixture(); config, files = mod.verify(config_raw, layer, POLICY)
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp); (root / "public").symlink_to("/tmp", target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "symlink destination"):
                mod.apply(root, config, files, POLICY)

    def test_apply_rejects_directory_collision(self):
        config_raw, layer = fixture(); config, files = mod.verify(config_raw, layer, POLICY)
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "public/example.txt"; target.mkdir(parents=True)
            (target / "unrelated").write_text("keep")
            with self.assertRaisesRegex(ValueError, "non-file destination"):
                mod.apply(pathlib.Path(tmp), config, files, POLICY)
            self.assertEqual((target / "unrelated").read_text(), "keep")

    def test_successful_apply(self):
        config_raw, layer = fixture(); config, files = mod.verify(config_raw, layer, POLICY)
        with tempfile.TemporaryDirectory() as tmp:
            mod.apply(pathlib.Path(tmp), config, files, POLICY)
            self.assertEqual((pathlib.Path(tmp) / "public/example.txt").read_bytes(), b"public fixture\n")

    def test_tampered_provenance_cannot_remove_an_allowed_file(self):
        config_raw, layer = fixture("public/new.txt")
        config, files = mod.verify(config_raw, layer, POLICY)
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp); victim = root / "public/victim.txt"
            victim.parent.mkdir(parents=True); victim.write_bytes(b"private work\n")
            (root / ".verity-snapshot.json").write_bytes(mod.canonical({
                "schema": mod.SCHEMA, "source_sha": "0" * 40,
                "files": [{"path": "public/victim.txt", "sha256": hashlib.sha256(b"private work\n").hexdigest()}],
            }))
            mod.apply(root, config, files, POLICY)
            self.assertEqual(victim.read_bytes(), b"private work\n")

    def test_removes_only_unchanged_file_recorded_with_its_digest(self):
        config_raw, layer = fixture("public/old.txt", b"owned\n")
        config, files = mod.verify(config_raw, layer, POLICY)
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "tree"; root.mkdir()
            authority = pathlib.Path(tmp) / "state/provenance.json"
            mod.apply(root, config, files, POLICY, authority)
            new_raw, new_layer = fixture("public/new.txt")
            new_config, new_files = mod.verify(new_raw, new_layer, POLICY)
            mod.apply(root, new_config, new_files, POLICY, authority)
            self.assertFalse((root / "public/old.txt").exists())

    def test_backup_failure_preserves_existing_provenance_and_content(self):
        config_raw, layer = fixture(data=b"replacement\n")
        config, files = mod.verify(config_raw, layer, POLICY)
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            target = root / "public/example.txt"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"old content\n")
            provenance = root / ".verity-snapshot.json"
            old_provenance = mod.canonical({"schema": mod.SCHEMA, "source_sha": "0" * 40, "files": [{
                "path": "public/example.txt", "sha256": hashlib.sha256(b"old content\n").hexdigest()
            }]})
            provenance.write_bytes(old_provenance)
            real_replace = mod.os.replace

            def fail_first_backup(source, destination):
                if pathlib.Path(source) == target:
                    raise OSError("injected backup failure")
                return real_replace(source, destination)

            with mock.patch.object(mod.os, "replace", side_effect=fail_first_backup):
                with self.assertRaisesRegex(OSError, "injected backup failure"):
                    mod.apply(root, config, files, POLICY)
            self.assertEqual(target.read_bytes(), b"old content\n")
            self.assertEqual(provenance.read_bytes(), old_provenance)

if __name__ == "__main__": unittest.main()
