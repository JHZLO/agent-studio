"""Loopback preview server for local skills and project metadata. No AI execution."""

import argparse
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit

SOURCE = Path(__file__).resolve().parent
DEFAULT_ROOTS = ["~/.agents/skills", "~/.codex/skills", "~/.claude/skills"]
STATIC_FILES = {"index.html", "styles.css", "app.js", "demo-engine.js", "skills.js"}
TEXT_TYPES = {".md", ".txt", ".json", ".yaml", ".yml", ".py", ".js", ".mjs", ".ts", ".sh", ".http", ".csv", ".html", ".css", ".svg"}
ASSET_DIRS = {"references", "scripts", "assets", "agents"}
MAX_FILE = 256 * 1024
MAX_BUNDLE = 1024 * 1024


def local_folder(raw):
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 4096:
        raise ValueError("Choose a local folder.")
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ValueError("Use an absolute folder path.")
    path = path.resolve(strict=True)
    if not path.is_dir():
        raise ValueError("Choose a folder, not a file.")
    return path


def list_folders(raw=None):
    path = local_folder(str(Path.home()) if raw is None else raw)
    folders = []
    with os.scandir(path) as entries:
        for entry in entries:
            if not entry.name.startswith(".") and entry.is_dir(follow_symlinks=False):
                folders.append({"name": entry.name, "path": str(path / entry.name)})
            if len(folders) > 2000:
                raise ValueError("This folder has too many entries. Enter a more specific path.")
    folders.sort(key=lambda item: item["name"].casefold())
    return {"path": str(path), "name": path.name or str(path), "parent": str(path.parent) if path != path.parent else None, "folders": folders}


def git_read(path, *args):
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0")
    try:
        result = subprocess.run(["git", "--no-optional-locks", "-C", str(path), "-c", "core.fsmonitor=false", *args], capture_output=True, text=True, timeout=5, env=env)
    except subprocess.TimeoutExpired as error:
        raise ValueError("Git inspection timed out. Try a different folder.") from error
    except FileNotFoundError as error:
        raise ValueError("Install Git to inspect project branches.") from error
    return result.stdout.strip() if result.returncode == 0 else None


def inspect_project(raw, execution=None):
    path = local_folder(raw)
    git_root = git_read(path, "rev-parse", "--show-toplevel")
    project = {"path": str(path), "folderName": path.name, "isGit": bool(git_root), "gitRoot": git_root, "branches": [], "currentBranch": None, "defaultRef": None, "head": None}
    if git_root:
        project["head"] = git_read(path, "rev-parse", "--verify", "HEAD")
        project["currentBranch"] = git_read(path, "symbolic-ref", "--quiet", "--short", "HEAD")
        refs = git_read(path, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes")
        if refs is None:
            raise ValueError("Could not read Git branches.")
        project["branches"] = [{"ref": ref, "name": re.sub(r"^refs/(?:heads|remotes)/", "", ref)} for ref in refs.splitlines() if not ref.endswith("/HEAD")]
        if project["head"]:
            project["branches"].append({"ref": "HEAD", "name": "Current commit"})
            branch_ref = "refs/heads/" + (project["currentBranch"] or "")
            project["defaultRef"] = branch_ref if any(item["ref"] == branch_ref for item in project["branches"]) else "HEAD"
    if execution is not None:
        if not isinstance(execution, dict) or execution.get("mode") not in {"local", "worktree"}:
            raise ValueError("Choose Local or New worktree.")
        if execution["mode"] == "worktree":
            if not project["head"]:
                raise ValueError("A new worktree requires a Git repository with at least one commit.")
            if execution.get("baseRef") not in {item["ref"] for item in project["branches"]}:
                raise ValueError("The base branch is no longer available. Choose another branch.")
            name = execution.get("branchName", "")
            if not isinstance(name, str) or len(name) > 200:
                raise ValueError("Use a branch name of 200 characters or fewer.")
            if name and (name.startswith("-") or "@{" in name or git_read(path, "check-ref-format", "--branch", name) is None):
                raise ValueError("Enter a valid new branch name.")
            if name and any(item["ref"] == "refs/heads/" + name for item in project["branches"]):
                raise ValueError("This branch already exists. Enter a new branch name.")
    return project


def digest(value):
    return hashlib.sha256(value).hexdigest()


def frontmatter(text, fallback):
    """Read common string fields only; never construct YAML objects or tags."""
    fields = {}
    if text.startswith("---\n"):
        header = text[4:].split("\n---", 1)[0]
        for key in ("name", "description"):
            match = re.search(rf"^{key}:\s*([^\n]*)(?:\n((?:[ \t]+[^\n]*\n?)*))?", header, re.M)
            if match:
                value = match[1].strip()
                fields[key] = (" ".join((match[2] or "").split()) if value in (">", "|", ">-", "|-") else value.strip("\"'"))[:2000]
    return fields.get("name") or fallback, fields.get("description") or "No description in SKILL.md."


def requirements(text):
    patterns = {
        "Shell": r"\b(?:shell|bash|curl|python|npm|k6|exec_command)\b",
        "Browser": r"\b(?:playwright|browser|computer use|compute use|chrome)\b",
        "Connector": r"\b(?:mcp|notion|slack|google sheets|google drive)\b",
        "Credentials": r"\b(?:api[_ -]?key|oauth|token|credentials|environment variables)\b",
    }
    return [label for label, pattern in patterns.items() if re.search(pattern, text, re.I)]


def bundle(directory):
    directory = directory.resolve(strict=True)
    main = directory / "SKILL.md"
    candidates = [main]
    for name in sorted(ASSET_DIRS):
        folder = directory / name
        if not folder.is_dir() or folder.is_symlink():
            continue
        for current, dirs, files in os.walk(folder, followlinks=False):
            dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in {"env", "node_modules", "__pycache__"} and not (Path(current) / d).is_symlink())
            for filename in sorted(files):
                path = Path(current) / filename
                if not filename.startswith(".") and path.suffix.lower() in TEXT_TYPES and not re.search(r"(?:secret|credential|token|private.key|\.env)", filename, re.I):
                    candidates.append(path)
            if len(candidates) > 256:
                raise ValueError("Too many supporting files. Use a smaller skill folder.")
    files, total, omitted = [], 0, 0
    for path in sorted(candidates):
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(directory) or not resolved.is_file():
            if path == main:
                raise ValueError("SKILL.md must resolve inside its skill folder.")
            omitted += 1
            continue
        if resolved.stat().st_size > MAX_FILE:
            raise ValueError("A skill file exceeds the 256 KB limit.")
        raw = resolved.read_bytes()
        total += len(raw)
        if total > MAX_BUNDLE:
            raise ValueError("Skill content exceeds the 1 MB limit.")
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            omitted += 1
            continue
        files.append({"path": path.relative_to(directory).as_posix(), "content": content, "hash": digest(raw)})
    if not any(item["path"] == "SKILL.md" for item in files):
        raise ValueError("SKILL.md must be UTF-8 text.")
    version = digest(json.dumps(files, sort_keys=True, ensure_ascii=False).encode())
    return {"version": version, "files": files, "omitted": omitted}


class Catalog:
    def __init__(self, snapshot_dir):
        self.snapshot_dir = Path(snapshot_dir)
        self.paths = {}
        self.entries = {}

    def scan(self, roots):
        if not isinstance(roots, list) or len(roots) > 12 or any(not isinstance(root, str) or len(root) > 1000 for root in roots):
            raise ValueError("Provide up to 12 skill folder paths.")
        entries, paths, sources, errors = {}, {}, [], []
        for raw in dict.fromkeys(roots):
            root = Path(raw).expanduser()
            label = raw.replace(str(Path.home()), "~")
            source = {"path": raw, "label": label, "count": 0, "status": "available"}
            sources.append(source)
            try:
                root = root.resolve(strict=True)
                candidates = [root] if (root / "SKILL.md").is_file() else sorted(root.iterdir())
                if len(candidates) > 1000:
                    raise ValueError("Choose a dedicated skills folder with fewer than 1,000 entries.")
                for folder in candidates:
                    if folder.name.startswith(".") or not folder.is_dir() or not (folder / "SKILL.md").is_file():
                        continue
                    canonical = folder.resolve()
                    skill_id = digest(str(canonical).encode())
                    source["count"] += 1
                    if skill_id in entries:
                        entries[skill_id]["sources"].append(label)
                        continue
                    try:
                        data = bundle(canonical)
                        body = next(item["content"] for item in data["files"] if item["path"] == "SKILL.md")
                        name, description = frontmatter(body, folder.name)
                        entries[skill_id] = {"id": skill_id, "name": name, "description": description, "version": data["version"], "sources": [label], "path": str(folder), "requirements": requirements(body), "fileCount": len(data["files"]), "omitted": data["omitted"]}
                        paths[skill_id] = canonical
                    except (OSError, ValueError) as error:
                        errors.append({"source": label, "name": folder.name, "message": str(error)})
            except (OSError, ValueError) as error:
                source["status"] = "unavailable"
                source["message"] = str(error)
        self.entries, self.paths = entries, paths
        return {"skills": sorted(entries.values(), key=lambda entry: (entry["name"].lower(), entry["id"])), "sources": sources, "errors": errors}

    def detail(self, skill_id):
        if skill_id not in self.paths:
            raise ValueError("Skill is no longer in the catalog. Refresh your sources.")
        data = bundle(self.paths[skill_id])
        return {**self.entries[skill_id], **data}

    def snapshot(self, bindings):
        if not isinstance(bindings, list) or len(bindings) > 100:
            raise ValueError("Select up to 100 skills per run.")
        snapshots = {}
        for binding in bindings:
            if not isinstance(binding, dict):
                raise ValueError("Invalid skill binding.")
            entry = self.detail(binding.get("id"))
            if entry["version"] != binding.get("version"):
                raise ValueError(f"{entry['name']} changed. Review and update the binding before starting.")
            snapshots[entry["id"]] = entry
        if snapshots:
            self.snapshot_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        for entry in snapshots.values():
            target = self.snapshot_dir / (entry["version"] + ".json")
            # Store content only. Source paths stay in the live catalog.
            saved = {key: entry[key] for key in ("version", "files", "omitted")}
            if not target.exists():
                with target.open("x", encoding="utf-8") as file:
                    os.chmod(target, 0o600)
                    json.dump(saved, file, ensure_ascii=False)
        return {"snapshots": [{"id": item["id"], "name": item["name"], "version": item["version"], "fileCount": item["fileCount"]} for item in snapshots.values()]}

    def read_snapshot(self, version):
        if not isinstance(version, str) or not re.fullmatch(r"[0-9a-f]{64}", version):
            raise ValueError("Invalid snapshot version.")
        return json.loads((self.snapshot_dir / (version + ".json")).read_text())


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self, status, data, mime="application/json"):
        payload = json.dumps(data, ensure_ascii=False).encode() if mime == "application/json" else data
        self.send_response(status)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(payload)

    def allowed(self):
        host = f"127.0.0.1:{self.server.server_port}"
        return self.headers.get("Host") == host and self.headers.get("Origin", f"http://{host}") == f"http://{host}" and self.headers.get("Sec-Fetch-Site", "same-origin") in {"same-origin", "none"}

    def do_GET(self):
        if not self.allowed():
            return self.respond(403, {"error": "Open this preview on its loopback address."})
        path = urlsplit(self.path).path
        if path == "/api/status":
            return self.respond(200, {"service": "agent-studio-skills", "roots": DEFAULT_ROOTS})
        name = "index.html" if path == "/" else path.lstrip("/")
        if name not in STATIC_FILES:
            return self.respond(404, {"error": "Not found."})
        self.respond(200, (SOURCE / name).read_bytes(), mimetypes.guess_type(name)[0] or "text/plain")

    def do_POST(self):
        if not self.allowed() or self.headers.get("Content-Type") != "application/json":
            return self.respond(403, {"error": "Same-origin JSON requests only."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 64000:
                raise ValueError("Invalid request size.")
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError("Expected a JSON object.")
            catalog = self.server.catalog
            if self.path == "/api/catalog":
                result = catalog.scan(data.get("roots", DEFAULT_ROOTS))
            elif self.path == "/api/skill":
                result = catalog.detail(data.get("id"))
            elif self.path == "/api/snapshots":
                result = catalog.snapshot(data.get("bindings"))
            elif self.path == "/api/snapshot":
                result = catalog.read_snapshot(data.get("version"))
            elif self.path == "/api/folders":
                result = list_folders(data.get("path"))
            elif self.path == "/api/project":
                result = inspect_project(data.get("path"), data.get("execution"))
            else:
                return self.respond(404, {"error": "Not found."})
            self.respond(200, result)
        except (OSError, ValueError, TypeError) as error:
            self.respond(400, {"error": str(error)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=4182)
    args = parser.parse_args()
    server = HTTPServer(("127.0.0.1", args.port), Handler)
    server.catalog = Catalog(SOURCE.parent / ".local" / "skill-snapshots")
    print(f"Agent Studio: http://127.0.0.1:{args.port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
