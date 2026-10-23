import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Connections, subscriptionUsage } from "../packages/engine/connections.ts";
import { Store } from "../packages/engine/store.ts";

test("Codex usage prefers named buckets and keeps absent windows unknown", () => {
  const usage = subscriptionUsage("codex", {
    rateLimits: { primary: { usedPercent: 99 } },
    rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 80, windowDurationMins: 10080 } },
      review: { limitName: "Code review", primary: { usedPercent: 10, windowDurationMins: 10080 }, secondary: null },
      unknown: { primary: { usedPercent: null } },
    },
  });
  assert.equal(usage.status, "available");
  assert.deepEqual(usage.windows, [
    { label: "codex / 5-hour window", remainingPercent: 75, resetsAt: "2027-01-15T08:00:00.000Z" },
    { label: "codex / 7-day window", remainingPercent: 20 },
    { label: "Code review / 7-day window", remainingPercent: 90 },
  ]);
});

test("Usage handles legacy limits, zero usage, exhausted limits and invalid reset dates", () => {
  const usage = subscriptionUsage("codex", { rateLimitsByLimitId: {}, rateLimits: { primary: { usedPercent: 0, resetsAt: "invalid" }, secondary: { usedPercent: 120 } } });
  assert.deepEqual(usage.windows, [
    { label: "codex / Primary window", remainingPercent: 100 },
    { label: "codex / Secondary window", remainingPercent: 0 },
  ]);
  assert.equal(subscriptionUsage("codex", { rateLimits: { primary: { usedPercent: -10 } } }).windows[0].remainingPercent, 100);
  for (const input of [null, {}, [], "unavailable", { rateLimits: { primary: { usedPercent: "25" }, secondary: { usedPercent: NaN } } }]) {
    const missing = subscriptionUsage("codex", input);
    assert.equal(missing.status, "unavailable");
    assert.deepEqual(missing.windows, []);
    assert(missing.message);
  }
});

test("Claude usage includes model-specific windows without converting missing values to zero", () => {
  const input = { rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 2, resets_at: "2026-10-23T17:30:00+00:00" },
    seven_day: { utilization: 45, resets_at: null },
    seven_day_opus: { utilization: 10 }, seven_day_sonnet: null,
    model_scoped: [{ display_name: "Opus", utilization: 10 }, { display_name: "Fable", utilization: 0 }, { display_name: "Missing", utilization: null }],
    extra_usage: { is_enabled: false, utilization: 0 },
  } };
  const usage = subscriptionUsage("claude", input);
  assert.deepEqual(usage.windows, [
    { label: "5-hour window", remainingPercent: 98, resetsAt: "2026-10-23T17:30:00.000Z" },
    { label: "Weekly / all models", remainingPercent: 55 },
    { label: "Weekly / Opus", remainingPercent: 90 },
    { label: "Weekly / Fable", remainingPercent: 100 },
  ]);
  assert.equal(subscriptionUsage("claude", { ...input, rate_limits_available: false }).status, "unavailable");
  assert.equal(subscriptionUsage("claude", { rate_limits_available: true, rate_limits: null }).status, "unavailable");
});

test("A usage lookup failure preserves the connection and clears the previous usage snapshot", async t => {
  const path = await mkdtemp(join(tmpdir(), "studio-connections-"));
  const store = new Store(join(path, "state.sqlite")), connections = new Connections(store, path);
  t.after(async () => { await connections.close(); store.close(); await rm(path, { recursive: true, force: true }); });
  let usageFails = false, accountFails = false, email = "first@example.test";
  t.mock.method(connections, "host", async () => ({ client: { call: async (method: string) => {
    if (method === "account/read") {
      if (accountFails) throw new Error("Account unavailable");
      return { account: { type: "chatgpt", email, planType: "pro", accessToken: "must-not-be-saved" } };
    }
    if (method === "model/list") return { data: [{ id: "test-model" }] };
    assert.equal(method, "account/rateLimits/read");
    if (usageFails) throw new Error("Usage unavailable");
    return { rateLimits: { primary: { usedPercent: 30 } } };
  } } }));
  const first = await connections.check({ provider: "codex", auth: "subscription" });
  assert.equal(first.connected, true);
  assert.deepEqual(first.account, { email, plan: "pro" });
  assert.equal(first.usage?.windows[0].remainingPercent, 70);
  assert(!JSON.stringify(connections.list()).includes("must-not-be-saved"));
  store.set("connections", [first, { id: "claude-subscription", provider: "claude", auth: "subscription", connected: false, models: [], billingMode: "Subscription" }]);
  usageFails = true; email = "second@example.test";
  const unavailable = await connections.check({ provider: "codex", auth: "subscription" });
  assert.equal(unavailable.connected, true);
  assert.equal(unavailable.account?.email, email);
  assert.equal(unavailable.usage?.status, "unavailable");
  assert.deepEqual(unavailable.usage?.windows, []);
  assert.equal(unavailable.error, undefined);
  assert.deepEqual(connections.list().map(item => item.id), ["codex-subscription", "claude-subscription"]);
  accountFails = true;
  const failed = await connections.check({ provider: "codex", auth: "subscription" });
  assert.equal(failed.connected, false);
  assert.equal(failed.account, undefined);
  assert.equal(failed.usage, undefined);
});

test("Disconnect and runner restart discard account and usage display data", async t => {
  const path = await mkdtemp(join(tmpdir(), "studio-connections-"));
  const store = new Store(join(path, "state.sqlite"));
  t.after(async () => { store.close(); await rm(path, { recursive: true, force: true }); });
  const saved = { id: "claude-subscription", provider: "claude", auth: "subscription", connected: true, models: [], billingMode: "Subscription", account: { email: "person@example.test" }, usage: subscriptionUsage("claude", null) };
  store.set("connections", [saved]);
  const connections = new Connections(store, path);
  t.after(() => connections.close());
  assert.equal(connections.list()[0].connected, false);
  assert.equal(connections.list()[0].account, undefined);
  assert.equal(connections.list()[0].usage, undefined);
  store.set("connections", [saved]);
  const disconnected = await connections.disconnect(saved.id);
  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.account, undefined);
  assert.equal(disconnected.usage, undefined);
});
