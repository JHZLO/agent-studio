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
2. In **Agent library** or **Flows**, select a connected provider and model for every step. The initial flow includes both Codex and Claude presets; change them if you want to use one provider.
3. Add a project folder. Choose **Local** to use it directly, or **New worktree** to create a Git branch and working directory when the task starts.
4. Attach local skills if needed. Each run freezes its selected skill versions and supporting text files.
5. Describe a task and run the flow. Inspect the plan and QA sheet before approving file changes. Shell commands and external HTTP targets have separate approvals.

API keys are kept in runner memory. Enter them again after a runner restart. Subscription credentials remain in the official CLI's credential store. Disconnecting a connection in Studio does not log the CLI out. Billing modes never switch automatically.

## What works

- Project registration, folder browsing, branch validation, local execution, and real worktree creation.
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

A runner restart requires reconciliation. Studio checks the saved provider thread, turn, account, project path, and recorded evidence. A completed exact turn or saved step boundary can be recovered. Missing, active, or ambiguous turns are not replayed. Review changed files before cancelling an uncertain run and starting a new one.

Native Claude terminal sharing, existing externally owned CLI sessions, and automatic synchronization with the OpenAI Codex desktop app are not supported. Browser QA uses Playwright through the runner.

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

Ctrl+C stops the web server while leaving the runner alive. Cancel a task in the UI, or use `./studio stop` to cancel the active task and stop that workspace's runner. Existing project changes and saved task records are preserved.

See [architecture](docs/architecture.md), [security](docs/security.md), and [open-source sources](THIRD_PARTY_NOTICES.md). The original [prototype](prototype/README.md) remains a separate design reference and simulator.

## License

[MIT](LICENSE). External runtimes and dependencies retain their own licenses and terms.
