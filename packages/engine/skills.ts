import { readdir, readFile, stat, realpath, lstat, mkdir, writeFile } from "node:fs/promises";
import { join, basename, extname, relative } from "node:path";
import { z } from "zod";
import { contained, expand, folder } from "./projects.ts";
import { hash } from "./store.ts";
import { bindingSchema } from "../contracts/index.ts";
import type { Binding } from "../contracts/index.ts";

const textTypes = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".py", ".js", ".mjs", ".ts", ".sh", ".http", ".csv", ".html", ".css", ".svg"]);
type File = { path: string; content: string; hash: string };
type Bundle = { version: string; files: File[]; omitted: number };
type Entry = { id: string; name: string; description: string; version: string; sources: string[]; path: string; requirements: string[]; fileCount: number; omitted: number };

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
    if (total > 1024 * 1024) throw new Error("Skill content exceeds the 1 MB limit.");
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
  constructor(readonly snapshotDir: string) {}
  async scan(input: unknown) {
    const roots = z.array(z.string().max(1000)).max(12).parse(input);
    const entries = new Map<string, Entry>(), paths = new Map<string, string>();
    const sources: { label: string; count: number; status: string; message?: string }[] = [];
    const errors: { source: string; name?: string; message: string }[] = [];
    for (const raw of new Set(roots)) {
      const source = { label: raw, count: 0, status: "available", message: "" };
      sources.push(source);
      try {
        const root = await folder(expand(raw));
        const candidates = await readdir(root, { withFileTypes: true });
        if (candidates.length > 1000) throw new Error("Use a skills folder with fewer than 1,000 entries.");
        for (const entry of candidates) {
          if (entry.name.startsWith(".")) continue;
          const path = join(root, entry.name);
          if (!await stat(join(path, "SKILL.md")).then(s => s.isFile(), () => false)) continue;
          const canonical = await realpath(path), id = hash(canonical);
          source.count++;
          if (entries.has(id)) { entries.get(id)!.sources.push(raw); continue; }
          try {
            const data = await bundle(canonical), body = data.files.find(f => f.path === "SKILL.md")!.content;
            const requirements = Object.entries({ Shell: /\b(shell|bash|curl|python|npm|k6|exec_command)\b/i, Browser: /\b(playwright|browser|computer use|compute use|chrome)\b/i, Connector: /\b(mcp|notion|slack|google sheets|google drive)\b/i, Credentials: /\b(api[_ -]?key|oauth|token|credentials|environment variables)\b/i }).filter(([, pattern]) => pattern.test(body)).map(([name]) => name);
            entries.set(id, { id, ...frontmatter(body, entry.name), path, version: data.version, sources: [raw], requirements, fileCount: data.files.length, omitted: data.omitted });
            paths.set(id, canonical);
          } catch (error) { errors.push({ source: raw, name: entry.name, message: (error as Error).message }); }
        }
      } catch (error) { source.status = "unavailable"; source.message = (error as Error).message; errors.push({ source: raw, message: source.message }); }
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
