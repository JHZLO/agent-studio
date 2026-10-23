import { z } from "zod";

export const roleSchema = z.enum(["planner", "coder", "reviewer", "backend", "frontend", "documenter"]);
export const bindingSchema = z.object({ id: z.string().min(1).max(100), name: z.string().max(200), version: z.string().regex(/^[a-f0-9]{64}$/), fileCount: z.number().optional() });
export const agentSchema = z.object({
  id: z.string().min(1).max(100), role: roleSchema, name: z.string().trim().min(1).max(40),
  provider: z.enum(["codex", "claude"]), auth: z.enum(["subscription", "api"]), model: z.string().min(1).max(100),
  prompt: z.string().trim().min(1).max(20000), tools: z.array(z.enum(["read", "write", "shell", "browser"])).max(4),
  skillBindings: z.array(bindingSchema).max(30).default([]),
});
export const executionSchema = z.object({ mode: z.enum(["local", "worktree"]), baseRef: z.string().nullable().optional(), branchName: z.string().max(200).default("") });
export const projectSchema = z.object({ id: z.string().min(1).max(100), name: z.string().trim().min(1).max(100), path: z.string().min(1).max(4096), execution: executionSchema }).passthrough();
export const flowSchema = z.object({ id: z.string().min(1).max(100), name: z.string().trim().min(1).max(100), workflow: z.array(z.string()).max(12), archived: z.boolean().default(false) });
export const settingsSchema = z.object({
  version: z.literal(1), agents: z.array(agentSchema).min(1).max(100), flows: z.array(flowSchema).min(1).max(100),
  activeFlowId: z.string(), projects: z.array(projectSchema).max(100), activeProjectId: z.string().nullable(),
  skillRoots: z.array(z.string().max(1000)).max(12), approvalRequired: z.boolean(), brief: z.string().max(2000),
  navigationCollapsed: z.boolean().optional(),
}).superRefine((value, ctx) => {
  const ids = new Set(value.agents.map(a => a.id));
  if (ids.size !== value.agents.length || new Set(value.flows.map(f => f.id)).size !== value.flows.length) ctx.addIssue({ code: "custom", message: "Preset and flow IDs must be unique." });
  if (!value.flows.some(f => f.id === value.activeFlowId && !f.archived)) ctx.addIssue({ code: "custom", message: "Keep an active flow selected." });
  if (value.flows.some(f => new Set(f.workflow).size !== f.workflow.length || f.workflow.some(id => !ids.has(id)))) ctx.addIssue({ code: "custom", message: "Flows must reference unique existing presets." });
  if (new Set(value.projects.map(p => p.path)).size !== value.projects.length) ctx.addIssue({ code: "custom", message: "This project folder is already registered." });
  if (new Set(value.projects.map(p => p.id)).size !== value.projects.length) ctx.addIssue({ code: "custom", message: "Project IDs must be unique." });
  if (value.activeProjectId !== null && !value.projects.some(p => p.id === value.activeProjectId)) ctx.addIssue({ code: "custom", message: "Select a registered project or clear the selection." });
});
export type Settings = z.infer<typeof settingsSchema>;
export type Agent = z.infer<typeof agentSchema> & { skillSnapshots?: Binding[] };
export type Binding = z.infer<typeof bindingSchema> & { sourcePath?: string };
export type Project = z.infer<typeof projectSchema>;
export type SubscriptionUsage = { status: "available" | "unavailable"; checkedAt: string; windows: { label: string; remainingPercent: number; resetsAt?: string }[]; message?: string };
export type Connection = { id: string; provider: "codex" | "claude"; auth: "subscription" | "api"; connected: boolean; models: string[]; modelDetails?: { value: string; displayName: string; resolvedModel?: string }[]; account?: { email?: string; plan?: string; organization?: string }; usage?: SubscriptionUsage; checkedAt?: string; error?: string; version?: string; billingMode: string; credentialStorage?: string };
export type Status = "queued" | "running" | "waiting_approval" | "paused" | "cancelling" | "cancelled" | "succeeded" | "failed" | "needs_reconciliation";
export type Message = { id: string; type: "assistant" | "user" | "tool" | "system"; text: string; time: string };
export type LocalProject = { key: string; name: string; path: string; providers: ("codex" | "claude")[]; available: boolean };
export type LocalSession = { key: string; provider: "codex" | "claude"; sourceId: string; title: string; projectKey: string; cwd: string; updatedAt: string };
export type ImportedSession = LocalSession & { project: Project; importedAt: string; messages: Message[]; truncated: boolean };
export type Artifact = { id: string; name: string; type: string; content: string; agent: string; stepId: string; codeReference?: string; mediaPath?: string; mime?: string; verified?: boolean; stale?: boolean };
export type Step = { id: string; agent: Agent; status: Status; sessionId: string; messages: Message[]; receivedArtifacts: { id: string; name: string }[]; providerThreadId?: string; activeTurnId?: string; lastTurnId?: string; socketPath?: string; hostPid?: number; connectionGeneration?: string; accountFingerprint?: string; actualModel?: string; codeReference?: string; usage?: Record<string, unknown>; finalText?: string; completedAt?: string };
export type Approval = { id: string; stepId: string; kind: "write" | "shell" | "network" | "provider"; description: string; details: string; generation?: string; requestId?: string | number; method?: string };
export type Run = { id: string; brief: string; project: Project; projectRules?: string[]; flow: z.infer<typeof flowSchema>; status: Status; createdAt: string; completedAt?: string; index: number; steps: Step[]; artifacts: Artifact[]; note: string; cwd: string; baseHead: string | null; approvalRequired: boolean; approval?: Approval; approved: boolean; pauseRequested: boolean; controlMode: "studio" | "terminal" | "switching"; eventSeq: number; terminal?: { id: string; stepId: string; connected: boolean; socketPath?: string; pid?: number }; commandId: string };
export const activeStatuses: Status[] = ["queued", "running", "waiting_approval", "paused", "cancelling", "needs_reconciliation"];
export const now = () => new Date().toISOString();
