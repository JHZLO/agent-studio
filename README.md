# Agent Studio

A local workspace for personal AI agents. Configure each role's instructions, model, skills, and tools. Connect roles in a visual flow, run a task, and inspect its real conversations and evidence.

The web UI, API, and execution runner are separate. The runner owns tasks and persists their state in SQLite, so closing a browser or restarting the web server does not stop a task.

## Start locally

Supported target: macOS and Linux, arm64 or x64. The current end-to-end validation was performed on macOS arm64. Install Git and Node.js 20 or later for the bootstrap command.

```sh
node scripts/bootstrap.mjs
./studio install --frozen-lockfile
./studio setup
./studio build
./studio start
```

Open **http://127.0.0.1:4183/**. Setup installs the pinned Node and pnpm toolchain inside `.local/tools`, prepares native SQLite and terminal modules, builds k6 with a patched Go compiler, and installs Playwright Chromium. The first setup needs network access. It does not replace global Node, Codex, or Claude Code installations.

1. In **Connections**, check your existing Codex or Claude Code subscription login, or enter a provider API key. The **Sign in** action opens the official CLI sign-in flow.
2. In **Agent library**, open **Edit agent** to select a connection, model, and permission level. Flows reuse these saved agents. The initial flow includes both Codex and Claude presets; change them if you want to use one provider.
3. Add a project folder. Choose **Local** to use it directly, or **New worktree** to create a Git branch and working directory when the task starts.
4. Attach local skills if needed. Each run freezes its selected skill versions and supporting text files.
5. Describe a task and run the flow. The default permission level requests file-write approval according to workspace settings, then asks separately for shell commands and external HTTP targets.

API keys are kept in runner memory. Enter them again after a runner restart. Subscription credentials remain in the official CLI's credential store. Disconnecting a connection in Studio does not log the CLI out. Billing modes never switch automatically.

## Display language

Choose **Defaults > Display language** to switch between English and Korean. The choice is saved in this workspace's local SQLite database and survives reloads and workspace resets. Existing workspaces default to English.

Menus, settings, task controls, status labels, dates, and counts follow the selected language. Project names, agent names, instructions, skill content, conversations, and artifacts retain their original text. Provider diagnostics and terminal output remain as reported by the runtime. Changing the UI language does not change agent instructions or response language.

## Concurrent tasks

Choose **Defaults > Concurrent tasks** to set a workspace limit from 1 to 8. Existing workspaces start at 1. The home screen shows the active count, and **Tasks** lets you open and control each task independently. Approvals, reviews, cancellation, provider sessions, and terminal control belong to the selected task.

Use separate project folders or **New worktree** for tasks that run together. Studio rejects identical or overlapping execution folders, including symlinks. Each new worktree has its own folder and branch. Paused tasks, pending approvals, human reviews, and tasks awaiting recovery still occupy a slot. Lowering the limit does not stop existing tasks; it prevents new starts until a slot is available. Provider account limits and machine resources remain shared.

## Agent execution settings

Open **Agent library > Edit agent**. Changes apply to future runs. Active runs keep their saved settings, available under **Handoff**.

| Permission level | Behavior |
| --- | --- |
| Ask for approval | Uses the workspace file-write approval setting. Each shell command and external HTTP target requests approval. |
| Read only | Allows selected file-reading and artifact tools. Blocks writes, shell commands, HTTP calls, and browser actions. |
| Project automation | Pre-approves selected file-write tools and sandboxed shell commands, including command network access. External HTTP tool targets still request approval. |
| Bypass permissions | Skips approval prompts. Enabled file tools can access paths outside the project, including hidden and secret files. Shell commands run without a sandbox as your OS user. HTTP and browser tools can access external targets. |

Tool checkboxes continue to limit which tools each agent can call. Read only temporarily disables action tools without losing their selections. Project automation retains project file boundaries and the Codex shell sandbox. Bypass permissions applies only to the selected agent and takes effect on the next run; it does not change existing runs or grant approval to other agents. An enabled Shell tool in bypass mode has your OS user's file and network access even if the Write files tool is disabled. Load tests remain limited to loopback targets and their existing load limits.

Codex agents also have **Fast mode**: **Default** follows local Codex settings, **On** requests faster processing, and **Off** explicitly selects standard speed. Studio checks runtime model support before inference and records the selected session tier. Unsupported requests fail with an explanation. Fast mode consumes more subscription usage or incurs higher API pricing; see [OpenAI's speed guide](https://learn.chatgpt.com/docs/agent-configuration/speed). Claude agents do not show this Codex setting.

## Human reviews and revision loops

Open **Flows** and select a step. **After this step** controls when a person reviews its outputs: continue automatically, review every completion, or review when issues remain. Enable **Lock reviewed outputs** to approve the exact output versions. These rules belong to the flow, while prompts, models, skills, and tool permissions stay in **Agent library**. Active tasks keep the flow rules saved at their start.

**Suggested rules** adds a locked Planner review, a Coder / Reviewer loop with up to three automatic revisions, and a final human review. Review the proposed settings before applying them. Existing flows remain automatic until you save rules.

When a task needs review, open **Review outputs**. Read the plan and QA sheet, request changes with feedback, or choose **Lock only** to approve and remain paused. **Lock and continue** starts the next step. Later drafts can be compared with earlier drafts, and **Attempts** retains previous conversations and outputs. Human review does not grant file, shell, or network permissions.

To plan with the agent before coding, set the Planner step to **Review before continuing**, enable **Lock reviewed outputs**, and return revisions to the Planner. Its review panel accepts questions and changes; each submission produces a new draft while Coder stays queued. **Lock only** keeps Coder waiting until you resume. Existing flows retain their saved rules, so check the selected flow before starting. Completed runs retain their original snapshots.

Attach the relevant architecture skills to both Planner and Coder when the plan must follow a specific codebase. Ask Planner to specify the package layout, responsibilities, transaction boundaries, and test criteria, then inspect those choices before locking. Skill instructions guide implementation; they do not replace code review or test evidence.

Under **Automatic revisions**, choose an earlier step and a limit from 1 to 10. A `revise` result reruns that interval in fresh sessions before the human checkpoint. The limit counts extra attempts after the first pass through the interval. At the limit, the task either requests human feedback or stops. Human feedback authorizes one more attempt without resetting the automatic limit. Loop ranges cannot overlap. Execution errors stop the task instead of consuming revision attempts.

Changes to an approved plan require another human review. Approval checks the reviewed output versions and project fingerprint; changed files require a fresh revision. Pending human reviews survive a runner restart. Superseded outputs remain in history and are not passed forward as current evidence.

## What works

- Project registration, folder browsing, branch validation, local execution, and real worktree creation.
- Selective import of local Codex and Claude Code project folders, with deduplication and access to previously imported conversation snapshots.
- Multiple flows with create, rename, duplicate, archive, restore, node ordering, port connection previews, zoom, and JSON export.
- Six role presets with editable prompts, provider, model, tool permissions, and local skill bindings.
- A local skill catalog with search, source folders, version checks, frozen snapshots, and previous-run inspection.
- Real execution, approval, pause at a step boundary, resume, cancel, history, and persisted settings.
- Separate role conversations, tool receipts, bounded handoffs, provider token usage when available, and downloadable outputs.
- Real API requests, bounded k6 tests, Playwright browser actions, HTTP status capture, accessibility observations, and screenshots.
- Native Codex terminals attached to the same app-server and thread. Automatic execution pauses while the terminal controls the session.

The default roles are Planner, Coder, Reviewer, Backend QA, Frontend QA, and Documenter. Each step opens a fresh provider session. A completed agent report is distinct from tool evidence; the UI labels both. A blocked or invalid report never becomes a successful step.

## Sessions and recovery

Pause the task and wait for its current step to finish. Open **Terminal** on a started Codex session. Closing this view keeps its PTY alive. Use **Return control to Studio** before resuming automatic steps. An external terminal can attach to the same PTY:

```sh
./studio terminal RUN_ID
```

A runner restart preserves a pending human review or a paused Studio step boundary. Interrupted execution requires reconciliation: Studio checks the saved provider thread, turn, account, project path, and recorded evidence. A completed exact turn or saved step boundary can be recovered. Missing, active, or ambiguous turns are not replayed. Review changed files before cancelling an uncertain run and starting a new one.

Native Claude terminal sharing, control of externally owned CLI sessions, and automatic synchronization with the OpenAI Codex desktop app are not supported. Browser QA uses Playwright through the runner.

### Import existing local projects

Click the import icon immediately to the left of **+** beside **Projects** in the sidebar. Search by project name or folder path, filter by Codex or Claude Code, and select up to 100 projects. The list shows one row per folder and excludes unavailable folders. Projects already in Studio are marked and cannot be selected again.

Studio discovers folders from Codex's local catalog and Claude Code's local history, then registers the selected folders in its workspace. Git worktrees are grouped under their original working folder using their shared Git metadata. Separate repositories with the same name stay separate. Conversation history stays in the source app. Importing does not start a model, resume a session, or change project files. Existing project settings are preserved.

Previously imported conversation snapshots remain accessible from **Imported sessions**, which appears when saved snapshots exist. Local storage formats can change with provider updates; discovery reports read failures instead of inventing missing projects.

## Development and checks

```sh
./studio check
./studio build
./studio test
./studio audit --audit-level=low
./studio audit:k6
```

Tests use temporary projects and local HTTP targets. The normal test suite does not call a model. Optional probes under `scripts/` use an existing Codex subscription and must be run deliberately. See [validation](docs/validation.md) for evidence and limits.

Set `AGENT_STUDIO_PORT` to choose a port, and `AGENT_STUDIO_DATA_DIR` to isolate a workspace. Both must be set consistently for the server, runner, terminal command, and stop command. The default state directory is `.local/data`; generated worktrees, screenshots, skill snapshots, and logs stay local and are ignored by Git.

Ctrl+C stops the web server while leaving the runner alive. Cancel a task in the UI, or use `./studio stop` to cancel all active tasks and stop that workspace's runner. Existing project changes and saved task records are preserved.

See [architecture](docs/architecture.md), [security](docs/security.md), and [open-source sources](THIRD_PARTY_NOTICES.md). The original [prototype](prototype/README.md) remains a separate design reference and simulator.

## License

[MIT](LICENSE). External runtimes and dependencies retain their own licenses and terms.
