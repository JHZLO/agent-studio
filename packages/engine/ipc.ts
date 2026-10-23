import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { runnerSocket } from "./paths.ts";
export function rpc(method: string, input: unknown = {}, commandId: string = randomUUID(), path = runnerSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, input, commandId });
    const call = request({ socketPath: path, method: "POST", path: "/rpc", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: 120000 }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; if (text.length > 32 * 1024 * 1024) call.destroy(new Error("Runner response too large.")); });
      response.on("end", () => {
        try { const data = JSON.parse(text); if (response.statusCode !== 200) reject(new Error(data.error || "Runner request failed.")); else resolve(data); }
        catch (error) { reject(error); }
      });
    });
    call.on("error", reject); call.on("timeout", () => call.destroy(new Error("Runner request timed out. Reconnect to check the result.")));
    call.end(body);
  });
}
