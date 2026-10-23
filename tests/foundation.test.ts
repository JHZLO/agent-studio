import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { settingsSchema, type Run } from "../packages/contracts/index.ts";
import { initialState } from "../packages/contracts/defaults.js";

async function directory(t: test.TestContext) { const path = await realpath(await mkdtemp(join(tmpdir(), "studio-test-"))); t.after(() => rm(path, { recursive: true, force: true })); return path; }
function initGit(path: string) {
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "Initial commit"]);
}
test("Settings reject invalid flow references and archiving every flow", () => {
  const settings = settingsSchema.parse(initialState());
  settings.flows[0].workflow.push("missing"); assert.equal(settingsSchema.safeParse(settings).success, false);
  const archived = settingsSchema.parse(initialState()); archived.flows[0].archived = true;
  assert.equal(settingsSchema.safeParse(archived).success, false);
});
