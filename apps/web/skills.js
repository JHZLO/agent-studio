import { request } from "./runtime.js";
class SkillCatalog {
  mode = "loading";
  skills = [];
  sources = [];
  errors = [];
  roots = [];
  request(path, body) { return request(path, body); }
  async load(roots) {
    try { await this.refresh(roots); }
    catch (error) { this.mode = "error"; this.errors = [{ message: error.message }]; }
  }
  async refresh(roots = this.roots) {
    const data = await request("/api/catalog", { roots }); Object.assign(this, data, { roots, mode: "local" });
  }
  detail(id) { return request("/api/skill", { id }); }
  async snapshot(bindings) { return (await request("/api/snapshots", { bindings: [...new Map(bindings.map(binding => [binding.id, binding])).values()] })).snapshots; }
  readSnapshot(binding) { return request("/api/snapshot", { version: binding.version }); }
}
window.SkillCatalog = SkillCatalog;
