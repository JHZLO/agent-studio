# Security and dependencies

This is a single-user local tool. It binds to `127.0.0.1`, not the LAN. Do not expose it through a tunnel or reverse proxy without a separate authentication design.

## Fixed versions

The implementation baseline was checked on 2026-10-23.

| Component | Version |
| --- | --- |
| Node.js | 24.22.1 |
| pnpm | 12.15.0 |
| Codex CLI | 0.163.0 |
| Claude Code | 2.1.308 |
| SQLite binding | better-sqlite3 12.11.1 |
| Fastify | 5.12.7 |
| Vite | 8.3.5 |
| Playwright | 1.64.1 |
| k6 | 2.3.0, locally rebuilt with Go 1.27.3 |

Node 24.22.1 includes the October security fixes. k6's upstream 2.3.0 binary was built with Go 1.26.8, so setup builds the same k6 source using Go 1.27.3 and `golang.org/x/net` 0.60.0 instead. The x/net override fixes the HTTP/2 advisories reported by the binary scanner. `toolchains/k6/go.mod` and `go.sum` pin the build graph. The Go release includes later security fixes. Sources: [Node release](https://nodejs.org/en/blog/release/v24.22.1), [Go release history](https://go.dev/doc/devel/release), [k6 source](https://github.com/grafana/k6/tree/v2.3.0).

All npm dependencies use exact versions and a committed lockfile. pnpm requires a 24-hour release age, rejects trust downgrades, and disables package lifecycle scripts. `scripts/install-native.mjs` explicitly prepares the selected SQLite, Claude, and PTY components. Bootstrap verifies official Node and Go archive SHA-256 values and pnpm package integrity. Go module downloads use the checksum database.

`pnpm audit` checks known npm advisories. It does not certify bundled CLI binaries, Go modules, every browser vulnerability, or future releases. Review provider release notes and repeat the checks when changing pinned versions.

The 2026-10-23 binary scan of the patched k6 build found zero affected symbols and zero affected imported packages. It also reported one module-only advisory, [GO-2026-5932](https://pkg.go.dev/vuln/GO-2026-5932), for the unmaintained OpenPGP package. That package is not imported or called by this binary. Run `./studio audit:k6` to repeat the scan against the current advisory database.

## Local boundaries

- Exact Host and Origin checks, same-origin JSON requests, an HttpOnly SameSite cookie, and a CSRF nonce protect the local API.
- Private directories and Unix sockets restrict the runner and PTY to the local user.
- API keys stay in runner memory and are redacted from recorded output. Subscription credentials stay with the official CLI.
- Child environments exclude inherited provider keys and tokens. Codex API authentication uses ephemeral storage; it does not replace the subscription login.
- Preset permissions restrict Studio tools. Native provider execution, hooks, external MCP tools, and automatic subagents are disabled for Studio turns.
- Project file tools reject secret paths, escaping paths, and outside symlinks. Selected skill files are read from frozen snapshots.
- Shell execution needs explicit approval for each command and uses the Codex OS sandbox. Shell approval still matters: a permitted command can access resources allowed by that sandbox, including networking. Studio is not a container or a defense against a malicious local user.
- Browser QA uses an isolated context with loopback-only requests. HTTP external targets need approval. QA tools cannot address the configured Studio control port.
- k6 is limited to loopback, at most 5 virtual users and 10 seconds, with redirects disabled. Agent turns and commands have time limits. Completed tasks stop their test servers and browsers.

Project files, prompts, skills, model output, and test evidence can contain private content. State is local plaintext protected by filesystem permissions. Do not publish `.local/` or attach its logs to an issue without reviewing them.
