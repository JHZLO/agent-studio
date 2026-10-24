import { z } from "zod";
import { flowEdges, flowLayers, relatedSteps } from "./flow.ts";

export const roleSchema = z.enum(["planner", "coder", "reviewer", "backend", "frontend", "documenter"]);
export const avatarSchema = z.enum(["role", "round", "square", "pebble", "cat", "bunny", "bear", "robot", "ghost", "star", "cloud", "sprout", "flower"]);
export const bindingSchema = z.object({ id: z.string().min(1).max(100), name: z.string().max(200), version: z.string().regex(/^[a-f0-9]{64}$/), fileCount: z.number().optional() });
export const agentSchema = z.object({
  id: z.string().min(1).max(100), role: roleSchema, name: z.string().trim().min(1).max(40),
  avatar: avatarSchema.optional(),
  provider: z.enum(["codex", "claude"]), auth: z.enum(["subscription", "api"]), model: z.string().min(1).max(100),
  permissionLevel: z.enum(["ask", "read-only", "project", "bypass"]).default("ask"),
  codexFastMode: z.enum(["default", "on", "off"]).default("default"),
  prompt: z.string().trim().min(1).max(20000), tools: z.array(z.enum(["read", "write", "shell", "browser"])).max(4),
  delegation: z.object({ enabled: z.boolean().default(false), maxChildren: z.number().int().min(1).max(3).default(3), allowedAgentIds: z.array(z.string().min(1).max(100)).max(100).default([]) }).optional(),
  skillBindings: z.array(bindingSchema).max(30).default([]),
});
export const executionSchema = z.object({ mode: z.enum(["local", "worktree"]), baseRef: z.string().nullable().optional(), branchName: z.string().max(200).default("") });
export const projectSchema = z.object({ id: z.string().min(1).max(100), name: z.string().trim().min(1).max(100), path: z.string().min(1).max(4096), execution: executionSchema }).passthrough();
export const flowRuleSchema = z.object({
  after: z.string(), review: z.enum(["auto", "always", "on_issue"]).default("auto"),
  lockOutputs: z.boolean().default(false), returnTo: z.string().optional(),
  loop: z.object({ target: z.string(), maxCycles: z.number().int().min(1).max(10), onLimit: z.enum(["review", "stop"]) }).optional(),
});
export function revisionGroups(flow: { workflow: string[]; rules?: z.infer<typeof flowRuleSchema>[] }) {
  const groups = new Map<string, { target: string; members: string[]; maxCycles: number; onLimit: "review" | "stop" }>();
  for (const rule of flow.rules ?? []) if (rule.loop) {
    const group = groups.get(rule.loop.target) ?? { ...rule.loop, members: [] };
    group.members.push(rule.after); groups.set(group.target, group);
  }
  return [...groups.values()].map(group => {
    group.members.sort((a, b) => flow.workflow.indexOf(a) - flow.workflow.indexOf(b));
    return { ...group, key: group.members.length === 1 ? group.members[0] : `shared:${group.target}` };
  });
}
export const flowSchema = z.object({
  id: z.string().min(1).max(100), name: z.string().trim().min(1).max(100), workflow: z.array(z.string()).max(12), archived: z.boolean().default(false),
  edges: z.array(z.object({ from: z.string(), to: z.string() })).max(132).optional(),
  maxParallel: z.number().int().min(1).max(8).optional(),
  revision: z.number().int().positive().default(1), rules: z.array(flowRuleSchema).max(12).default([]),
}).superRefine((flow, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const edges = flowEdges(flow);
  if (edges.some(edge => edge.from === edge.to || !flow.workflow.includes(edge.from) || !flow.workflow.includes(edge.to))) issue("Connections must link two different agents in this flow.");
  if (new Set(edges.map(edge => JSON.stringify([edge.from, edge.to]))).size !== edges.length) issue("This connection already exists.");
  try { flowLayers(flow); } catch (error) { issue((error as Error).message); }
  if (new Set(flow.rules.map(rule => rule.after)).size !== flow.rules.length) issue("Each step can have only one flow rule.");
  for (const rule of flow.rules) {
    const end = flow.workflow.indexOf(rule.after);
    if (end < 0) issue("Flow rules must reference a step in this flow.");
    if (rule.returnTo && rule.returnTo !== rule.after && !relatedSteps(flow, rule.after, "upstream").has(rule.returnTo)) issue("Revision requests must return to this step or an earlier step.");
    if (rule.lockOutputs && rule.review !== "always") issue("Locking outputs requires a review after every completion.");
    if (rule.loop) {
      const start = flow.workflow.indexOf(rule.loop.target);
      if (start < 0 || !relatedSteps(flow, rule.after, "upstream").has(rule.loop.target)) issue("A loop must return to an earlier step.");
      if (flow.rules.some(other => other.loop?.target === rule.loop!.target && (other.loop.maxCycles !== rule.loop!.maxCycles || other.loop.onLimit !== rule.loop!.onLimit))) issue("Steps returning to the same agent must share the revision limit and limit action.");
    }
  }
  const ranges: Set<string>[] = [];
  for (const group of revisionGroups(flow)) {
    const downstream = relatedSteps(flow, group.target, "downstream"), range = new Set([group.target]);
    for (const member of group.members) {
      range.add(member);
      for (const id of relatedSteps(flow, member, "upstream")) if (downstream.has(id)) range.add(id);
    }
    if (ranges.some(previous => [...range].some(id => previous.has(id)))) issue("Loop ranges with different return targets cannot overlap.");
    ranges.push(range);
  }
});
export const settingsSchema = z.object({
  version: z.literal(1), agents: z.array(agentSchema).min(1).max(100), flows: z.array(flowSchema).min(1).max(100),
  activeFlowId: z.string(), projects: z.array(projectSchema).max(100), activeProjectId: z.string().nullable(),
  skillRoots: z.array(z.string().max(1000)).max(12), approvalRequired: z.boolean(), brief: z.string().max(2000),
  navigationCollapsed: z.boolean().optional(),
  language: z.enum(["en", "ko"]).default("en"),
  maxConcurrentRuns: z.number().int().min(1).max(8).default(1),
}).superRefine((value, ctx) => {
  const ids = new Set(value.agents.map(a => a.id));
  if (ids.size !== value.agents.length || new Set(value.flows.map(f => f.id)).size !== value.flows.length) ctx.addIssue({ code: "custom", message: "Preset and flow IDs must be unique." });
  if (!value.flows.some(f => f.id === value.activeFlowId && !f.archived)) ctx.addIssue({ code: "custom", message: "Keep an active flow selected." });
  if (value.flows.some(f => new Set(f.workflow).size !== f.workflow.length || f.workflow.some(id => !ids.has(id)))) ctx.addIssue({ code: "custom", message: "Flows must reference unique existing presets." });
  if (value.agents.some(agent => agent.delegation?.allowedAgentIds.some(id => !ids.has(id)))) ctx.addIssue({ code: "custom", message: "Delegation must reference existing agent presets." });
  if (new Set(value.projects.map(p => p.path)).size !== value.projects.length) ctx.addIssue({ code: "custom", message: "This project folder is already registered." });
  if (new Set(value.projects.map(p => p.id)).size !== value.projects.length) ctx.addIssue({ code: "custom", message: "Project IDs must be unique." });
  if (value.activeProjectId !== null && !value.projects.some(p => p.id === value.activeProjectId)) ctx.addIssue({ code: "custom", message: "Select a registered project or clear the selection." });
});
export type Settings = z.infer<typeof settingsSchema>;
export type Agent = z.infer<typeof agentSchema> & { skillSnapshots?: Binding[] };
export type Binding = z.infer<typeof bindingSchema> & { sourcePath?: string };
export type Project = z.infer<typeof projectSchema>;
export type SubscriptionUsage = { status: "available" | "unavailable"; checkedAt: string; windows: { label: string; remainingPercent: number; resetsAt?: string }[]; message?: string };
export type Connection = { id: string; provider: "codex" | "claude"; auth: "subscription" | "api"; connected: boolean; models: string[]; modelDetails?: { value: string; displayName: string; resolvedModel?: string; supportsFastMode?: boolean }[]; account?: { email?: string; plan?: string; organization?: string }; usage?: SubscriptionUsage; checkedAt?: string; error?: string; version?: string; billingMode: string; credentialStorage?: string };
export type Status = "queued" | "running" | "waiting_approval" | "waiting_review" | "paused" | "cancelling" | "cancelled" | "succeeded" | "failed" | "needs_reconciliation";
export type Message = { id: string; type: "assistant" | "user" | "tool" | "system"; text: string; time: string };
export type LocalProject = { key: string; name: string; path: string; providers: ("codex" | "claude")[]; available: boolean };
export type LocalSession = { key: string; provider: "codex" | "claude"; sourceId: string; title: string; projectKey: string; cwd: string; updatedAt: string };
export type ImportedSession = LocalSession & { project: Project; importedAt: string; messages: Message[]; truncated: boolean };
export type Artifact = { id: string; name: string; type: string; content: string; agent: string; stepId: string; codeReference?: string; mediaPath?: string; mime?: string; verified?: boolean; stale?: boolean; superseded?: boolean };
export const findingSchema = z.object({ title: z.string().min(1).max(500), severity: z.enum(["critical", "high", "medium", "low"]), location: z.string().max(1000), reproduction: z.string().min(1).max(4000), expected: z.string().min(1).max(2000), actual: z.string().min(1).max(2000), evidence: z.array(z.string().max(500)).max(12) });
export type Finding = z.infer<typeof findingSchema> & { id: string };
export type Revision = { id: string; sourceStepId: string; sourceAgentId: string; targetAgentId: string; summary: string; artifactIds: string[]; findings: Finding[]; automatic: boolean; createdAt: string; codeReference?: string; cycle?: number; maxCycles?: number };
export type SessionInput = { delegationContinuation?: boolean; acceptingMessages?: boolean; activeMessage?: AgentMessage; interruptRequested?: boolean };
export type Step = SessionInput & { workspace?: string; baseCommit?: string; resultCommit?: string; pendingCommits?: string[]; purpose?: "merge"; id: string; agent: Agent; status: Status; sessionId: string; messages: Message[]; receivedArtifacts: { id: string; name: string }[]; providerThreadId?: string; activeTurnId?: string; lastTurnId?: string; socketPath?: string; hostPid?: number; connectionGeneration?: string; accountFingerprint?: string; actualModel?: string; actualServiceTier?: string; codeReference?: string; usage?: Record<string, unknown>; finalText?: string; completedAt?: string; attempt?: number; feedback?: string; feedbackArtifactIds?: string[]; reviewRequired?: boolean; decision?: "pass" | "revise" | "scope_change" };
export type FlowReview = { id: string; stepId: string; kind: "checkpoint" | "issue" | "loop_limit" | "scope_change"; artifactIds: string[]; fingerprint: string; version: number; returnTo: string; lockOutputs: boolean; summary: string; createdAt: string; codeReference: string };
export type Approval = { id: string; stepId: string; kind: "write" | "shell" | "network" | "provider"; description: string; details: string; generation?: string; requestId?: string | number; method?: string };
export type AgentMessage = { id: string; stepId: string; message: string; mode: "queue" | "interrupt"; createdAt: string; turnId?: string };
export type MergeState = { targetStepId: string; workspace: string; round: number; status: "resolving" | "checking" | "agreed" | "blocked"; conflicts: string[]; contributors: string[]; sessions: Step[]; votes: { agentId: string; decision: string; summary: string }[] };
export type Run = { branchRepository?: string; branchBase?: string; sourceReference?: string; merge?: MergeState; id: string; brief: string; project: Project; projectRules?: string[]; flow: z.infer<typeof flowSchema>; status: Status; createdAt: string; completedAt?: string; index: number; steps: Step[]; artifacts: Artifact[]; note: string; cwd: string; baseHead: string | null; approvalRequired: boolean; approval?: Approval; approved: boolean; pauseRequested: boolean; controlMode: "studio" | "terminal" | "switching"; eventSeq: number; terminal?: { id: string; stepId: string; connected: boolean; socketPath?: string; pid?: number }; commandId: string;
  review?: FlowReview; pendingReviews?: FlowReview[]; approvals?: Approval[]; reviewHistory?: (FlowReview & { action: "approved" | "revision_requested"; feedback?: string; resolvedAt: string })[];
  stepHistory?: Step[]; loopCounts?: Record<string, number>; lockedPlan?: { version: number; stepId: string; artifactIds: string[] };
  revisionHistory?: Revision[];
  followup?: { id: string; stepId: string; message: string; startedAt: string; previousStatus: Status; previousStepStatus: Status; previousNote: string; previousFinalText?: string; codeReference: string; turnId?: string; stopRequested?: boolean };
  parent?: { runId: string; stepId: string; task: string; write: boolean; snapshot?: string; sourceReference: string; resolution: "pending" | "accepted" | "discarded"; reason?: string; integratedReference?: string; integratedAt?: string };
  delegatePresets?: Agent[]; children?: Run[]; delegationContinuation?: boolean;
  acceptingMessages?: boolean; pendingMessages?: AgentMessage[]; activeMessage?: AgentMessage; interruptRequested?: boolean;
};
export const activeStatuses: Status[] = ["queued", "running", "waiting_approval", "waiting_review", "paused", "cancelling", "needs_reconciliation"];
export const now = () => new Date().toISOString();
