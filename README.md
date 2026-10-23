# Agent Studio

A personal workspace for defining AI agents, connecting them into workflows, and inspecting their work.

**Status:** An interactive, browser-only prototype is available. The production execution engine and real AI connections are not implemented yet.

## Try the prototype

Open [`prototype/index.html`](prototype/index.html) in a modern browser, or run:

```bash
python3 -m http.server 4177 --bind 127.0.0.1 --directory prototype
```

Visit `http://127.0.0.1:4177/`. Edit agent presets, connect a workflow, run a scripted demo, approve changes, and inspect sessions and artifacts. No API keys or package installation are required.

See the [prototype guide](prototype/README.md) for the offline export command and simulation boundaries.

## Planned capabilities

- Save reusable agent presets with a prompt, model, runtime, skills, and tool permissions.
- Connect agents in a visual workflow and start a task from that workflow.
- Inspect each agent's conversation, tool activity, progress, and outputs.
- Keep agent definitions separate from execution sessions.
- Carry verified outputs and handoff notes between sessions to control context growth.
- Define QA cases before testing and link results to the code that was tested.

## Planned agent roles

| Role | Responsibility |
| --- | --- |
| Planner | Turn a request into a plan, including architecture and data modeling when needed. |
| Coder | Implement the plan using the selected skills and project rules. |
| Reviewer | Review code changes and pull requests. |
| Backend tester | Check API edge cases and run bounded load tests. |
| Frontend tester | Execute a QA sheet through browser or computer use tools. |
| Documenter | Create and update documentation from verified changes. |

## Development

The product will start as a local web application with separate UI, local API, and execution engine boundaries. The browser prototype is a design artifact, not the production runtime.

## License

[MIT](LICENSE)
