import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store, hash } from "../packages/engine/store.ts";
import { settingsSchema, type Run } from "../packages/contracts/index.ts";
import { initialState } from "../packages/contracts/defaults.js";

async function directory(t: test.TestContext) { const path = await realpath(await mkdtemp(join(tmpdir(), "studio-test-"))); t.after(() => rm(path, { recursive: true, force: true })); return path; }
function initGit(path: string) {
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "Initial commit"]);
}
test("Command replay returns the saved result without repeating side effects", async t => {
  const path = await directory(t); const store = new Store(join(path, "state.sqlite")); t.after(() => store.close());
  let writes = 0;
  const execute = async () => ({ writes: ++writes });
  assert.deepEqual(await store.command("id", "write", { path: "a" }, execute), { writes: 1 });
  assert.deepEqual(await store.command("id", "write", { path: "a" }, execute), { writes: 1 });
  await assert.rejects(store.command("id", "write", { path: "b" }, execute), /different input/);
  assert.equal(writes, 1);
});
test("A command interrupted before its acknowledgement is never replayed automatically", async t => {
  const path = await directory(t); const store = new Store(join(path, "state.sqlite")); t.after(() => store.close());
  store.db.prepare("INSERT INTO commands VALUES (?, ?, ?, 'pending', NULL, NULL)").run("pending", "write", hash("{}"));
  await assert.rejects(store.command("pending", "write", {}, async () => assert.fail("Must not execute")), /uncertain/);
});
test("Settings reject invalid flow references and archiving every flow", () => {
  const settings = settingsSchema.parse(initialState());
  settings.flows[0].workflow.push("missing"); assert.equal(settingsSchema.safeParse(settings).success, false);
  const archived = settingsSchema.parse(initialState()); archived.flows[0].archived = true;
  assert.equal(settingsSchema.safeParse(archived).success, false);
});
test("History lists remain small while complete conversations stay retrievable", async t => {
  const path = await directory(t), store = new Store(join(path, "state.sqlite")); t.after(() => store.close());
  const settings = settingsSchema.parse(initialState()); store.set("settings", settings);
  const old = { id: "old", createdAt: "2026-01-01", brief: "Previous task", project: { name: "Project" }, flow: { name: "Flow" }, status: "succeeded", artifacts: [{ name: "report.md", content: "e".repeat(100000) }], steps: [{ messages: [{ text: "m".repeat(100000) }] }] } as unknown as Run;
  store.saveRun(old, "run.completed"); store.saveRun({ ...old, id: "new", createdAt: "2026-01-02", artifacts: [], steps: [] }, "run.completed");
  const state = store.state(); assert.equal(state.history.length, 1); assert.equal(state.history[0].artifactCount, 1);
  assert(JSON.stringify(state.history).length < 1000); assert.equal(store.run("old")!.steps[0].messages[0].text.length, 100000);
});
