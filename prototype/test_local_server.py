import http.client
import json
import os
from pathlib import Path
import tempfile
import subprocess
import threading
import unittest
from http.server import HTTPServer

from local_server import Catalog, Handler, bundle, frontmatter, inspect_project, list_folders


class ProjectMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / "project with spaces"
        self.repo.mkdir()
        self.git("init", "-b", "main")
        self.git("-c", "user.name=Preview Test", "-c", "user.email=preview@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "Test fixture")
        self.git("branch", "feature/example")

    def git(self, *args):
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        return subprocess.run(["git", "-C", str(self.repo), *args], capture_output=True, text=True, check=True, env=env).stdout.strip()

    def test_folder_browser_lists_only_visible_directories(self):
        (self.root / ".hidden").mkdir()
        (self.root / "note.txt").write_text("not exposed")
        (self.root / "alias").symlink_to(self.repo, target_is_directory=True)
        listing = list_folders(str(self.root))
        self.assertEqual([folder["name"] for folder in listing["folders"]], [self.repo.name])
        with self.assertRaises(ValueError):
            list_folders(str(self.root / "note.txt"))
        with self.assertRaises(ValueError):
            list_folders("relative/path")

    def test_project_inspection_and_worktree_settings_do_not_mutate_git(self):
        before = self.git("status", "--porcelain"), self.git("worktree", "list", "--porcelain"), self.git("for-each-ref", "--format=%(refname)")
        project = inspect_project(str(self.repo), {"mode": "worktree", "baseRef": "refs/heads/main", "branchName": "agent/new-task"})
        self.assertEqual(project["currentBranch"], "main")
        self.assertIn("feature/example", [branch["name"] for branch in project["branches"]])
        after = self.git("status", "--porcelain"), self.git("worktree", "list", "--porcelain"), self.git("for-each-ref", "--format=%(refname)")
        self.assertEqual(before, after)

    def test_worktree_rejects_missing_refs_and_invalid_or_existing_branch_names(self):
        for execution in ({"mode": "worktree", "baseRef": "refs/heads/missing"}, {"mode": "worktree", "baseRef": "HEAD", "branchName": "main"}, {"mode": "worktree", "baseRef": "HEAD", "branchName": "bad name"}, {"mode": "worktree", "baseRef": "HEAD", "branchName": "-invalid"}, {"mode": "invalid"}):
            with self.assertRaises(ValueError):
                inspect_project(str(self.repo), execution)

    def test_non_git_and_unborn_projects_allow_local_mode_only(self):
        plain = self.root / "plain"
        plain.mkdir()
        self.assertFalse(inspect_project(str(plain), {"mode": "local"})["isGit"])
        with self.assertRaisesRegex(ValueError, "at least one commit"):
            inspect_project(str(plain), {"mode": "worktree", "baseRef": "HEAD"})
        empty = self.root / "unborn"
        empty.mkdir()
        subprocess.run(["git", "init", "-b", "main", str(empty)], check=True, capture_output=True)
        self.assertIsNone(inspect_project(str(empty))["head"])
        with self.assertRaises(ValueError):
            inspect_project(str(empty), {"mode": "worktree", "baseRef": "HEAD"})

    def test_detached_head_and_removed_folder(self):
        self.git("checkout", "--detach")
        project = inspect_project(str(self.repo), {"mode": "worktree", "baseRef": "HEAD"})
        self.assertIsNone(project["currentBranch"])
        self.assertEqual(project["defaultRef"], "HEAD")
        with self.assertRaises(OSError):
            inspect_project(str(self.root / "missing"))


class SkillCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.skills = self.root / "skills"
        self.skill = self.skills / "coding"
        self.skill.mkdir(parents=True)
        (self.skill / "SKILL.md").write_text("---\nname: Code style\ndescription: >\n  Keep changes small.\n  Verify the result.\n---\n# Instructions\nRead the code first.\n")
        self.catalog = Catalog(self.root / "snapshots")

    def scan(self):
        return self.catalog.scan([str(self.skills)])

    def test_frontmatter_strings_and_folded_description(self):
        name, description = frontmatter((self.skill / "SKILL.md").read_text(), "fallback")
        self.assertEqual(name, "Code style")
        self.assertEqual(description, "Keep changes small. Verify the result.")

    def test_symlink_deduplication_and_same_name_identity(self):
        alias = self.root / "alias"
        alias.symlink_to(self.skills, target_is_directory=True)
        other = self.root / "another"
        other.mkdir()
        (other / "SKILL.md").write_text((self.skill / "SKILL.md").read_text())
        result = self.catalog.scan([str(self.skills), str(alias), str(other)])
        self.assertEqual(len(result["skills"]), 2)
        self.assertEqual(sorted(len(item["sources"]) for item in result["skills"]), [1, 2])

    def test_excludes_environment_and_escaping_links(self):
        (self.skill / "env").mkdir()
        (self.skill / "env" / "dev.json").write_text('"private"')
        (self.skill / ".env").write_text("private")
        scripts = self.skill / "scripts"
        scripts.mkdir()
        (scripts / "check.py").write_text("raise RuntimeError('must never run')")
        outside = self.root / "outside.md"
        outside.write_text("private")
        (scripts / "outside.md").symlink_to(outside)
        data = bundle(self.skill)
        self.assertEqual([item["path"] for item in data["files"]], ["SKILL.md", "scripts/check.py"])
        self.assertEqual(data["omitted"], 1)

    def test_escaping_main_file_is_rejected(self):
        outside = self.root / "outside.md"
        outside.write_text("private")
        (self.skill / "SKILL.md").unlink()
        (self.skill / "SKILL.md").symlink_to(outside)
        self.assertEqual(len(self.scan()["errors"]), 1)

    def test_reference_changes_version_and_saved_snapshot_is_immutable(self):
        refs = self.skill / "references"
        refs.mkdir()
        guide = refs / "guide.md"
        guide.write_text("old evidence")
        entry = self.scan()["skills"][0]
        self.catalog.snapshot([entry])
        guide.write_text("new evidence")
        with self.assertRaisesRegex(ValueError, "changed"):
            self.catalog.snapshot([entry])
        saved = self.catalog.read_snapshot(entry["version"])
        self.assertEqual(saved["files"][1]["content"], "old evidence")
        self.assertNotIn("path", saved)
        self.assertNotEqual(self.scan()["skills"][0]["version"], entry["version"])

    def test_removed_source_and_invalid_snapshot_fail(self):
        entry = self.scan()["skills"][0]
        self.catalog.scan([])
        with self.assertRaises(ValueError):
            self.catalog.detail(entry["id"])
        with self.assertRaises(ValueError):
            self.catalog.read_snapshot("../../outside")

    def test_missing_folder_and_large_files_are_reported(self):
        result = self.catalog.scan([str(self.root / "missing")])
        self.assertEqual(result["sources"][0]["status"], "unavailable")
        (self.skill / "SKILL.md").write_text("x" * (256 * 1024 + 1))
        self.assertEqual(len(self.scan()["errors"]), 1)


class PreviewServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.server.catalog = Catalog(Path(self.temp.name) / "snapshots")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path, method="GET", body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        self.addCleanup(connection.close)
        connection.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers or {})
        response = connection.getresponse()
        return response.status, response.read()

    def test_static_allowlist_and_status(self):
        self.assertEqual(self.request("/")[0], 200)
        self.assertEqual(self.request("/api/status")[0], 200)
        for path in ("/local_server.py", "/../AGENTS.md", "/.local/skill-snapshots/test.json"):
            self.assertEqual(self.request(path)[0], 404)

    def test_foreign_origins_hosts_and_form_posts_are_rejected(self):
        for headers in ({"Origin": "https://example.com"}, {"Host": "evil.test"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.request("/api/status", headers=headers)[0], 403)
        self.assertEqual(self.request("/api/catalog", "POST", {"roots": []})[0], 403)

    def test_same_origin_json_catalog_and_bad_payload(self):
        headers = {"Content-Type": "application/json"}
        status, body = self.request("/api/catalog", "POST", {"roots": []}, headers)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["skills"], [])
        self.assertEqual(self.request("/api/catalog", "POST", {"roots": "invalid"}, headers)[0], 400)

    def test_project_endpoints_require_same_origin_json(self):
        for endpoint in ("/api/folders", "/api/project"):
            body = {"path": self.temp.name}
            self.assertEqual(self.request(endpoint, "POST", body, {"Content-Type": "application/json", "Origin": "https://example.com"})[0], 403)
            status, response = self.request(endpoint, "POST", body, {"Content-Type": "application/json"})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(response)["path"], str(Path(self.temp.name).resolve()))


if __name__ == "__main__":
    unittest.main()
