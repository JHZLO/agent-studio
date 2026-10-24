import test from "node:test";
import assert from "node:assert/strict";
import { activitySnapshot, beginActivity, beginInteraction, refreshFeedback, trackActivity } from "../apps/web/feedback.js";

test("Overlapping requests retain independent labels and lifetimes", () => {
  const scan = beginActivity("Finding projects"), check = beginActivity("Checking account");
  try {
    assert.deepEqual(activitySnapshot().map(item => item.label), ["Finding projects", "Checking account"]);
    scan.update("Grouping worktrees");
    check.finish();
    assert.deepEqual(activitySnapshot().map(item => item.label), ["Grouping worktrees"]);
    scan.finish();
    scan.update("A late response");
    assert.deepEqual(activitySnapshot(), []);
  } finally { scan.finish(); check.finish(); }
});

test("Request feedback survives an await and clears after success", async () => {
  let complete!: (value: number) => void;
  const result = trackActivity("Preparing task", async (update: (label: string) => void) => {
    update("Preparing skill snapshots");
    return new Promise<number>(resolve => { complete = resolve; });
  });
  assert.equal(activitySnapshot()[0].label, "Preparing skill snapshots");
  complete(42);
  assert.equal(await result, 42);
  assert.deepEqual(activitySnapshot(), []);
});

test("Request failures clear their feedback without hiding another active request", async () => {
  const scan = beginActivity("Finding projects");
  try {
    await assert.rejects(trackActivity("Checking account", async () => { throw new Error("Connection failed"); }), /Connection failed/);
    assert.deepEqual(activitySnapshot().map(item => item.label), ["Finding projects"]);
  } finally { scan.finish(); }
  assert.deepEqual(activitySnapshot(), []);
});

test("Buttons remain locked across renders and preserve a server-owned busy state", t => {
  const button = (busy = false) => {
    const attributes = new Map([["data-action", "cancel"]]);
    const classes = new Set(busy ? ["is-busy"] : []);
    return {
      disabled: busy, isConnected: true,
      hasAttribute: (name: string) => attributes.has(name),
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
      classList: { add: (name: string) => classes.add(name), contains: (name: string) => classes.has(name), toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name) },
    };
  };
  const original = button();
  let buttons = [original];
  Object.defineProperty(globalThis, "document", { configurable: true, value: { body: {}, querySelector: () => null, querySelectorAll: (selector: string) => selector === "button" ? buttons : [] } });
  t.after(() => Reflect.deleteProperty(globalThis, "document"));
  const release = beginInteraction("cancel-task", original);
  assert(release);
  try {
    assert.equal(original.disabled, true);
    assert.equal(beginInteraction("cancel-task", original), null);
    const replacement = button(); original.isConnected = false; buttons = [replacement];
    refreshFeedback();
    assert.equal(replacement.disabled, true);
    assert.equal(replacement.getAttribute("aria-busy"), "true");
    const cancelling = button(true); replacement.isConnected = false; buttons = [cancelling];
    refreshFeedback(); release();
    assert.equal(cancelling.disabled, true);
    assert.equal(cancelling.classList.contains("is-busy"), true);
    assert.equal(original.disabled, false);
  } finally { release(); }
});
