export function sessionTiming(step, run) {
  if (run.followup && run.followup.stepId === step.id) {
    const start = Date.parse(run.followup.startedAt);
    return Number.isFinite(start) && ["running", "waiting_approval"].includes(run.status) ? { kind: "running", start } : { kind: "unavailable" };
  }
  if (step.status === "queued" || (!step.messages.length && ["waiting_approval", "cancelled"].includes(step.status))) return { kind: "pending" };
  const start = Date.parse(step.messages[0]?.time);
  if (!Number.isFinite(start)) return { kind: "unavailable" };
  const end = Date.parse(step.completedAt || (["failed", "cancelled"].includes(step.status) ? run.completedAt : undefined));
  if (Number.isFinite(end)) return end >= start ? { kind: "completed", start, end } : { kind: "unavailable" };
  if (["running", "waiting_approval"].includes(step.status) && ["running", "waiting_approval", "cancelling"].includes(run.status)) return { kind: "running", start };
  return { kind: "unavailable" };
}

export function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const parts = [Math.floor(seconds / 60) % 60, seconds % 60];
  if (hours) parts.unshift(hours);
  return parts.map(part => String(part).padStart(2, "0")).join(":");
}
