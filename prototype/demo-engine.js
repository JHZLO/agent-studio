(() => {
  "use strict";

  const roles = {
    planner: { label: "Planner", icon: "compass", color: "#8b73ac", background: "#f0eaf7", description: "Turn the brief into a clear plan and a QA sheet before anyone writes code.", skills: ["Planning", "Schema design"] },
    coder: { label: "Coder", icon: "code", color: "#ba8b5c", background: "#f8efdf", description: "Implement the plan in an isolated worktree, following your coding rules.", skills: ["Code style", "Implementation"] },
    reviewer: { label: "Reviewer", icon: "shield", color: "#6c9561", background: "#edf3e5", description: "Review the actual changes and link findings to the tested version.", skills: ["Code review", "Security"] },
    backend: { label: "Backend QA", icon: "terminal", color: "#668ba7", background: "#eaf2f7", description: "Exercise API edge cases and run bounded load tests against a test target.", skills: ["API testing", "Load testing"] },
    frontend: { label: "Frontend QA", icon: "browser", color: "#b27a8e", background: "#f8edf2", description: "Walk through the QA sheet in a browser and collect visible evidence.", skills: ["Browser QA", "Accessibility"] },
    documenter: { label: "Documenter", icon: "file", color: "#8a9070", background: "#f0f2e6", description: "Update documentation using verified changes and the test results.", skills: ["Documentation", "Handoff"] },
  };

  const models = {
    codex: ["Codex default", "Codex fast"],
    claude: ["Claude Sonnet", "Claude Opus"],
  };

  const prompts = {
    planner: "Read the brief and project rules. Create a small implementation plan and a QA sheet. State assumptions. Define success before coding.",
    coder: "Inspect existing code first. Implement the approved plan with the smallest useful change. Follow project rules. Ask before changing files.",
    reviewer: "Review the diff against the plan. Prioritize concrete defects, missing cases, and security risks. Cite evidence. Do not edit code.",
    backend: "Run the API cases from the QA sheet. Check empty, invalid, and duplicate inputs. Record expected and actual outcomes. Use test targets only.",
    frontend: "Follow the QA sheet in the browser. Check keyboard access, error messages, and successful submission. Save evidence for every case.",
    documenter: "Update documentation from the verified implementation. Include setup, behavior, and known limitations. Link the test evidence.",
  };

  function initialState() {
    return {
      version: 1,
      agents: Object.entries(roles).map(([role, details]) => ({
        id: role,
        role,
        name: details.label,
        provider: ["planner", "reviewer", "documenter"].includes(role) ? "claude" : "codex",
        model: ["planner", "reviewer", "documenter"].includes(role) ? "Claude Sonnet" : "Codex default",
        auth: "subscription",
        prompt: prompts[role],
        skills: [...details.skills],
        tools: ["read", ...(["coder", "documenter"].includes(role) ? ["write"] : []), ...(["coder", "backend", "frontend"].includes(role) ? ["shell"] : []), ...(role === "frontend" ? ["browser"] : [])],
      })),
      workflow: Object.keys(roles),
      connections: [
        { id: "codex-subscription", provider: "codex", auth: "subscription", connected: true },
        { id: "claude-subscription", provider: "claude", auth: "subscription", connected: true },
      ],
      brief: "Add a newsletter signup form with email validation and clear success and error states.",
      approvalRequired: true,
      run: null,
      history: [],
      nextRun: 1,
    };
  }

  function scriptFor(step, run) {
    const prefix = `SIMULATED DEMO ARTIFACT\nRun: ${run.id}\nFixture: storefront-lab / newsletter signup\nRequested brief: ${run.brief}\n\n`;
    const artifact = (name, type, content) => ({ id: `${run.id}-${step.id}-${name}`, name, type, content: prefix + content, agent: step.agent.name, stepId: step.id });
    const scripts = {
      planner: {
        opening: "I will inspect the project conventions, then write a plan and QA cases before handing this task to the coder. The implementation should stay small and preserve the existing form pattern.",
        tool: "read_file  PROJECT_RULES.md\nread_file  src/components/contact-form.tsx\nresult     Existing accessible form pattern found in the sample fixture.",
        result: "The plan and four QA cases are ready. The next session receives the brief, decisions, artifact references, and the sample code version. The full conversation stays here.",
        artifacts: [
          artifact("implementation-plan.md", "Plan", "# Implementation plan\n\n1. Reuse the existing form component.\n2. Validate email input on the client and server.\n3. Handle duplicate subscriptions without creating a second record.\n4. Show accessible error and success states.\n5. Run the prepared QA cases before updating documentation.\n\nAcceptance: valid, empty, invalid, and duplicate submissions have defined outcomes.\nScope: the sample newsletter form only.\nThis is a scripted fixture, not a generated implementation."),
          artifact("qa-sheet.md", "QA sheet", "# QA cases prepared before implementation\n\nID     Case                 Expected\nQA-01  Valid email          Success message and one subscription\nQA-02  Empty email          Required-field error; no request\nQA-03  Invalid email        Inline error; no subscription\nQA-04  Duplicate email      Existing subscription preserved\n\nEvidence required: API response, browser result, code version.\nExecution status: pending. See the later QA reports for simulated results."),
        ],
      },
      coder: {
        opening: "I have the plan and QA sheet from the previous session. I will reuse the existing form and validation helpers in the demo worktree.",
        tool: "apply_patch  src/components/newsletter-form.tsx\napply_patch  src/api/subscribe.ts\nrun          newsletter unit tests\nresult       4 sample cases passed; diff fixture prepared.",
        result: "The sample change is ready for review: a validated form, duplicate-safe subscription handling, and clear feedback. No files on your computer were changed by this demo.",
        artifacts: [artifact("newsletter-change.diff", "Code diff", "diff --git a/src/components/newsletter-form.tsx b/src/components/newsletter-form.tsx\n--- a/src/components/newsletter-form.tsx\n+++ b/src/components/newsletter-form.tsx\n@@ sample fixture @@\n+ <label htmlFor=\"email\">Email address</label>\n+ <input id=\"email\" type=\"email\" required aria-describedby=\"email-error\" />\n+ <p id=\"email-error\" role=\"alert\">{error}</p>\n+ <p role=\"status\">{successMessage}</p>\n\nCode reference: demo-diff-v1\nThis excerpt demonstrates the artifact viewer. It is not an applied patch.")],
      },
      reviewer: {
        opening: "I will review the sample diff against the acceptance criteria. I will keep this session read-only and record findings with the code reference.",
        tool: "inspect_diff  demo-diff-v1\ncheck         input validation / accessible feedback / duplicate handling\nresult        No blocking findings in the scripted fixture.",
        result: "The review is complete. The fixture satisfies the plan. Backend and browser QA still need their own evidence; a clean review does not count as a test result.",
        artifacts: [artifact("review.md", "Review", "# Sample review\n\nCode reference: demo-diff-v1\nScope: newsletter form and subscription endpoint\n\nBlocking findings: none in the scripted fixture.\nChecks: server validation, clear error feedback, duplicate-safe behavior.\nFollow-up: run the prepared API and browser QA cases.\n\nThis is a simulated review, not a review of your repository.")],
      },
      backend: {
        opening: "I will exercise the four prepared cases against the sample API target. Load testing is limited to a test target and a fixed time budget.",
        tool: "POST /api/subscribe  valid email       -> 201\nPOST /api/subscribe  empty / invalid   -> 422\nPOST /api/subscribe  existing email    -> 200, no duplicate\nk6 sample           5 VUs / 10 seconds -> within fixture threshold",
        result: "All four sample API cases passed. The report records expected and actual results against demo-diff-v1. These responses and load statistics are simulated.",
        artifacts: [artifact("api-report.json", "API results", JSON.stringify({ simulated: true, codeReference: "demo-diff-v1", cases: [
          { id: "QA-01", expected: 201, observed: 201, status: "pass" },
          { id: "QA-02", expected: 422, observed: 422, status: "pass" },
          { id: "QA-03", expected: 422, observed: 422, status: "pass" },
          { id: "QA-04", expected: "no duplicate", observed: "no duplicate", status: "pass" },
        ], load: { tool: "k6", virtualUsers: 5, duration: "10 seconds", actualRequestsSent: 0 } }, null, 2))],
      },
      frontend: {
        opening: "I will follow the QA sheet in the browser, including keyboard navigation and both error and success feedback. The real product will use a separate browser runner.",
        tool: "browser.navigate  /newsletter\nbrowser.check     empty and invalid email feedback\nbrowser.check     success and duplicate states\nbrowser.check     label, focus order, and status announcement",
        result: "The four sample browser cases passed. Keyboard and feedback checks are recorded in the report. This prototype does not launch Playwright or capture real screenshots.",
        artifacts: [artifact("browser-qa.md", "Browser QA", "# Sample browser QA\n\nRunner: Playwright (planned integration)\nCode reference: demo-diff-v1\n\nQA-01: valid input -> success feedback. PASS (simulated)\nQA-02: empty input -> required-field feedback. PASS (simulated)\nQA-03: invalid input -> inline error. PASS (simulated)\nQA-04: duplicate input -> existing subscription preserved. PASS (simulated)\n\nKeyboard: label association and focus order checked in fixture.\nScreenshots: not captured by this prototype.\nNo real browser automation was performed by this run.")],
      },
      documenter: {
        opening: "I will use the plan, code reference, review, and QA reports to prepare the final documentation. Unverified claims will stay out of the handoff.",
        tool: "read_artifacts  plan / diff / review / API results / browser QA\nprepare         README update and final handoff\nresult          Documentation fixture ready.",
        result: "The demo workflow is complete. You can inspect every session and artifact. The final handoff includes the task, sample code reference, test evidence, and the prototype's limitations.",
        artifacts: [artifact("handoff.md", "Handoff", "# Final sample handoff\n\nChange: newsletter signup with validation and accessible feedback.\nCode reference: demo-diff-v1\nEvidence: implementation plan, QA sheet, code diff, review, API and browser reports.\n\nVerified in this prototype: workflow state transitions and artifact delivery.\nSimulated: implementation, AI responses, tests, usage, and account authentication.\nNot performed: real file changes, network requests, commits, or paid AI calls.\n\nNext action in the real product: review the artifacts before accepting the change.")],
      },
    };
    return scripts[step.agent.role] || scripts.planner;
  }

  class DemoEngine {
    constructor(onChange, savedRun = null) {
      this.onChange = onChange;
      this.run = savedRun ? structuredClone(savedRun) : null;
      this.timer = null;
      if (this.run?.status === "running") {
        this.run.status = "paused";
        this.run.note = "The page was reopened. Resume this browser-only simulation when ready.";
      }
      if (this.run?.status === "paused") this.run.steps[this.run.index].status = "paused";
    }

    isActive() {
      return this.run && ["running", "paused", "waiting_approval"].includes(this.run.status);
    }

    emit() {
      this.onChange(structuredClone(this.run));
    }

    start({ id, brief, agents, approvalRequired }) {
      if (this.isActive()) return false;
      clearTimeout(this.timer);
      this.run = {
        id, brief, status: "running", createdAt: new Date().toISOString(),
        index: 0, phase: 0, approved: !approvalRequired, artifacts: [],
        note: "Scripted demo. No AI calls or repository changes.",
        steps: agents.map((agent, index) => ({
          id: `${id}-step-${index + 1}`, agent: structuredClone(agent), status: "queued",
          sessionId: `${id}/session-${String(index + 1).padStart(2, "0")}`, messages: [], receivedArtifacts: [],
        })),
      };
      this.beginStep();
      return true;
    }

    beginStep() {
      const run = this.run;
      if (run.index >= run.steps.length) {
        run.status = "succeeded";
        run.completedAt = new Date().toISOString();
        run.note = "All demo steps completed. Inspect the sessions and sample artifacts.";
        this.emit();
        return;
      }
      const step = run.steps[run.index];
      step.receivedArtifacts = run.artifacts.map(item => ({ id: item.id, name: item.name }));
      if (["coder", "documenter"].includes(step.agent.role) && !step.agent.tools.includes("write")) {
        step.status = "failed";
        run.status = "failed";
        run.note = `${step.agent.name} needs file-write permission for this scripted task. Update the preset and start a new run.`;
        this.message("system", run.note);
        this.emit();
        return;
      }
      if (step.agent.tools.includes("write") && !run.approved) {
        step.status = "waiting_approval";
        run.status = "waiting_approval";
        this.message("system", "Approval requested: allow file changes in the demo worktree for this run. Your real files will not be touched.");
        this.emit();
        return;
      }
      step.status = "running";
      this.message("system", `Fresh session started with ${step.receivedArtifacts.length} artifact references. Preset and model settings are snapshotted for this run.`);
      this.emit();
      this.schedule();
    }

    message(type, text) {
      this.run.steps[this.run.index].messages.push({ type, text, time: new Date().toISOString() });
    }

    schedule() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.tick(), 1050);
    }

    tick() {
      const run = this.run;
      if (!run || run.status !== "running") return;
      const step = run.steps[run.index];
      const script = scriptFor(step, run);
      if (run.phase === 0) this.message("assistant", script.opening);
      if (run.phase === 1) this.message("tool", script.tool);
      if (run.phase === 2) {
        this.message("assistant", script.result);
        run.artifacts.push(...script.artifacts);
      }
      run.phase += 1;
      if (run.phase >= 3) {
        step.status = "succeeded";
        run.index += 1;
        run.phase = 0;
        this.beginStep();
      } else {
        this.emit();
        this.schedule();
      }
    }

    pause() {
      if (this.run?.status !== "running") return;
      clearTimeout(this.timer);
      this.run.status = "paused";
      this.run.steps[this.run.index].status = "paused";
      this.run.note = "Simulation paused. The next event will wait for you.";
      this.emit();
    }

    resume() {
      if (this.run?.status !== "paused") return;
      this.run.status = "running";
      this.run.steps[this.run.index].status = "running";
      this.run.note = "Scripted demo. No AI calls or repository changes.";
      this.emit();
      this.schedule();
    }

    approve() {
      if (this.run?.status !== "waiting_approval") return;
      this.run.approved = true;
      this.run.status = "running";
      this.message("system", "You approved the simulated file changes for this run.");
      this.beginStep();
    }

    cancel() {
      if (!this.isActive()) return;
      clearTimeout(this.timer);
      this.run.status = "cancelled";
      this.run.note = "Demo cancelled. Completed sessions and artifacts remain available.";
      for (const step of this.run.steps) {
        if (step.status !== "succeeded") step.status = "cancelled";
      }
      this.emit();
    }

    dispose() {
      clearTimeout(this.timer);
    }
  }

  window.StudioDemo = { roles, models, prompts, initialState, DemoEngine };
})();
