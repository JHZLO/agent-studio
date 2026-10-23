# Agent Studio

A personal workspace for defining AI agents, connecting them into workflows, and inspecting their work.

**Status:** An interactive local prototype supports local project registration, worktree settings, multiple saved flows, local skill discovery, and per-agent skill bindings. AI execution, worktree creation, and account connections are simulated.

## Try the prototype

Run with Python 3.10 or later:

```bash
python3 prototype/local_server.py
```

Visit `http://127.0.0.1:4182/`. Register a local folder, choose a flow, enter a task, and select **Run preview**. Use **Flows** to create, duplicate, rename, or archive workflows. Use **Skill library** to discover local `SKILL.md` files and attach them to an agent. No API keys or package installation are required. Git is required for branch inspection.

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

The product will start as a local web application with separate UI, local API, and execution engine boundaries. The preview server reads selected skill folders, directory names, and Git metadata, and stores local skill snapshots. It is not the production AI runtime.

## License

[MIT](LICENSE)
