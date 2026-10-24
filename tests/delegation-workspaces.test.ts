import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { prepareDelegation, collectDelegation } from "../packages/engine/delegation-workspaces.ts";
async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "studio-child-worktree-"))), cwd = join(root, "project");
  execFileSync("git", ["init", "-q", cwd]);
  await writeFile(join(cwd, "README.md"), "original\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
  git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Initial");
  t.after(() => rm(root, { recursive: true, force: true })); return { root, cwd, git };
}

test("Snapshots include staged and unstaged files without changing the parent's index", async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, "README.md"), "staged\n"); f.git("add", ".");
  await writeFile(join(f.cwd, "README.md"), "unstaged\n"); await writeFile(join(f.cwd, "new.txt"), "untracked");
  const staged = f.git("diff", "--cached"), head = f.git("rev-parse", "HEAD");
  const child = await prepareDelegation(f.cwd, "child", f.root, true);
  assert.equal(await readFile(join(child.cwd, "README.md"), "utf8"), "unstaged\n");
  assert.equal(await readFile(join(child.cwd, "new.txt"), "utf8"), "untracked");
  assert.equal(f.git("diff", "--cached"), staged); assert.equal(f.git("rev-parse", "HEAD"), head);
  await writeFile(join(child.cwd, "README.md"), "child edit\n"); await writeFile(join(child.cwd, "added.txt"), "child added");
  await collectDelegation(f.cwd, child.cwd, child.commit!, f.root, true);
  assert.equal(await readFile(join(f.cwd, "README.md"), "utf8"), "child edit\n"); assert.equal(await readFile(join(f.cwd, "added.txt"), "utf8"), "child added");
  assert.equal(f.git("diff", "--cached"), staged);
});

test("Integration conflicts preserve parent changes and apply none of the child files", async t => {
  const f = await fixture(t), child = await prepareDelegation(f.cwd, "child", f.root, true);
  await writeFile(join(child.cwd, "README.md"), "child edit\n"); await writeFile(join(child.cwd, "extra.txt"), "child added");
  await writeFile(join(f.cwd, "README.md"), "parent edit\n");
  await assert.rejects(collectDelegation(f.cwd, child.cwd, child.commit!, f.root, true), /Integration conflict/);
  assert.equal(await readFile(join(f.cwd, "README.md"), "utf8"), "parent edit\n"); await assert.rejects(readFile(join(f.cwd, "extra.txt")), { code: "ENOENT" });
});
