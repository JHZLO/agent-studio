import { cp, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { constants } from "node:fs";
import type { Run, Step } from "../contracts/index.ts";
import { contained, git, secretPath } from "./projects.ts";
import { codeReference } from "./tools.ts";

const generated = new Set(["node_modules", "target", "dist", "build", "coverage", ".gradle", ".idea", ".next", ".venv"]);
const identity = ["-c", "user.name=Agent Studio", "-c", "user.email=studio@localhost", "-c", "commit.gpgsign=false"];

export class BranchWorkspaces {
  constructor(readonly directory: string) {}

  async initialize(run: Run) {
    const repository = join(this.directory, run.id, "repository");
    await mkdir(repository, { recursive: true, mode: 0o700 });
    const reference = await codeReference(run.cwd);
    const copy = async (source: string) => {
      for (const entry of await readdir(source, { withFileTypes: true })) {
        const path = join(source, entry.name), rel = relative(run.cwd, path);
        if (generated.has(entry.name) || entry.name === ".git" || entry.name === ".local" || entry.name === ".agents" || secretPath(rel) || entry.isSymbolicLink()) continue;
        const target = join(repository, rel);
        if (entry.isDirectory()) { await mkdir(target, { recursive: true }); await copy(path); }
        else if (entry.isFile()) await cp(path, target, { mode: constants.COPYFILE_FICLONE });
      }
    };
    const paths = await git(run.cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    if (paths === null) await copy(run.cwd);
    else for (const rel of [...new Set(paths.split("\0").filter(Boolean))]) {
      if (secretPath(rel) || rel.split("/").some(part => generated.has(part) || [".git", ".local", ".agents"].includes(part))) continue;
      const source = join(run.cwd, rel), info = await lstat(source).catch(() => null);
      if (!info?.isFile() || !contained(run.cwd, await realpath(source))) continue;
      const target = join(repository, rel); await mkdir(join(target, ".."), { recursive: true });
      await cp(source, target, { mode: constants.COPYFILE_FICLONE });
    }
    if (reference !== await codeReference(run.cwd)) throw new Error("Project files changed while creating the branch baseline. Start again from a stable project.");
    await git(repository, ["init", "--quiet"], true);
    await this.commit(repository, "Capture task baseline");
    run.branchRepository = repository;
    run.branchBase = (await git(repository, ["rev-parse", "HEAD"]))!;
    run.sourceReference = reference;
  }

  async prepare(run: Run, step: Step, parents: Step[]) {
    if (!run.branchRepository || !run.branchBase) throw new Error("The branch baseline is unavailable.");
    const commits = [...new Set(parents.map(parent => parent.resultCommit!))];
    if (parents.some(parent => !parent.resultCommit)) throw new Error("A predecessor has no saved branch result.");
    const cwd = join(this.directory, run.id, "workspaces", step.id);
    await mkdir(join(cwd, ".."), { recursive: true, mode: 0o700 });
    await git(run.branchRepository, ["worktree", "add", "--detach", cwd, commits[0] ?? run.branchBase], true);
    step.workspace = await realpath(cwd);
    step.baseCommit = commits[0] ?? run.branchBase;
    step.pendingCommits = commits.slice(1);
    return this.combine(step);
  }

  async combine(step: Step) {
    const cwd = step.workspace!;
    while (step.pendingCommits?.length) {
      const commit = step.pendingCommits.shift()!;
      try { await git(cwd, [...identity, "merge", "--no-commit", "--no-ff", commit], true); }
      catch (error) { if (!(await this.conflicts(cwd)).length) throw error; return this.conflicts(cwd); }
      await this.commit(cwd, "Combine predecessor branches");
    }
    step.baseCommit = (await git(cwd, ["rev-parse", "HEAD"]))!;
    return [];
  }

  async conflicts(cwd: string) { return (await git(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"]) ?? "").split("\0").filter(Boolean); }

  async unresolved(cwd: string, paths: string[]) {
    const unresolved: string[] = [];
    for (const path of paths) {
      const file = join(cwd, path), info = await lstat(file).catch(() => null);
      if (!info) continue;
      if (!info.isFile() || !contained(cwd, await realpath(file))) { unresolved.push(path); continue; }
      const contents = await readFile(file);
      if (contents.includes(0) || /^<<<<<<< |^=======$|^>>>>>>> /m.test(contents.toString("utf8"))) unresolved.push(path);
    }
    return unresolved;
  }

  async commit(cwd: string, message: string) {
    await git(cwd, ["add", "--all"], true);
    await git(cwd, [...identity, "commit", "--quiet", "--no-verify", "--allow-empty", "-m", message], true);
    return (await git(cwd, ["rev-parse", "HEAD"]))!;
  }

  async finish(step: Step) { step.resultCommit = await this.commit(step.workspace!, "Save agent result"); }

  async publish(run: Run, commit: string) {
    if (run.sourceReference !== await codeReference(run.cwd)) throw new Error("The original project changed during branch work. Inspect the saved branches before applying their result.");
    const patch = await git(run.branchRepository!, ["diff", "--binary", run.branchBase!, commit], false, false);
    if (patch === null) throw new Error("The saved branch result could not be read.");
    if (!patch) return;
    const path = join(this.directory, run.id, "result.patch"); await writeFile(path, patch, { mode: 0o600 });
    const repository = await git(run.cwd, ["rev-parse", "--show-toplevel"]);
    const prefix = repository ? await git(run.cwd, ["rev-parse", "--show-prefix"]) : "";
    const directory = prefix ? ["--directory", prefix.replace(/\/$/, "")] : [];
    await git(repository || run.cwd, ["apply", ...directory, "--check", path], true);
    await git(repository || run.cwd, ["apply", ...directory, path], true);
  }
}
