import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile, realpath, readdir, lstat, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { git, contained, secretPath } from "./projects.ts";
import { codeReference } from "./tools.ts";
const exec = promisify(execFile);
const excluded = (path: string) => secretPath(path) || path.split("/").some(part => ["node_modules", "target", "build", "dist", "coverage"].includes(part));

async function gitBytes(cwd: string, args: string[], index?: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = await exec("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    env: { ...env, GIT_TERMINAL_PROMPT: "0", ...(index ? { GIT_INDEX_FILE: index } : {}), GIT_AUTHOR_NAME: "Agent Studio", GIT_AUTHOR_EMAIL: "studio@localhost", GIT_COMMITTER_NAME: "Agent Studio", GIT_COMMITTER_EMAIL: "studio@localhost" },
    encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 120000,
  });
  return result.stdout;
}

export async function snapshotCommit(cwd: string, dataDir: string) {
  const dir = await mkdtemp(join(dataDir, "snapshot-")), index = join(dir, "index");
  try {
    await gitBytes(cwd, ["read-tree", "HEAD"], index);
    await gitBytes(cwd, ["add", "--all", "--", "."], index);
    const files = (await gitBytes(cwd, ["ls-files", "-z"], index)).toString().split("\0").filter(Boolean);
    for (const file of files.filter(excluded)) await gitBytes(cwd, ["update-index", "--force-remove", "--", file], index);
    const tree = (await gitBytes(cwd, ["write-tree"], index)).toString().trim();
    return (await gitBytes(cwd, ["commit-tree", tree, "-p", "HEAD", "-m", "Agent Studio delegation snapshot"], index)).toString().trim();
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function prepareDelegation(cwd: string, id: string, dataDir: string, write: boolean) {
  const reference = await codeReference(cwd), root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const target = join(dataDir, "delegations", id);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (root) {
    if (await realpath(root) !== await realpath(cwd)) throw new Error("Delegation requires selecting the Git repository root as the project folder.");
    if (!await git(cwd, ["rev-parse", "--verify", "HEAD"])) throw new Error("Delegation needs at least one Git commit.");
    const commit = await snapshotCommit(cwd, dataDir);
    if (reference !== await codeReference(cwd)) throw new Error("Project files changed while preparing the child snapshot. Try again after the edit finishes.");
    await git(cwd, ["worktree", "add", "--detach", target, commit], true);
    return { cwd: target, commit, reference };
  }
  if (write) throw new Error("Write delegation requires a Git project with at least one commit. Read-only delegation is available for this folder.");
  let count = 0, bytes = 0;
  const copy = async (path: string) => {
    await mkdir(join(target, path), { recursive: true, mode: 0o700 });
    for (const entry of await readdir(join(cwd, path), { withFileTypes: true })) {
      const relative = join(path, entry.name);
      if (excluded(relative) || entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await copy(relative);
      else if (entry.isFile()) {
        bytes += (await lstat(join(cwd, relative))).size;
        if (++count > 20000 || bytes > 200 * 1024 * 1024) throw new Error("The read snapshot exceeds 20,000 files or 200 MB. Use a smaller project.");
        await copyFile(join(cwd, relative), join(target, relative));
      }
    }
  };
  try {
    await copy("");
    if (reference !== await codeReference(cwd)) throw new Error("Project files changed while preparing the child snapshot.");
    return { cwd: target, reference };
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
}

export async function collectDelegation(parent: string, child: string, base: string, dataDir: string, apply: boolean, signal?: AbortSignal) {
  const before = await codeReference(parent), result = await snapshotCommit(child, dataDir);
  const files = (await gitBytes(child, ["diff", "--name-only", "-z", base, result, "--"])).toString().split("\0").filter(Boolean);
  if (files.length > 1000) throw new Error("The child changed more than 1,000 files. Split the work before integrating it.");
  const patch = await gitBytes(child, ["diff", "--binary", "--no-ext-diff", "--no-textconv", base, result, "--"]);
  if (patch.length > 8 * 1024 * 1024) throw new Error("The child diff exceeds 8 MB. Split the work before integrating it.");
  if (!apply || !files.length) return { files, diff: patch.toString(), reference: before };
  const current = await snapshotCommit(parent, dataDir);
  for (const path of files) {
    if (excluded(path)) throw new Error("The child changed an excluded path.");
    const original = await gitBytes(parent, ["ls-tree", base, "--", path]);
    const present = await gitBytes(parent, ["ls-tree", current, "--", path]);
    if (!original.equals(present)) throw new Error(`Integration conflict: ${path} changed in the parent. Inspect both versions and discard or resolve this child result.`);
    const entry = (await gitBytes(child, ["ls-tree", result, "--", path])).toString();
    if (/^(120000|160000) /.test(entry)) throw new Error(`Integration does not accept symlinks or submodules: ${path}`);
    let ancestor = dirname(join(parent, path));
    while (!await lstat(ancestor).then(() => true, () => false)) ancestor = dirname(ancestor);
    if (!contained(await realpath(parent), await realpath(ancestor))) throw new Error("An integration path escapes the project.");
  }
  const temp = await mkdtemp(join(dataDir, "integration-")), file = join(temp, "changes.patch");
  try {
    await writeFile(file, patch, { mode: 0o600 });
    await gitBytes(parent, ["apply", "--check", "--binary", file]);
    if (before !== await codeReference(parent)) throw new Error("Parent files changed during integration. No child changes were applied.");
    signal?.throwIfAborted();
    await gitBytes(parent, ["apply", "--binary", file]);
    return { files, diff: patch.toString(), reference: await codeReference(parent) };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
