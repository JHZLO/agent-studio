import { mkdir, lstat, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";
import { hash } from "./store.ts";
import { root } from "./codex.ts";
export const dataDir = resolve(process.env.AGENT_STUDIO_DATA_DIR || join(root, ".local/data"));
export const socketDir = `/tmp/agent-studio-${process.getuid?.() ?? "local"}-${hash(dataDir).slice(0, 12)}`;
export const runnerSocket = join(socketDir, "runner.sock");
export async function privateDirectories() {
  for (const path of [dataDir, socketDir]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error("Runtime directory has an unexpected owner or type.");
    await chmod(path, 0o700);
  }
}
