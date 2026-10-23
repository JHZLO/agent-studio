# Validation record

Checked on 2026-10-23, macOS arm64. Implementation, automated checks, and live provider execution are listed separately. The original prototype remains available as the visual baseline.

## Local checks

- Strict TypeScript and the production Vite build pass.
- The 18-test model-free suite covers persistence, command deduplication, uncertain outcomes, concurrent starts, history retrieval, skill snapshots, project validation, worktree isolation and source instructions, file permissions, recovery boundaries, native Codex process ownership, API security, real Chromium evidence, and bounded k6 execution.
- npm audit reports zero known vulnerabilities for the installed dependency graph.
- The rebuilt k6 binary has zero affected symbols and imported packages. One unused module advisory remains. See [security details](security.md).
- GitHub Actions runs setup, type checks, build, tests, and both dependency audits. A local pass is not a claim that a remote workflow has passed.

## Live provider paths

| Connection | Observed result | Limit |
| --- | --- | --- |
| Codex subscription | Six distinct role sessions completed through the official app-server. Actual files, shell commands, API calls, Chromium actions, and documentation outputs were recorded. | Uses the existing official CLI login. |
| Claude Code subscription | A read-only Planner completed with six Studio tool receipts, a plan, a QA sheet, and an evidence artifact. The runtime reported `claude-sonnet-5-5`. | This checks one role and MCP integration, not a six-role Claude workflow. |
| Codex API key | Implemented model discovery, memory-only key handling, and separate ephemeral app-server authentication. An isolation probe confirmed that an API login does not replace the subscription login. | A real API-key inference was not run because no test API key was supplied. |
| Claude API key | Implemented model discovery and an isolated API-key child environment. | A real API-key connection and inference were not run because no test API key was supplied. |

The Claude probe found and fixed a schema compatibility issue: the official CLI needs a draft-7 output schema rather than the generator's default draft-2020-12 schema. Its subsequent real MCP run completed successfully.

## End-to-end task

The Codex fixture started from a small unimplemented newsletter app in a separate Git worktree. Planner produced the plan and QA sheet, Coder changed the source, Reviewer inspected the diff, Backend QA called the actual API, Frontend QA used Chromium, and Documenter updated the README and handoff. The run produced six provider threads and 15 artifacts.

The supplied Node test passed. The four planned API cases and four browser cases produced recorded results. Backend QA also found two additional invalid-domain inputs that the generated implementation accepted. Those findings remain in the review, API report, and final documentation. Workflow completion means the six roles finished their work; it does not mean every discovered application defect was fixed.

The k6 tool was executed separately against a local HTTP fixture. Its excessive-load rejection was tested. No external load test or production target was used.

## Sessions and recovery

- A second client and native Codex TUI read the same app-server thread.
- The web API was restarted during a live workflow. The same runner continued the task.
- A workflow paused after its current step. Closing and reopening the terminal view retained the same PTY.
- A message entered through the embedded native TUI received a real response, which also appeared in Studio's conversation view. Control returned to Studio without creating another provider thread.
- Cancelling from the UI preserved completed outputs and stopped the remaining queued step.
- Recovery fault fixtures reused real completed provider history. The exact completed turn recovered without resubmitting inference. Missing turns, changed projects, changed accounts, and changed files at a saved step boundary were rejected.

The recovery fault tests do not claim exhaustive process-crash coverage. Interrupted Claude turns and uncertain terminal ownership stop for inspection instead of automatic replay.

## UI acceptance coverage

The original cream background, ink borders, six role colors, typography, characters, responsive rules, and reduced-motion handling are retained. Product additions use the existing session and output panels.

The actual app was inspected at 375 px and 900 px. Its page width stayed within the viewport, and mobile navigation, forms, the flow editor, and output panels remained usable. The desktop layout was also inspected at the browser's normal size. Screen-reader speech and every operating-system/browser combination were not tested.

| Area | Verification |
| --- | --- |
| Navigation and home | Page navigation, project and flow selection, actual task start, mobile navigation, and sidebar controls |
| Projects and environments | Folder browsing, project registration, local/worktree configuration; automated invalid-path, branch, unborn-repository, and worktree tests |
| Flows | Creation, duplication, archive/restore, port reorder preview and apply, node editing, canvas zoom/fit, and JSON download |
| Agents and skills | Preset edits, provider/model selection, real skill search, attachment, source scan and versioned snapshots; snapshot mutation and path tests |
| Connections | Existing Codex/Claude login checks, soft disconnect/reconnect, billing-mode selection, missing-key errors, and the live paths above |
| Run controls and sessions | Start, approvals, safe pause, resume, cancel, role selection, conversation, tools, handoff, terminal, and retained history |
| Outputs | Real plan, QA sheet, diff, review, API report, browser report, PNG preview/download, and documentation handoff |
| Defaults and auxiliary actions | Persisted settings, explicit approval policy, frozen active-run settings, guide, export, reset scope, and error states |

The normal test suite does not consume model quota. `scripts/probe-codex.ts`, `scripts/smoke-codex.ts`, `scripts/probe-controls.ts`, and `scripts/probe-recovery.ts` are deliberate local diagnostics. The smoke test expects an isolated server on port 4184 and uses port 4196 for its fixture. Live logs and provider identifiers stay under ignored `.local/`.

## Human checkpoints and revision loops

Checked on 2026-10-24, macOS arm64. The feature-only source tree passed strict TypeScript checks, the production build, and all 76 automated tests. Separate pending loading-feedback work was excluded from that tree.

- Engine tests cover per-flow rule validation, frozen active-run rules, locked plan versions, stale approval rejection, fresh revision sessions, retained attempts, loop limits, scope changes, and restart recovery. Human approval leaves tool permissions intact.
- A Chromium test saves independent flow rules, requests a plan revision, compares drafts, reloads a pending review, locks without continuing, reaches a loop limit, submits feedback, and approves the final result. It also verifies live form preservation, edits for future runs, response ordering, and the review panel at a 390 px viewport.
- An actual Codex subscription run in an isolated project completed Planner, Coder, and Reviewer. Planner stopped before Coder started. Lock only kept the run paused, resume produced the requested file, and the final human approval completed the task. Automatic revision branches use model-free fixtures, not repeated live inference.
- The local app on port 4184 displayed the new flow controls after its runner was refreshed. Existing settings were preserved and the Codex subscription connection was restored.

The live run uses the official Codex CLI login. These additions have not received a live Claude run or cross-platform validation. Local test results do not establish remote CI status.
