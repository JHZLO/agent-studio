import { mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { Studio } from "../packages/engine/studio.ts";
import { Store } from "../packages/engine/store.ts";
import type { Run } from "../packages/contracts/index.ts";
const completed: Run = JSON.parse(await readFile(new URL("../.local/smoke-result.json", import.meta.url), "utf8"));
assert.equal(completed.status, "succeeded", "Run the real Codex smoke test first.");
const source = new Store(new URL("../.local/integration-data/studio.sqlite", import.meta.url).pathname);
const receipts = source.receipts(completed.id, completed.steps.at(-1)!.id); source.close();
assert(receipts.length > 0);
const results = [];
for (const scenario of ["completed", "missing-turn", "changed-project", "different-account"] as const) {
  const directory = await mkdtemp(join(tmpdir(), "studio-recovery-"));
  const socketDirectory = await mkdtemp("/tmp/studio-recovery-");
  const store = new Store(join(directory, "studio.sqlite")), run = structuredClone(completed), step = run.steps.at(-1)!;
  run.index = run.steps.length - 1; run.status = "running"; step.status = "running";
  delete step.socketPath; delete step.hostPid; delete step.finalText; delete step.completedAt; delete run.completedAt; delete run.terminal;
  run.artifacts = run.artifacts.filter(artifact => artifact.stepId !== step.id);
  if (scenario === "missing-turn") step.lastTurnId = randomUUID();
  if (scenario === "changed-project") { run.cwd = join(directory, "other"); await mkdir(run.cwd); }
  if (scenario === "different-account") step.accountFingerprint = "different";
  store.saveRun(run, "turn.accepted"); for (const receipt of receipts) store.saveRun(run, "tool.completed", receipt);
  const studio = new Studio(store, directory, socketDirectory);
  try {
    if (scenario === "changed-project") await assert.rejects(studio.dispatch("run.reconcile", { id: run.id }), /different thread or project/);
    else if (scenario === "different-account") await assert.rejects(studio.dispatch("run.reconcile", { id: run.id }), /account changed/);
    else {
      const recovered = await studio.dispatch("run.reconcile", { id: run.id }) as Run;
      assert.equal(recovered.status, scenario === "completed" ? "succeeded" : "needs_reconciliation");
      assert.equal(recovered.steps.at(-1)!.providerThreadId, step.providerThreadId);
    }
    results.push({ scenario, passed: true });
  } finally { await studio.close(); store.close(); await rm(directory, { recursive: true, force: true }); await rm(socketDirectory, { recursive: true, force: true }); }
}
await writeFile(new URL("../.local/recovery-proof.json", import.meta.url), JSON.stringify({ sourceRunId: completed.id, results }, null, 2)); console.log(results);
