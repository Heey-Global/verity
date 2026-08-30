#!/usr/bin/env python3
"""Verify and apply a sanitized Verity snapshot from a digest-addressed OCI artifact."""

import argparse, base64, gzip, hashlib, io, json, os, pathlib, re, sys, tarfile, tempfile
import urllib.error, urllib.parse, urllib.request

OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
CONFIG_MEDIA = "application/vnd.heey.verity.snapshot.config.v1+json"
LAYER_MEDIA = "application/vnd.heey.verity.snapshot.layer.v1.tar+gzip"
SCHEMA = "https://github.com/Heey-Global/verity/snapshot/v1"
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")

def canonical(value): return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()
def sha(data): return "sha256:" + hashlib.sha256(data).hexdigest()

def safe_path(raw):
    if not isinstance(raw, str) or not raw or "\\" in raw or raw.startswith("/"):
        raise ValueError(f"unsafe path: {raw!r}")
    p = pathlib.PurePosixPath(raw)
    if (
        str(p) != raw
        or any(x in ("", ".", "..") for x in p.parts)
        or p.parts[0] in (".git", ".verity-worktree.json")
    ):
        raise ValueError(f"unsafe path: {raw!r}")
    return p

def descriptor(desc, media):
    if desc.get("mediaType") != media or not DIGEST.fullmatch(desc.get("digest", "")) or not isinstance(desc.get("size"), int):
        raise ValueError(f"invalid {media} descriptor")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl): return None

def bounded_read(response, limit):
    length = response.headers.get("Content-Length")
    if length is not None and int(length) > limit: raise ValueError("registry response exceeds size limit")
    data = response.read(limit + 1)
    if len(data) > limit: raise ValueError("registry response exceeds size limit")
    return data

def open_redirect_chain(opener, req, limit, max_redirects=5):
    """Follow redirects manually so every hop is validated before any request."""
    current = req
    for _ in range(max_redirects + 1):
        try:
            return bounded_read(opener.open(current), limit)
        except urllib.error.HTTPError as error:
            if error.code not in (301, 302, 303, 307, 308): raise
            target = urllib.parse.urljoin(current.full_url, error.headers.get("Location", ""))
            error.close()
            location = urllib.parse.urlparse(target)
            if location.scheme != "https" or not location.hostname:
                raise ValueError("unsafe registry redirect")
            # Registry bearer/basic credentials never cross an origin boundary.
            headers = dict(current.header_items()) if urllib.parse.urlparse(current.full_url).netloc == location.netloc else {}
            current = urllib.request.Request(target, headers=headers)
    raise ValueError("too many registry redirects")

def request(url, token, username, accept=None, limit=1048576):
    headers = {"Authorization": "Basic " + base64.b64encode(f"{username}:{token}".encode()).decode()}
    if accept: headers["Accept"] = accept
    opener = urllib.request.build_opener(NoRedirect)
    try: response = opener.open(urllib.request.Request(url, headers=headers))
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            e.close()
            return open_redirect_chain(opener, urllib.request.Request(url, headers=headers), limit)
        if e.code != 401: raise
        challenge = e.headers.get("WWW-Authenticate", "")
        fields = dict(re.findall(r'(realm|service|scope)="([^"]+)"', challenge))
        if "realm" not in fields: raise
        realm = urllib.parse.urlparse(fields["realm"])
        if realm.scheme != "https" or realm.hostname != "ghcr.io": raise ValueError("untrusted registry authentication realm")
        query = urllib.parse.urlencode({k: v for k, v in fields.items() if k != "realm"})
        auth = urllib.request.Request(fields["realm"] + "?" + query, headers=headers)
        auth_payload = json.loads(open_redirect_chain(opener, auth, 1048576))
        bearer = auth_payload.get("token") if isinstance(auth_payload, dict) else None
        if not isinstance(bearer, str) or not bearer or len(bearer) > 16384:
            raise ValueError("invalid registry bearer token")
        headers["Authorization"] = "Bearer " + bearer
        try: response = opener.open(urllib.request.Request(url, headers=headers))
        except urllib.error.HTTPError as redirected:
            if redirected.code not in (301, 302, 303, 307, 308): raise
            redirected.close()
            return open_redirect_chain(opener, urllib.request.Request(url, headers=headers), limit)
    return bounded_read(response, limit)

def pull(package, digest, token, username, policy):
    if not re.fullmatch(r"[a-z0-9]+(?:[._/-][a-z0-9]+)*", package) or not DIGEST.fullmatch(digest):
        raise ValueError("package must be lowercase and reference must be an immutable sha256 digest")
    if package not in policy["allowed_packages"]:
        raise ValueError("package is not allowed by repository policy")
    base = f"https://ghcr.io/v2/{package}"
    raw = request(f"{base}/manifests/{digest}", token, username, OCI_MANIFEST)
    if sha(raw) != digest: raise ValueError("OCI manifest digest mismatch")
    manifest = json.loads(raw)
    if manifest.get("schemaVersion") != 2 or manifest.get("mediaType") != OCI_MANIFEST or len(manifest.get("layers", [])) != 1:
        raise ValueError("unexpected OCI manifest schema or layer count")
    descriptor(manifest["config"], CONFIG_MEDIA); descriptor(manifest["layers"][0], LAYER_MEDIA)
    if manifest["config"]["size"] > policy["max_config_bytes"] or manifest["layers"][0]["size"] > policy["max_layer_bytes"]:
        raise ValueError("OCI descriptor exceeds size limit")
    blobs = []
    for desc in (manifest["config"], manifest["layers"][0]):
        data = request(f"{base}/blobs/{desc['digest']}", token, username, limit=desc["size"])
        if len(data) != desc["size"] or sha(data) != desc["digest"]: raise ValueError("OCI blob digest or size mismatch")
        blobs.append(data)
    return blobs

def load_policy(path):
    p = json.loads(path.read_text())
    if p.get("schema") != "https://github.com/Heey-Global/verity/snapshot-policy/v1": raise ValueError("unsupported policy")
    return p

def allowed(path, policy):
    s = str(path)
    protected = policy["protected_prefixes"]
    if any(s == x or s.startswith(x.rstrip("/") + "/") for x in protected): return False
    return s in policy["allowed_paths"] or any(s.startswith(x.rstrip("/") + "/") for x in policy["allowed_prefixes"])

def verify(config_raw, layer_raw, policy):
    config = json.loads(config_raw)
    if canonical(config) != config_raw: raise ValueError("snapshot config is not canonical JSON")
    if config.get("schema") != SCHEMA or not re.fullmatch(r"[0-9a-f]{40}", config.get("source_sha", "")):
        raise ValueError("unsupported schema or invalid source SHA")
    if config.get("license") != "Apache-2.0": raise ValueError("snapshot license must be Apache-2.0")
    entries = config.get("files")
    if not isinstance(entries, list): raise ValueError("files must be an array")
    if len(entries) > policy["max_files"]: raise ValueError("snapshot exceeds file-count limit")
    expected = {}
    total = 0
    for entry in entries:
        p = safe_path(entry.get("path"))
        if p in expected or not allowed(p, policy): raise ValueError(f"duplicate or disallowed path: {p}")
        if not re.fullmatch(r"[0-9a-f]{64}", entry.get("sha256", "")) or entry.get("mode") not in ("0644", "0755"):
            raise ValueError(f"invalid file metadata: {p}")
        if not isinstance(entry.get("size"), int) or entry["size"] < 0 or entry["size"] > policy["max_file_bytes"]:
            raise ValueError(f"invalid file size: {p}")
        total += entry["size"]
        expected[p] = entry
    if total > policy["max_total_bytes"]: raise ValueError("snapshot exceeds total-size limit")
    found = {}
    expanded_limit = policy["max_total_bytes"] + policy["max_files"] * 4096 + 1048576
    with tempfile.SpooledTemporaryFile(max_size=10485760) as expanded:
        with gzip.GzipFile(fileobj=io.BytesIO(layer_raw)) as source:
            total_expanded = 0
            while chunk := source.read(1048576):
                total_expanded += len(chunk)
                if total_expanded > expanded_limit: raise ValueError("expanded archive exceeds size limit")
                expanded.write(chunk)
        expanded.seek(0)
        with tarfile.open(fileobj=expanded, mode="r:") as tf:
            for member in tf:
                p = safe_path(member.name)
                if not member.isfile() or member.issym() or member.islnk(): raise ValueError(f"non-regular archive member: {p}")
                if p not in expected or p in found: raise ValueError(f"unexpected archive member: {p}")
                e = expected[p]
                if member.size != e["size"]: raise ValueError(f"archive size mismatch: {p}")
                data = tf.extractfile(member).read()
                if len(data) != e["size"] or hashlib.sha256(data).hexdigest() != e["sha256"]: raise ValueError(f"file mismatch: {p}")
                found[p] = data
    if set(found) != set(expected): raise ValueError("archive file set does not match manifest")
    notice_path = pathlib.PurePosixPath("NOTICE"); notice = notice_path in found
    notice_hash = hashlib.sha256(found[notice_path]).hexdigest() if notice else None
    if bool(config.get("notice_required")) != notice or config.get("notice_sha256") != notice_hash:
        raise ValueError("NOTICE requirement or digest mismatch")
    return config, found

def destination(root, path):
    target = root.joinpath(*path.parts)
    current = root
    for index, part in enumerate(path.parts):
        current = current / part
        if current.is_symlink(): raise ValueError(f"symlink destination rejected: {path}")
        if current.exists() and index < len(path.parts) - 1 and not current.is_dir():
            raise ValueError(f"non-directory destination component: {path}")
    if target.exists() and not target.is_file(): raise ValueError(f"non-file destination rejected: {path}")
    if root not in target.parents: raise ValueError(f"destination escapes root: {path}")
    return target

def apply(root, config, files, policy, trusted_provenance=None):
    root = root.resolve(strict=True)
    provenance = root / ".verity-snapshot.json"
    if provenance.is_symlink() or (provenance.exists() and not provenance.is_file()):
        raise ValueError("invalid provenance file")
    authority = pathlib.Path(trusted_provenance).resolve() if trusted_provenance is not None else None
    if authority is not None:
        if authority == root or root in authority.parents:
            raise ValueError("trusted provenance must live outside the imported tree")
        if authority.is_symlink() or (authority.exists() and not authority.is_file()):
            raise ValueError("invalid trusted provenance file")
    # The repository copy is informational and editable by design. Only a state
    # file supplied from an external, access-controlled location may authorize
    # deletion of files omitted by a later snapshot.
    previous = json.loads(authority.read_text()) if authority is not None and authority.exists() else {}
    previous_files = previous.get("files", [])
    if not isinstance(previous_files, list): raise ValueError("invalid provenance file list")
    modes = {safe_path(x["path"]): int(x["mode"], 8) for x in config["files"]}
    removals = []
    for entry in previous_files:
        # Legacy path-only provenance cannot prove that the current file is still
        # importer-owned. Never let an editable provenance file turn an arbitrary
        # allowed path into a deletion target.
        if not isinstance(entry, dict): continue
        p = safe_path(entry.get("path")); digest = entry.get("sha256")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("invalid provenance file digest")
        if not allowed(p, policy) or p in files: continue
        target = destination(root, p)
        if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == digest:
            removals.append(p)
    with tempfile.TemporaryDirectory(prefix=".verity-import-", dir=root) as temp:
        work = pathlib.Path(temp); staged = work / "new"; backup = work / "old"
        for p, data in files.items():
            target = staged.joinpath(*p.parts); target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data); target.chmod(modes[p])
        prov_data = canonical({
            "schema": SCHEMA,
            "source_sha": config["source_sha"],
            "files": [
                {"path": str(p), "sha256": hashlib.sha256(files[p]).hexdigest()}
                for p in sorted(files, key=str)
            ],
        })
        (work / "provenance").write_bytes(prov_data)
        targets = list(files) + removals
        placed, backed_up = [], []
        provenance_backed_up = False
        try:
            for p in targets:
                target = destination(root, p)
                if target.exists():
                    old = backup.joinpath(*p.parts); old.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(target, old); backed_up.append((target, old))
            if provenance.exists():
                os.replace(provenance, work / "old-provenance")
                provenance_backed_up = True
            for p in files:
                target = destination(root, p); target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(staged.joinpath(*p.parts), target); placed.append(target)
            os.replace(work / "provenance", provenance)
            if authority is not None:
                authority.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                trusted_next = authority.with_name(f".{authority.name}.{os.getpid()}.next")
                trusted_next.write_bytes(prov_data)
                trusted_next.chmod(0o600)
                os.replace(trusted_next, authority)
        except Exception:
            # A failure can occur while backing up a content file, before the
            # provenance was moved. Never unlink that still-current provenance.
            if provenance_backed_up:
                if provenance.exists(): provenance.unlink()
                os.replace(work / "old-provenance", provenance)
            for target in reversed(placed):
                if target.exists(): target.unlink()
            for target, old in reversed(backed_up):
                target.parent.mkdir(parents=True, exist_ok=True); os.replace(old, target)
            raise

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("mode", choices=("verify", "apply")); ap.add_argument("--package", required=True); ap.add_argument("--digest", required=True); ap.add_argument("--policy", default="snapshot-policy.json"); ap.add_argument("--root", default="."); ap.add_argument("--provenance-state")
    args = ap.parse_args(); token = os.environ.get("GH_TOKEN"); username = os.environ.get("GH_USER")
    if not token or not username: ap.error("GH_TOKEN and GH_USER are required")
    policy = load_policy(pathlib.Path(args.policy))
    config_raw, layer_raw = pull(args.package, args.digest, token, username, policy)
    config, files = verify(config_raw, layer_raw, policy)
    print(f"verified {len(files)} files from source {config['source_sha']}")
    if args.mode == "apply": apply(pathlib.Path(args.root).resolve(), config, files, policy, args.provenance_state)

if __name__ == "__main__":
    try: main()
    except (ValueError, OSError, json.JSONDecodeError, urllib.error.URLError) as e: sys.exit(f"snapshot import rejected: {e}")
