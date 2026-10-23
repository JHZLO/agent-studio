import { createHash } from "node:crypto";
import { mkdir, writeFile, rename, rm, chmod, access, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const version = "2.3.0", goVersion = "go1.27.3";
const platform = process.platform, arch = { arm64: "arm64", x64: "amd64" }[process.arch];
if (!["darwin", "linux"].includes(platform) || !arch) throw new Error("k6 setup supports macOS and Linux on arm64 or x64.");
const directory = resolve(import.meta.dirname, "../.local/tools");
const goRoot = join(directory, goVersion), go = join(goRoot, "bin/go");
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}
await mkdir(directory, { recursive: true, mode: 0o700 });
if (!await access(go).then(() => true, () => false)) {
  const releases = JSON.parse(await download("https://go.dev/dl/?mode=json&include=all"));
  const release = releases.find(release => release.version === goVersion);
  const archive = release?.files.find(file => file.os === platform && file.arch === arch && file.kind === "archive");
  if (!archive) throw new Error("The pinned Go security release is unavailable for this platform.");
  const bytes = await download(`https://go.dev/dl/${archive.filename}`);
  if (createHash("sha256").update(bytes).digest("hex") !== archive.sha256) throw new Error("Go checksum mismatch.");
  const path = join(directory, archive.filename), stage = join(directory, "go-stage");
  await writeFile(path, bytes, { mode: 0o600 }); await mkdir(stage, { recursive: true });
  execFileSync("tar", ["-xzf", path, "-C", stage]); await rename(join(stage, "go"), goRoot);
  await writeFile(join(directory, "go-receipt.json"), JSON.stringify({ version: goVersion, source: `https://go.dev/dl/${archive.filename}`, sha256: archive.sha256 }, null, 2));
  await rm(stage, { recursive: true }); await rm(path);
}
// The upstream k6 binary predates Go's October security fixes.
const env = { PATH: `${join(goRoot, "bin")}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, GOPATH: join(directory, "go-cache"), GOCACHE: join(directory, "go-build"), GOBIN: directory, GOTOOLCHAIN: "local", GOENV: "off", GOPROXY: "https://proxy.golang.org", GOSUMDB: "sum.golang.org", GOMAXPROCS: "4" };
console.log(`Building k6 ${version} with ${goVersion}. Module checksums are verified by the Go checksum database.`);
execFileSync(go, ["build", "-mod=readonly", "-trimpath", "-o", join(directory, "k6"), "go.k6.io/k6/v2"], { cwd: resolve(import.meta.dirname, "../toolchains/k6"), env, stdio: "inherit", timeout: 600000 });
await chmod(join(directory, "k6"), 0o700);
await writeFile(join(directory, "k6-receipt.json"), JSON.stringify({ version, goVersion, source: `https://github.com/grafana/k6/tree/v${version}`, module: `go.k6.io/k6/v2@v${version}`, securityOverrides: { "golang.org/x/net": "v0.60.0" }, sha256: createHash("sha256").update(await readFile(join(directory, "k6"))).digest("hex") }, null, 2));
console.log(execFileSync(join(directory, "k6"), ["version"], { encoding: "utf8" }).trim());
