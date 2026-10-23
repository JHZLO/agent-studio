import { createInterface } from "node:readline";
import { rpc } from "../../packages/engine/ipc.ts";

const input = createInterface({ input: process.stdin });
const auth = { stepId: process.env.AGENT_STUDIO_STEP_ID, capability: process.env.AGENT_STUDIO_CAPABILITY };
input.on("line", async line => {
  let request;
  try {
    request = JSON.parse(line);
    if (request.id === undefined) return;
    let result;
    if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agent-studio", version: "0.1.0" } };
    else if (request.method === "tools/list") result = { tools: await rpc("mcp", { ...auth, action: "list" }) };
    else if (request.method === "tools/call") {
      const value = await rpc("mcp", { ...auth, action: "call", name: request.params.name, arguments: request.params.arguments ?? {} });
      result = { content: [{ type: "text", text: JSON.stringify(value) }], isError: !value.success };
    } else if (request.method === "ping") result = {};
    else throw new Error("Unsupported MCP method.");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  } catch (error) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32603, message: (error as Error).message } }) + "\n"); }
});
