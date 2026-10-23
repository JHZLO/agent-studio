import { realpath, stat, readdir, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, dirname, basename, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Project } from "../contracts/index.ts";
import { executionSchema } from "../contracts/index.ts";
const exec = promisify(execFile);
export const expand = (raw: string) => raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
export const contained = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
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
export async function git(path: string, args: string[], mutate = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  try {
    const result = await exec("git", ["--no-optional-locks", "-C", path, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { env: { ...env, GIT_TERMINAL_PROMPT: "0" }, timeout: mutate ? 120000 : 10000, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout.trim();
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
