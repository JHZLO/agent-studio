import { readdir, readFile, stat, realpath, lstat, mkdir, writeFile } from "node:fs/promises";
import { join, basename, extname, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { contained, expand, folder } from "./projects.ts";
import { hash } from "./store.ts";
import { bindingSchema } from "../contracts/index.ts";
import type { Binding } from "../contracts/index.ts";

const textTypes = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".py", ".js", ".mjs", ".ts", ".sh", ".http", ".csv", ".html", ".css", ".svg"]);
type File = { path: string; content: string; hash: string };
type Bundle = { version: string; files: File[]; omitted: number };
type Entry = { id: string; name: string; description: string; version: string; sources: string[]; path: string; requirements: string[]; fileCount: number; omitted: number };
type Source = { label: string; path: string; plugin?: { name: string; identity: string; root: string } };
type CatalogError = { source: string; name?: string; message: string };
const pluginCaches = [
  { label: "Codex", path: join(process.env.CODEX_HOME || join(homedir(), ".codex"), "plugins/cache") },
  { label: "Claude Code", path: join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "plugins/cache") },
];

async function directories(path: string) {
  const entries = await readdir(path, { withFileTypes: true });
  if (entries.length > 1000) throw new Error("Use a skills folder with fewer than 1,000 entries.");
  return entries.filter(entry => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink())).map(entry => entry.name);
}

async function pluginSources(caches: typeof pluginCaches) {
  const sources: Source[] = [], errors: CatalogError[] = [];
  for (const cache of caches) {
    try {
      const cacheRoot = await realpath(cache.path);
      const registry = cache.label === "Claude Code" ? await readFile(join(cache.path, "../installed_plugins.json"), "utf8").then(text => z.object({ plugins: z.record(z.string(), z.array(z.object({ installPath: z.string(), scope: z.string().optional() }))) }).parse(JSON.parse(text)), error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }) : null;
      for (const marketplace of await directories(cacheRoot)) {
        for (const name of await directories(join(cacheRoot, marketplace))) {
          const path = join(cacheRoot, marketplace, name);
          const label = `${cache.label} plugin: ${name}@${marketplace}`;
          try {
            const installations = registry?.plugins[`${name}@${marketplace}`];
            if (registry && !installations?.length) continue;
            const installed = installations?.find(entry => entry.scope === "user") || installations?.[0];
            const versions = (await directories(path)).sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
            const version = versions.includes("latest") ? "latest" : versions[0];
            if (!version) continue;
            const root = await realpath(installed?.installPath || join(path, version));
            if (!contained(cacheRoot, root)) throw new Error("Plugin package must resolve inside its cache.");
            const manifestPath = join(root, cache.label === "Codex" ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json");
            if (!await stat(manifestPath).then(s => s.isFile(), () => false)) continue;
            if (!contained(root, await realpath(manifestPath)) || (await stat(manifestPath)).size > 256 * 1024) throw new Error("Plugin manifests must stay inside their package and fit within 256 KB.");
            const manifest = z.object({ name: z.string().min(1).max(100), version: z.string().max(100).optional(), skills: z.union([z.string(), z.array(z.string()).max(100)]).optional() }).parse(JSON.parse(await readFile(manifestPath, "utf8")));
            const paths = manifest.skills ? (Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills]) : ["skills"];
            if (cache.label === "Claude Code") paths.push("skills");
            for (const value of new Set(paths)) {
              const skillPath = resolve(root, value);
              if (!contained(root, skillPath)) throw new Error("Plugin skills must stay inside their package.");
              if (!await stat(skillPath).then(s => s.isDirectory(), () => false)) continue;
              if (!contained(root, await realpath(skillPath))) throw new Error("Plugin skills must stay inside their package.");
              sources.push({ label: `${label} (${manifest.version || basename(root)})`, path: skillPath, plugin: { name: manifest.name, identity: `${cache.label}:${marketplace}:${name}`, root } });
            }
          } catch (error) { errors.push({ source: label, message: (error as Error).message }); }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push({ source: cache.path, message: (error as Error).message });
    }
  }
  return { sources, errors };
}

function frontmatter(text: string, fallback: string) {
  const header = text.startsWith("---\n") ? text.slice(4).split("\n---")[0] : "";
  const values: Record<string, string> = {};
  for (const key of ["name", "description"]) {
    const match = header.match(new RegExp(`^${key}: *([^\\n]*)(?:\\n((?:[ \\t]+[^\\n]*\\n?)*))?`, "m"));
    if (match) values[key] = ([">", "|", ">-", "|-"].includes(match[1].trim()) ? (match[2] || "").trim().replace(/\s+/g, " ") : match[1].trim().replace(/^["']|["']$/g, "")).slice(0, 2000);
  }
  return { name: values.name || fallback, description: values.description || "No description in SKILL.md." };
}
async function bundle(directory: string): Promise<Bundle> {
  directory = await realpath(directory);
  const candidates = [join(directory, "SKILL.md")];
  async function walk(path: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || ["env", "node_modules", "__pycache__"].includes(entry.name)) continue;
      const target = join(path, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (textTypes.has(extname(entry.name).toLowerCase()) && !/(secret|credential|token|private.key|\.env)/i.test(entry.name)) candidates.push(target);
      if (candidates.length > 256) throw new Error("Too many supporting files. Use a smaller skill folder.");
    }
  }
  for (const name of ["references", "scripts", "assets", "agents"]) {
    const target = join(directory, name);
    if (await lstat(target).then(s => s.isDirectory(), () => false)) await walk(target);
  }
  const files: File[] = [];
  let total = 0, omitted = 0;
  for (const path of candidates.sort()) {
    const canonical = await realpath(path);
    if (!contained(directory, canonical) || !(await stat(canonical)).isFile()) {
      if (path === join(directory, "SKILL.md")) throw new Error("SKILL.md must resolve inside its skill folder.");
      omitted++; continue;
    }
    if ((await stat(canonical)).size > 256 * 1024) throw new Error("A skill file exceeds the 256 KB limit.");
    const raw = await readFile(canonical); total += raw.length;
    if (total > 4 * 1024 * 1024) throw new Error("Skill content exceeds the 4 MB limit.");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { omitted++; continue; }
    files.push({ path: relative(directory, path).split("\\").join("/"), content, hash: hash(raw) });
  }
  if (!files.some(f => f.path === "SKILL.md")) throw new Error("SKILL.md must be UTF-8 text.");
  // Preserve the prototype's canonical serialization so existing bindings still match.
  const serialized = `[${files.map(f => `{"content": ${JSON.stringify(f.content)}, "hash": ${JSON.stringify(f.hash)}, "path": ${JSON.stringify(f.path)}}`).join(", ")}]`;
  return { version: hash(serialized), files, omitted };
}
export class SkillCatalog {
  entries = new Map<string, Entry>();
  paths = new Map<string, string>();
  constructor(readonly snapshotDir: string, private readonly caches = pluginCaches) {}
  async scan(input: unknown) {
    const roots = z.array(z.string().max(1000)).max(12).parse(input);
    const entries = new Map<string, Entry>(), paths = new Map<string, string>();
    const identities = new Map<string, string>();
    const sources: { label: string; count: number; status: string; message?: string }[] = [];
    const plugins = await pluginSources(this.caches), errors = plugins.errors;
    const folders: Source[] = [...new Set(roots)].map(path => ({ label: path, path: expand(path) }));
    for (const folderSource of [...folders, ...plugins.sources]) {
      const source = { label: folderSource.label, count: 0, status: "available", message: "" };
      sources.push(source);
      try {
        const root = await folder(folderSource.path);
        const candidates = await stat(join(root, "SKILL.md")).then(s => s.isFile(), () => false) ? [root] : (await directories(root)).map(name => join(root, name));
        for (const path of candidates) {
          if (!await stat(join(path, "SKILL.md")).then(s => s.isFile(), () => false)) continue;
          source.count++;
          try {
            const canonical = await realpath(path), plugin = folderSource.plugin;
            if (plugin && !contained(plugin.root, canonical)) throw new Error("Plugin skills must stay inside their package.");
            const id = identities.get(canonical) || hash(plugin ? `${plugin.identity}:${relative(plugin.root, canonical)}` : canonical);
            if (entries.has(id)) {
              const existing = entries.get(id)!;
              if (!existing.sources.includes(source.label)) existing.sources.push(source.label);
              continue;
            }
            const data = await bundle(canonical), body = data.files.find(f => f.path === "SKILL.md")!.content;
            const requirements = Object.entries({ Shell: /\b(shell|bash|curl|python|npm|k6|exec_command)\b/i, Browser: /\b(playwright|browser|computer use|compute use|chrome)\b/i, Connector: /\b(mcp|notion|slack|google sheets|google drive)\b/i, Credentials: /\b(api[_ -]?key|oauth|token|credentials|environment variables)\b/i }).filter(([, pattern]) => pattern.test(body)).map(([name]) => name);
            const metadata = frontmatter(body, basename(path));
            entries.set(id, { id, ...metadata, name: plugin ? `${plugin.name}:${metadata.name}` : metadata.name, path, version: data.version, sources: [source.label], requirements, fileCount: data.files.length, omitted: data.omitted });
            paths.set(id, canonical);
            identities.set(canonical, id);
          } catch (error) { errors.push({ source: source.label, name: basename(path), message: (error as Error).message }); }
        }
      } catch (error) { source.status = "unavailable"; source.message = (error as Error).message; errors.push({ source: source.label, message: source.message }); }
    }
    this.entries = entries; this.paths = paths;
    return { skills: [...entries.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), sources, errors };
  }
  async detail(id: string) {
    const path = this.paths.get(id), entry = this.entries.get(id);
    if (!path || !entry) throw new Error("Skill is no longer in the catalog. Refresh your sources.");
    const data = await bundle(path);
    return { ...entry, ...data, fileCount: data.files.length };
  }
  async snapshot(input: unknown) {
    const bindings = z.array(bindingSchema).max(100).parse(input);
    const snapshots: Binding[] = [];
    await mkdir(this.snapshotDir, { recursive: true, mode: 0o700 });
    for (const binding of bindings) {
      const entry = await this.detail(binding.id);
      if (entry.version !== binding.version) throw new Error(`${entry.name} changed. Review and update the binding before starting.`);
      const { version, files, omitted } = entry;
      try { await writeFile(join(this.snapshotDir, `${version}.json`), JSON.stringify({ version, files, omitted }), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      snapshots.push({ id: entry.id, name: entry.name, version, fileCount: files.length, sourcePath: this.paths.get(entry.id) });
    }
    return { snapshots };
  }
  async readSnapshot(version: string): Promise<Bundle> {
    z.string().regex(/^[a-f0-9]{64}$/).parse(version);
    return JSON.parse(await readFile(join(this.snapshotDir, `${version}.json`), "utf8"));
  }
}
