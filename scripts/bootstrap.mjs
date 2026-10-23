import { createHash } from "node:crypto";
import { mkdir, writeFile, rename, rm, access, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const directory = resolve(root, ".local/tools");
const nodeVersion = "24.22.1";
const pnpmVersion = "12.15.0";
const platform = process.platform;
const arch = process.arch;
if (!["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(arch)) {
  throw new Error("This launcher supports macOS and Linux on arm64 or x64.");
}
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}
await mkdir(directory, { recursive: true, mode: 0o700 });
const nodeName = `node-v${nodeVersion}-${platform}-${arch}`;
const nodePath = resolve(directory, nodeName, "bin/node");
if (!await exists(nodePath)) {
  const base = `https://nodejs.org/dist/v${nodeVersion}/`;
  const sums = (await download(base + "SHASUMS256.txt")).toString();
  const filename = `${nodeName}.tar.gz`;
  const expected = sums.split("\n").find(line => line.endsWith(`  ${filename}`))?.split(/\s+/)[0];
  const data = await download(base + filename);
  if (!expected || createHash("sha256").update(data).digest("hex") !== expected) throw new Error("Node checksum mismatch.");
  const archive = resolve(directory, filename);
  await writeFile(archive, data, { mode: 0o600 });
  execFileSync("tar", ["-xzf", archive, "-C", directory]);
  await rm(archive);
  await writeFile(resolve(directory, "node-receipt.json"), JSON.stringify({ version: nodeVersion, source: base + filename, sha256: expected }, null, 2));
}
const pnpmPath = resolve(directory, "pnpm");
if (!await exists(pnpmPath)) {
  const packageName = `@pnpm/exe.${platform}-${arch}`;
  const metadata = JSON.parse(await download(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/${pnpmVersion}`));
  const data = await download(metadata.dist.tarball);
  const [algorithm, expected] = metadata.dist.integrity.split("-", 2);
  if (createHash(algorithm).update(data).digest("base64") !== expected) throw new Error("pnpm integrity mismatch.");
  const archive = resolve(directory, "pnpm.tgz");
  const stage = resolve(directory, "pnpm-stage");
  await writeFile(archive, data, { mode: 0o600 });
  await mkdir(stage, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", stage]);
  const members = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
  const binary = members.find(path => path.endsWith("/pnpm"));
  if (!binary || binary.includes("..")) throw new Error("Unexpected pnpm package layout.");
  await rename(resolve(stage, binary), pnpmPath);
  await chmod(pnpmPath, 0o700);
  await rm(stage, { recursive: true });
  await rm(archive);
  await writeFile(resolve(directory, "pnpm-receipt.json"), JSON.stringify({ version: pnpmVersion, package: packageName, integrity: metadata.dist.integrity }, null, 2));
}
console.log(`Ready: Node ${execFileSync(nodePath, ["--version"], { encoding: "utf8" }).trim()}, pnpm ${execFileSync(pnpmPath, ["--version"], { encoding: "utf8" }).trim()}`);
console.log("Run ./studio install --frozen-lockfile, then ./studio setup, ./studio build, and ./studio start.");
