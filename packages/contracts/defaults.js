const roles = {
  planner: { label: "Planner", icon: "compass", color: "#5b41bd", background: "#dccfff", description: "Turn the brief into a clear plan and a QA sheet before anyone writes code." },
  coder: { label: "Coder", icon: "code", color: "#23629f", background: "#c6e3ff", description: "Implement the plan in the selected project environment, following your coding rules." },
  reviewer: { label: "Reviewer", icon: "shield", color: "#1b7451", background: "#c4efd9", description: "Review the actual changes and link findings to the tested version." },
  backend: { label: "Backend QA", icon: "terminal", color: "#85600a", background: "#ffe9a6", description: "Exercise API edge cases and run bounded load tests against a test target." },
  frontend: { label: "Frontend QA", icon: "browser", color: "#ab3567", background: "#ffd0e1", description: "Walk through the QA sheet in a browser and collect visible evidence." },
  documenter: { label: "Documenter", icon: "file", color: "#a9501f", background: "#ffd8c0", description: "Update documentation using verified changes and the test results." },
};

const models = {
  codex: ["default"],
  claude: ["default"],
};

const prompts = {
  planner: "Inspect the project and its rules. Return implementation-plan.md and qa-sheet.md with acceptance criteria before coding. Every draft must explain the plan with a relevant fenced mermaid diagram and a short explanation. Always include a human-decisions section: stable decision IDs, options and tradeoffs, recommendation and reason, unresolved impact, and status. Highlight unresolved choices in the summary; explicitly say when no human decision is needed. Separate facts, assumptions, and user-agreed choices. Preserve agreed decisions on revisions. A discussable draft can be completed while decisions are open; a recommendation is not approval. Wait for the user's plan lock before handing off to Coder.",
  coder: "Inspect existing code first. Implement the approved plan with the smallest useful change. Follow project rules. Use Studio's write approval before changing files.",
  reviewer: "Review the diff against the plan. Prioritize concrete defects, missing cases, and security risks. Cite evidence. Do not edit code.",
  backend: "Run the API cases from the QA sheet. Check empty, invalid, and duplicate inputs. Record expected and actual outcomes. Use test targets only.",
  frontend: "Follow the QA sheet in the browser. Check keyboard access, error messages, and successful submission. Save evidence for every case.",
  documenter: "Update documentation from the verified implementation. Include setup, behavior, and known limitations. Link the test evidence.",
};

function initialState() {
  return {
    version: 1,
    language: "en",
    maxConcurrentRuns: 1,
    skillRoots: ["~/.agents/skills", "~/.codex/skills", "~/.claude/skills"],
    agents: Object.entries(roles).map(([role, details]) => ({
      id: role,
      role,
      name: details.label,
      provider: ["planner", "reviewer", "documenter"].includes(role) ? "claude" : "codex",
      model: ["planner", "reviewer", "documenter"].includes(role) ? "default" : "default",
      auth: "subscription",
      permissionLevel: "ask",
      codexFastMode: "default",
      prompt: prompts[role],
      skillBindings: [],
      tools: ["read", ...(["coder", "documenter"].includes(role) ? ["write"] : []), ...(["coder", "backend", "frontend"].includes(role) ? ["shell"] : []), ...(role === "frontend" ? ["browser"] : [])],
    })),
    flows: [{ id: "flow-default", name: "Feature delivery", workflow: Object.keys(roles), archived: false }],
    activeFlowId: "flow-default",
    connections: [
      { id: "codex-subscription", provider: "codex", auth: "subscription", connected: false, models: [], billingMode: "subscription" },
      { id: "claude-subscription", provider: "claude", auth: "subscription", connected: false, models: [], billingMode: "subscription" },
    ],
    brief: "",
    projects: [],
    activeProjectId: null,
    approvalRequired: true,
    run: null,
    history: [],
    nextRun: 1,
  };
}

function initializeFlows(state) {
  if (!state.flows?.length) state.flows = [{ id: "flow-default", name: "Feature delivery", workflow: [...(state.workflow || [])], archived: false }];
  if (!state.flows.some(flow => !flow.archived)) state.flows[0].archived = false;
  if (!state.flows.some(flow => flow.id === state.activeFlowId && !flow.archived)) state.activeFlowId = state.flows.find(flow => !flow.archived).id;
  delete state.workflow;
}

export { roles, models, prompts, initialState, initializeFlows };
