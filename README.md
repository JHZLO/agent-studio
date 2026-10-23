# Agent Studio

A personal workspace for defining AI agents, connecting them into workflows, and inspecting their work.

**Status:** Repository bootstrap. The application is not implemented yet. The technology stack and upstream components are still under evaluation.

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

Build, run, and test commands will be added when the initial implementation is selected.

## License

[MIT](LICENSE)
