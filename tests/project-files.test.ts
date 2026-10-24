import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFiles, readProjectFile } from "../packages/engine/projects.ts";
import { Store } from "../packages/engine/store.ts";
import { Studio } from "../packages/engine/studio.ts";
import { initialState } from "../packages/contracts/defaults.js";
import { settingsSchema, type Run } from "../packages/contracts/index.ts";

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "studio-source-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "worktree");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "Service.kt"), "class Service { fun value() = 1 }\n");
  return { root, cwd };
}

test("The source reader includes new files and returns current content without changing it", async t => {
  const { cwd } = await fixture(t);
  await writeFile(join(cwd, "README.md"), "# Current project");
  const listing = await projectFiles(cwd);
  assert.equal(listing.parent, null);
  assert.deepEqual(listing.entries.map(entry => [entry.path, entry.directory]), [["src", true], ["README.md", false]]);
  assert.equal((await projectFiles(cwd, "src")).parent, ".");
  const first = await readProjectFile(cwd, "src/Service.kt");
  assert.equal(first.content, "class Service { fun value() = 1 }\n");
  await writeFile(join(cwd, "src", "Service.kt"), "class Service { fun value() = 2 }\n");
  assert.equal((await readProjectFile(cwd, "src/Service.kt")).content, "class Service { fun value() = 2 }\n");
});

test("The source reader rejects escapes, secret paths, binary files and oversized files", async t => {
  const { root, cwd } = await fixture(t);
  await writeFile(join(root, "outside.txt"), "outside");
  await writeFile(join(cwd, ".env"), "PRIVATE=secret");
  await writeFile(join(cwd, "credentials.json"), "secret");
  await mkdir(join(cwd, "build")); await writeFile(join(cwd, "build", "output.txt"), "generated");
  await symlink(join(root, "outside.txt"), join(cwd, "outside.txt"));
  await symlink(root, join(cwd, "escape"));
  await symlink(join(cwd, ".env"), join(cwd, "config.txt"));
  assert.deepEqual((await projectFiles(cwd)).entries.map(entry => entry.name), ["src"]);
  for (const path of ["../outside.txt", join(root, "outside.txt"), "outside.txt", "escape/outside.txt", ".env", "credentials.json", "config.txt", "build/output.txt"]) {
    await assert.rejects(readProjectFile(cwd, path));
  }
  await writeFile(join(cwd, "large.txt"), Buffer.alloc(256 * 1024 + 1, 97));
  await writeFile(join(cwd, "binary.dat"), Buffer.from([0, 1, 2]));
  await writeFile(join(cwd, "invalid.txt"), Buffer.from([0xff, 0xfe]));
  await assert.rejects(readProjectFile(cwd, "large.txt"), /256 KB/);
  await assert.rejects(readProjectFile(cwd, "binary.dat"), /UTF-8/);
  await assert.rejects(readProjectFile(cwd, "invalid.txt"), /UTF-8/);
  await assert.rejects(readProjectFile(cwd, "src"), /regular text/);
});

test("Source requests resolve the saved run folder and do not modify execution or evidence", async t => {
  const { root, cwd } = await fixture(t), defaults = settingsSchema.parse(initialState());
  const store = new Store(join(root, "studio.sqlite"));
  const studio = new Studio(store, root, join(root, "sockets"));
  t.after(async () => { await studio.close(); store.close(); });
  const run: Run = {
    id: "read-run", brief: "Source fixture", createdAt: new Date().toISOString(),
    project: { id: "project", name: "Project", path: root, execution: { mode: "local", branchName: "" } },
    flow: defaults.flows[0], cwd, baseHead: null, status: "succeeded", index: 1,
    steps: [{ id: "step", agent: defaults.agents[0], status: "succeeded", sessionId: "session", messages: [], receivedArtifacts: [] }],
    artifacts: [], note: "", approvalRequired: true, approved: false, pauseRequested: false, controlMode: "studio", eventSeq: 0, commandId: "fixture",
  };
  store.saveRun(run, "fixture");
  const before = store.run(run.id), sequence = store.seq();
  const result = await studio.dispatch("run.file", { id: run.id, path: "src/Service.kt", cwd: root });
  assert.equal(result.content, "class Service { fun value() = 1 }\n");
  assert.equal((await studio.dispatch("run.files", { id: run.id })).entries[0].name, "src");
  await assert.rejects(studio.dispatch("run.file", { id: "unknown", path: "src/Service.kt" }), /Run not found/);
  assert.deepEqual(store.run(run.id), before); assert.equal(store.seq(), sequence);
});
