# Interactive prototype

A browser-only mockup of Agent Studio. It uses plain HTML, CSS, and JavaScript with no third-party runtime dependencies.

## Open it

Open `index.html` in a modern browser, or serve this directory from the repository root:

```bash
python3 -m http.server 4177 --bind 127.0.0.1 --directory prototype
```

Visit `http://127.0.0.1:4177/`. This server only serves the prototype files. It is not the planned execution engine.

To make a single offline file:

```bash
python3 prototype/export.py
```

Open the generated `dist/agent-studio-mockup.html`. No package installation or server is required for that file.

## Try the flow

1. Select an agent on the canvas. Edit its instructions, connection, model, skills, or tool permissions, then save the preset.
2. Reorder steps with the inspector's arrow buttons. To reconnect steps, choose an output port and then a later step's input port. The workflow remains a single chain. Backward links are rejected.
3. Create a custom agent from the library, or remove and restore a workflow step.
4. Open **Connections** to explore API key and subscription setup. No real keys or credentials are accepted.
5. Select **Run demo**. The planner prepares a sample plan and QA sheet. Approve the simulated changes before the first write-enabled step.
6. Pause, resume, or cancel the run. Inspect each agent's conversation, simulated tool calls, and handoff.
7. Open **Artifacts** to read or download the sample plan, QA sheet, diff, review, test reports, and final handoff.

Presets and up to ten recent runs are saved in this browser's local storage when available. An interrupted simulation reopens paused. The running workflow keeps a snapshot of its presets, so edits apply to the next run. Reset only replaces this prototype's data.

## Boundaries

- AI responses, account checks, repository changes, and QA outputs are scripted fixtures.
- Model names are sample choices, not a live capability list.
- Custom prompts and briefs are saved, but do not generate new AI output.
- No external requests, real login, secret storage, filesystem access, paid calls, or browser automation occurs during a demo run.
- The simulation stops when the page closes. The production engine will run independently of the UI.
- Only the demo's file-write gate is simulated. The real runtime must enforce all tool permissions.
- `app.js` owns UI interactions. `demo-engine.js` owns the simulation state and never accesses the DOM. Both are separate from the future production engine.

The prototype is original demonstration code. It does not embed the upstream agent products or their servers.
