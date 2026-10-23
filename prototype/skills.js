(() => {
  "use strict";
  const samples = [
    { id: "sample-code", name: "Code essentials", description: "Inspect existing patterns. Make the smallest useful change. Verify the outcome.", requirements: [] },
    { id: "sample-review", name: "Review checklist", description: "Read the actual diff. Prioritize concrete defects and cite evidence.", requirements: [] },
    { id: "sample-qa", name: "Browser QA checklist", description: "Follow a QA sheet. Check keyboard access and collect browser evidence.", requirements: ["Browser"] },
  ].map(item => ({ ...item, version: "sample-v1", sources: ["Built-in sample"], fileCount: 1, sample: true }));

  class SkillCatalog {
    constructor() {
      this.mode = "loading";
      this.skills = [];
      this.sources = [];
      this.errors = [];
      this.roots = [];
    }

    async request(path, body) {
      const response = await fetch(path, { ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The local skill service is unavailable.");
      return data;
    }

    async load(savedRoots) {
      if (document.documentElement.dataset.offline === "true" || location.protocol === "file:") return this.offline();
      try {
        const status = await this.request("/api/status");
        if (status.service !== "agent-studio-skills") return this.offline();
        this.roots = savedRoots ?? status.roots;
        this.mode = "local";
        await this.refresh(this.roots);
      } catch (error) {
        if (this.mode === "local") { this.mode = "error"; this.errors = [{ message: error.message }]; }
        else this.offline();
      }
    }

    offline() {
      this.mode = "sample";
      this.skills = samples;
      this.sources = [{ label: "Built-in sample", count: samples.length, status: "available" }];
    }

    async refresh(roots = this.roots) {
      const data = await this.request("/api/catalog", { roots });
      Object.assign(this, data, { roots, mode: "local" });
    }

    async detail(id) {
      const sample = samples.find(item => item.id === id);
      if (sample) return { ...sample, files: [{ path: "SKILL.md", content: `# ${sample.name}\n\n${sample.description}\n\nThis is a sample skill for the offline demo.` }] };
      return this.request("/api/skill", { id });
    }

    async snapshot(bindings) {
      const unique = [...new Map(bindings.map(item => [item.id, item])).values()];
      const sampleRefs = unique.filter(item => item.id.startsWith("sample-"));
      const localRefs = unique.filter(item => !item.id.startsWith("sample-"));
      if (localRefs.length && this.mode !== "local") throw new Error("Start the local skill server to resolve your attached skills.");
      const local = localRefs.length ? (await this.request("/api/snapshots", { bindings: localRefs })).snapshots : [];
      return [...local, ...sampleRefs.map(item => ({ ...item, sample: true, fileCount: 1 }))];
    }

    async readSnapshot(binding) {
      return binding.sample ? this.detail(binding.id) : this.request("/api/snapshot", { version: binding.version });
    }
  }
  window.SkillCatalog = SkillCatalog;
})();
