import { realpath, stat, readdir, mkdir, readFile, lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, dirname, basename, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Project } from "../contracts/index.ts";
import { executionSchema } from "../contracts/index.ts";
const exec = promisify(execFile);
export const expand = (raw: string) => raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
export const contained = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
export const secretPath = (path: string) => path.split(/[\\/]/).some(part => /^\.(git|env|ssh|aws|gnupg|codex|claude|local)$/.test(part) || /^\.env[.]/.test(part) || /(?:credentials|private[._-]?key|\.pem$|\.key$)/i.test(part));
const hiddenProjectPath = (path: string) => secretPath(path) || path.split(/[\\/]/).some(part => (part.startsWith(".") && part !== ".") || ["node_modules", "target", "dist", "build", "coverage"].includes(part));

async function projectEntry(cwd: string, raw: string) {
  if (typeof raw !== "string" || !raw || raw.length > 4096 || isAbsolute(raw) || hiddenProjectPath(raw)) throw new Error("Choose a visible file inside this task's project.");
  const root = await realpath(cwd), target = await realpath(resolve(root, raw));
  if (!contained(root, target) || hiddenProjectPath(relative(root, target)) || (await lstat(resolve(root, raw))).isSymbolicLink()) throw new Error("Files must stay inside this task's project without symlinks.");
  return { root, target };
}

export async function projectFiles(cwd: string, path = ".") {
  const { root, target } = await projectEntry(cwd, path);
  const entries = await readdir(target, { withFileTypes: true });
  const visible = entries.filter(entry => !hiddenProjectPath(entry.name) && !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()));
  if (visible.length > 1000) throw new Error("This folder has too many entries to display. Open a smaller folder.");
  return {
    path: relative(root, target) || ".", parent: target === root ? null : relative(root, dirname(target)) || ".",
    entries: visible.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).map(entry => ({ name: entry.name, path: relative(root, join(target, entry.name)), directory: entry.isDirectory() })),
  };
}

export async function readProjectFile(cwd: string, path: string) {
  const { root, target } = await projectEntry(cwd, path);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat(), limit = 256 * 1024;
    if (!info.isFile()) throw new Error("Choose a regular text file.");
    if (info.size > limit) throw new Error("Preview supports text files up to 256 KB.");
    const buffer = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!read.bytesRead) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > limit) throw new Error("Preview supports text files up to 256 KB.");
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw new Error("Preview supports UTF-8 text files.");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("Preview supports UTF-8 text files."); }
    return { path: relative(root, target), content, modifiedAt: info.mtime.toISOString() };
  } finally { await file.close(); }
}
export async function projectInstructions(cwd: string, source: string) {
  const rules: string[] = [];
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    for (const directory of [...new Set([cwd, source])]) {
      const path = join(directory, name);
      const info = await stat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (!info) continue;
      if (!info.isFile() || !contained(await realpath(directory), await realpath(path))) throw new Error(`${name} must be a file inside the selected project.`);
      if (info.size > 32000) throw new Error(`${name} exceeds the 32 KB instruction budget. Move supporting detail into selected skills.`);
      rules.push(`${name}:\n${await readFile(path, "utf8")}`); break;
    }
  }
  return rules;
}
export async function folder(raw: unknown) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 4096 || !isAbsolute(expand(raw))) throw new Error("Use an absolute local folder path.");
  const path = await realpath(expand(raw));
  if (!(await stat(path)).isDirectory()) throw new Error("Choose a folder, not a file.");
  return path;
}
export async function folders(raw: unknown = homedir()) {
  const path = await folder(raw);
  const entries = await readdir(path, { withFileTypes: true });
  const directories = entries.filter(e => !e.name.startsWith(".") && e.isDirectory());
  if (directories.length > 2000) throw new Error("Enter a more specific folder.");
  return { path, name: basename(path) || path, parent: dirname(path) === path ? null : dirname(path), folders: directories.sort((a, b) => a.name.localeCompare(b.name)).map(e => ({ name: e.name, path: join(path, e.name) })) };
}
export async function git(path: string, args: string[], mutate = false, trim = true) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  try {
    const result = await exec("git", ["--no-optional-locks", "-C", path, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { env: { ...env, GIT_TERMINAL_PROMPT: "0" }, timeout: mutate ? 120000 : 10000, maxBuffer: 8 * 1024 * 1024 });
    return trim ? result.stdout.trim() : result.stdout;
  } catch (error) {
    if (mutate) throw new Error(`Git operation failed: ${(error as { stderr?: string }).stderr?.trim() || "Check the project and branch."}`);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Install Git to inspect project branches.");
    return null;
  }
}
export async function inspectProject(raw: unknown, settings?: unknown) {
  const path = await folder(raw);
  const gitRoot = await git(path, ["rev-parse", "--show-toplevel"]);
  const head = gitRoot ? await git(path, ["rev-parse", "--verify", "HEAD"]) : null;
  const currentBranch = gitRoot ? await git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]) : null;
  const refs = gitRoot ? await git(path, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]) : "";
  if (refs === null) throw new Error("Could not read Git branches.");
  const branches = refs.split("\n").filter(ref => ref && !ref.endsWith("/HEAD")).map(ref => ({ ref, name: ref.replace(/^refs\/(heads|remotes)\//, "") }));
  if (head) branches.push({ ref: "HEAD", name: "Current commit" });
  const defaultRef = head ? (branches.some(b => b.ref === `refs/heads/${currentBranch}`) ? `refs/heads/${currentBranch}` : "HEAD") : null;
  if (settings !== undefined) {
    const execution = executionSchema.parse(settings);
    if (execution.mode === "worktree") {
      if (!head) throw new Error("A new worktree requires a Git repository with at least one commit.");
      if (!branches.some(b => b.ref === execution.baseRef)) throw new Error("The base branch is no longer available. Choose another branch.");
      const name = execution.branchName;
      if (name && (name.startsWith("-") || name.includes("@{") || await git(path, ["check-ref-format", "--branch", name]) === null)) throw new Error("Enter a valid new branch name.");
      if (name && branches.some(b => b.ref === `refs/heads/${name}`)) throw new Error("This branch already exists. Enter a new branch name.");
    }
  }
  return { path, folderName: basename(path), isGit: !!gitRoot, gitRoot, branches, currentBranch, defaultRef, head };
}
export async function prepareProject(project: Project, runId: string, dataDir: string) {
  const details = await inspectProject(project.path, project.execution);
  const snapshot = { ...project, ...details };
  if (project.execution.mode === "local") return { project: snapshot, cwd: details.path, baseHead: details.head };
  const parent = join(dataDir, "worktrees");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const path = join(parent, runId);
  const branch = project.execution.branchName || `jhzlo/studio-${runId.slice(0, 8)}`;
  const baseHead = await git(details.path, ["rev-parse", "--verify", `${project.execution.baseRef}^{commit}`]);
  if (!baseHead) throw new Error("The selected base commit is unavailable.");
  await git(details.path, ["worktree", "add", "-b", branch, path, baseHead], true);
  return { project: { ...snapshot, execution: { ...snapshot.execution, branchName: branch } }, cwd: await realpath(path), baseHead };
}
