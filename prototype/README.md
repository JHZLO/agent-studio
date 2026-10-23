# Interactive prototype

A local prototype of Agent Studio. It uses plain HTML, CSS, and JavaScript, with a Python service for local skills and project inspection. There are no third-party runtime dependencies.

## Open it

For local skills and projects, run from the repository root with Python 3.10 or later. Git is required for branch inspection:

```bash
python3 prototype/local_server.py
```

Visit `http://127.0.0.1:4182/`. The server binds only to `127.0.0.1`, serves an allowlist of UI files, and accepts same-origin JSON requests for skill discovery, snapshots, folder browsing, and Git metadata. It does not run AI agents or skill scripts. Use `--port` to select another loopback port.

To make a single offline file:

```bash
python3 prototype/export.py
```

Open the generated `dist/agent-studio-mockup.html`. It uses three original sample skills and makes no network requests. Export never embeds discovered local skills, paths, or snapshots. Opening `index.html` directly also uses the sample catalog.

## Try the flow

1. Add a local project, then open **New task**. Select the project and flow, enter a task, and select **Run preview**. The offline export can run a sample task without a local project.
2. The task view keeps the next action at the top. Select an agent on the left to inspect its conversation, tool activity, or handoff.
3. Open the plan and QA sheet in **Outputs**, beside the conversation. Approve the simulated changes to continue. Pause, resume, or cancel the task at any time while it is running.
4. Inspect the sample diff, review, test reports, and final handoff in the same output panel. Each file can be downloaded. **Tasks** keeps previous runs available.
5. Open **Flows** to configure the next task. Select an agent to reveal its settings; close the settings to use the full canvas.
6. Change step order with the inspector's arrow buttons, or connect an output port to a later input port. A connection previews the complete proposed order before you apply it. The workflow remains a single chain; backward links are rejected.
7. Use **Agent library** to create or edit presets. **Connections** lets you explore API key and subscription setup with demo accounts. No real keys or credentials are accepted.
8. Open **Skill library**. Search local skills, inspect their instructions, and select **Attach** to choose an agent. Save the preset in the inspector. You can also use **Choose skills** directly in the inspector.
9. Start a demo task with attached skills. Its **Handoff** tab links to the skill versions saved for that run. Editing a preset does not change the active run.

Presets and up to ten recent runs are saved in this browser's local storage when available. An interrupted simulation reopens paused. The running workflow keeps a snapshot of its presets, so edits apply to the next run. Reset replaces demo presets, flows, and history. Registered projects and skill source folders remain.

## Projects and execution settings

- Use **Projects +** or **Select project** to register an existing local folder with a project name. This creates a Studio project record, not a new directory or Git repository.
- Enter an absolute path or use **Choose folder**. The browser shows immediate, visible subfolders; it does not upload project contents.
- Open **Local environment settings** beside the project selector. Choose local execution or a new worktree, then select a base branch and an optional new branch name.
- The server reads actual Git branches and validates settings. Non-Git folders and repositories without commits support local mode only. Missing base branches and invalid or existing new branch names are rejected.
- Worktree creation, branch checkout, environment setup, and AI execution are not implemented. Settings are saved for each project and copied into each simulated task. **View task environment** shows that saved copy.
- Project names, paths, flow definitions, and execution settings are stored in this browser. The offline export contains no local project data and cannot inspect folders.

## Multiple flows

- **Flows** shows a tab for each saved flow. Create an empty flow with **New flow**, then add agents from the library.
- **Manage flows** supports renaming, duplication, archiving, and restoration. Each flow stores its own ordered list of agents. A duplicate gets a separate list.
- Agent presets are shared through the library. Editing a preset updates future runs of every flow that uses it. Use a separate agent preset when a flow needs different instructions or permissions.
- Select a flow in the task composer before starting. Each task captures its flow name, order, agent presets, project, and execution settings. Later edits do not alter past or active task snapshots.
- Existing single-flow browser data migrates to the initial **Feature delivery** flow while preserving its agents and order.
- At least one flow stays active. Archive is reversible and does not remove task history. Execution remains a sequential chain with one active simulated task at a time.

## Local skill library

- The default sources are `~/.agents/skills`, `~/.codex/skills`, and `~/.claude/skills`. Use **Manage sources** to edit them, one path per line. A source can be a single skill folder or a folder containing skill folders. Source selections are saved in this browser.
- A canonical filesystem path identifies a skill. Symlinks pointing to the same folder are merged. Independent copies with the same name remain separate and show their sources.
- Discovery reads common `name` and `description` string fields from SKILL.md frontmatter. This is a conservative parser, not a complete YAML implementation.
- Tool hints are text matches, not verified requirements or a compatibility guarantee. Adding a browser skill does not provide browser automation. Real runtime capability checks are not implemented.
- Presets hold skill IDs and content versions. Before a demo starts, the server resolves each binding and saves the selected content under `.local/skill-snapshots/`. This directory is Git-ignored. Snapshot content stays on this computer and is not added to the demo conversation prompt.
- If a bound skill changes or disappears, a new run stops with an actionable message. Refresh the library, review the source, choose **Use latest version** in the inspector, and save the preset. Earlier run snapshots remain available after a server restart.
- A snapshot includes SKILL.md and supported UTF-8 text files under `references/`, `scripts/`, `assets/`, and `agents/`. Relative paths are preserved. Each file is limited to 256 KB and each skill to 1 MB. Oversized skills produce a source warning.
- Environment directories, hidden files, credential-like filenames, binaries, and symlinks escaping the skill folder are not included. This is an allowlist, not a secret-detection tool. Only register folders that you intend to read locally.
- Supporting scripts are stored as text and never executed. Assets requiring excluded files or external services need separate setup in the future runtime.
- Team export includes binding names, IDs, and versions, without source paths or skill content. It is a design export; portable import and source remapping are not implemented.
- Reset removes demo presets, flows, and history, while retaining projects and registered source folders. Saved snapshot files remain on disk for inspection.

## Check the prototype

```bash
python3 -m unittest discover -s prototype -p 'test_*.py' -v
node --check prototype/app.js
node --check prototype/skills.js
node --check prototype/demo-engine.js
node --test prototype/test_demo_engine.cjs
python3 prototype/export.py
```

The tests cover path boundaries, source identity, exclusions, immutable snapshots, read-only Git inspection, branch validation, request origins, single-flow migration, and task configuration snapshots.

## Boundaries

- AI responses, account checks, repository changes, and QA outputs are scripted fixtures.
- Model names are sample choices, not a live capability list.
- Custom prompts and briefs are saved, but do not generate new AI output.
- No external requests, real login, paid calls, or browser automation occur during a demo run. The local service reads selected skill folders, directory names, and Git metadata, and writes skill snapshot files only.
- The simulation stops when the page closes. The production engine will run independently of the UI.
- Only the demo's file-write gate is simulated. The real runtime must enforce all tool permissions.
- `app.js` owns UI interactions. `skills.js` calls the local skill service or uses sample fixtures. `local_server.py` owns discovery, snapshot storage, and read-only folder and Git inspection. `demo-engine.js` owns simulation state and never accesses the DOM. These remain separate from the future production engine.

The prototype is original demonstration code. It does not embed the upstream agent products or their servers.
