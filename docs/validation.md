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

## Follow-up conversations

Validated on 2026-10-24. The selected agent can receive a message after completion, cancellation, failure, pause, or at a human review checkpoint, provided its provider session is idle. The runner uses the saved agent permissions, skills, model, and provider session. It reserves task capacity and the working folder before accepting the message. Replies do not approve a plan or start later workflow steps. File changes mark earlier output versions as stale.

- Real Codex subscription: completed a sample task, closed its app-server, resumed the same provider thread, answered about the earlier file, and read a second file using a Studio tool.
- Real Claude subscription: completed a sample task through the Studio MCP bridge, resumed the saved CLI session, answered about the earlier file, and used the bridge again to read a second file.
- Both probes retained the provider session ID and workflow position. They used separate temporary projects and did not send messages to existing user tasks.
- Automated coverage checks pending plan reviews, frozen permissions, write evidence, concurrent sends, overlapping folders, reply cancellation, exact-turn recovery, and mismatched provider sessions.
- Browser coverage checks separate agent drafts, newline and send shortcuts, streaming updates, failed sends, reply stopping, safe summary rendering, fullscreen documents, and mobile layout.

The isolated committed source passed type checking, production build, and all 117 tests. Two viewport assertions now wait for the responsive render before measuring bounds. The actual local UI was also inspected with a completed Tester conversation and its report side by side. API-key inference and exhaustive crash recovery were not run for this change.

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

## Concurrent tasks

Checked on 2026-10-24, macOS arm64. The feature source passed strict TypeScript checks, the production build, and 91 automated tests.

- New engine tests cover capacity reservations, overlapping provider turns, independent approvals and cancellation, per-run message persistence and process cleanup, identical/nested/symlink folder rejection, real Git worktree separation, shutdown during preparation, and recovery of every unfinished task. Lowering the limit preserves existing tasks.
- A Chromium test changes and reloads the limit, controls an older active task, observes it through a second browser session and real SSE, preserves the selected task when another task changes, and checks the control at 390 px. Settings retain the existing revision check when another window changes them.
- Two read-only Planner tasks ran through the existing Codex subscription at the same time. Their active provider turns overlapped, their thread IDs and host processes were distinct, and each plan and QA sheet included its own project's marker. Cancelling one task left the other pending review; approving and resuming the other completed it. Sample source files were preserved.

The live check used two separate sample folders and attached the planning and coding-guideline skills as frozen snapshots. It did not run a concurrent Claude workload, API-key inference, or a capacity benchmark. The configurable maximum of eight is a product limit, not a provider throughput guarantee.

## Project access and collaborative planning

Checked on 2026-10-24, macOS arm64. The feature source passed strict TypeScript checks, the production build, and 93 automated tests. The local workspace, including separate pending feedback changes, passed the same checks and 97 tests.

- A real Node child process starts the Claude MCP bridge from an external project folder. A project-local `tsx` package cannot replace Studio's runtime loader. This reproduced the previous module-resolution failure before the fix.
- A successful-looking Claude report is rejected when the Studio MCP connection is absent or failed. The initialization event records whether the tool connection was established.
- The Chromium planning test verifies the question/revision field, a revised draft, reload during review, and locking without starting Coder. Existing review and resume controls retain their behavior. Korean planning guidance is available.
- The user workspace displayed the attached planning and architecture skills and the Planner review rule after reload. Existing models, permissions, project settings, and completed-run snapshots were preserved.
- A live Claude subscription Planner inspected an external Kotlin sample, produced a draft, accepted revision feedback, and returned a second draft. Coder stayed queued and source files remained unchanged through both drafts. Lock only paused the run; resume then started the Codex subscription Coder. Final approval completed the isolated task.
- Coder refactored the copied sample into controller, contracts, domain facade, service, repository, entity, and DTO packages. Source inspection confirmed one repository per service and a facade-owned transaction. Gradle ran the 16 existing tests and seven additional architecture/facade tests successfully. The original test assertions and build configuration were preserved.

The sample used H2 and existing local CLI subscriptions. It does not establish production-database locking behavior or general code quality across future tasks. The original project was not modified. Private architecture references, skill bindings, provider identifiers, and sample artifacts remain outside the public repository. Code commit `64a7cb3` also passed the GitHub Actions Check workflow.
