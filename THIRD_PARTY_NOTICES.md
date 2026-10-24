# Open-source sources

Agent Studio's original source is MIT licensed. Dependencies and external programs retain their own licenses. Package archives and installed tools include their upstream notices.

| Project | Use | License / source |
| --- | --- | --- |
| LangGraph JS | Step execution and SQLite checkpoints | [MIT](https://github.com/langchain-ai/langgraphjs/blob/main/LICENSE) |
| OpenAI Codex | Official app-server, login, sandbox, native terminal | [Apache-2.0](https://github.com/openai/codex/blob/rust-v0.163.0/LICENSE) |
| Fastify, better-sqlite3, Vite | Local service, persistence, UI build | MIT, see installed package notices |
| node-pty, xterm.js | Independent terminal process and web terminal | MIT, see installed package notices |
| Playwright | Real browser QA and screenshots | [Apache-2.0](https://github.com/microsoft/playwright/blob/main/LICENSE) |
| Marked 18.1.1 | Markdown document rendering | [MIT](https://github.com/markedjs/marked/blob/v18.1.1/LICENSE) |
| DOMPurify 3.4.17 | Sanitize rendered documents before display | [Apache-2.0 or MPL-2.0](https://github.com/cure53/DOMPurify/blob/3.4.17/LICENSE) |
| Mermaid 12.2.0 | Render local plan diagrams as isolated SVG images | [MIT](https://github.com/mermaid-js/mermaid/blob/mermaid%4012.2.0/LICENSE) |
| Grafana k6 | Separate local load-test executable, built during setup | [AGPL-3.0](https://github.com/grafana/k6/blob/v2.3.0/LICENSE.md), [exact source](https://github.com/grafana/k6/tree/v2.3.0) |
| Claude Code | Unmodified official runtime installed separately by setup | [Upstream distribution and terms](https://github.com/anthropics/claude-code) |

The following projects informed the design. Their application source was not copied into this implementation:

- [Happier](https://github.com/happier-dev/happier/tree/98dab9837ab4f918cb9be86095eca8ebe6136c25), MIT: shared Codex server and event translation.
- [Paperclip](https://github.com/paperclipai/paperclip/tree/2cd6eb27c762cfdd6da7ab0b8da4b6a9eec0601e), MIT: separate task/provider identities and recovery checks.
- [Agent Orchestrator](https://github.com/OrchestratorInc/agent-orchestrator/tree/7d2165ef5c30c6c4420f049e02daff6853c21e74), Apache-2.0: terminal process lifetime independent of a view.
- [Hycli](https://github.com/Hybirdss/Hycli/tree/192d71329720f553b382a366573ef06f4e156bb7), Apache-2.0: official authentication and process reuse. Studio uses persistent role threads for inspection rather than ephemeral inference threads.

Subscription tokens are not extracted or turned into a model API. Account access remains subject to the official provider runtime and account terms.
