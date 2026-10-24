export type FlowGraph = { workflow: string[]; edges?: { from: string; to: string }[] };

export const flowEdges = (flow: FlowGraph) => flow.edges ?? flow.workflow.slice(1).map((to, index) => ({ from: flow.workflow[index], to }));

export function relatedSteps(flow: FlowGraph, id: string, direction: "upstream" | "downstream") {
  const found = new Set<string>(), pending = [id], edges = flowEdges(flow);
  while (pending.length) {
    const current = pending.pop()!;
    for (const edge of edges) {
      const next = direction === "upstream" ? edge.from : edge.to;
      if ((direction === "upstream" ? edge.to : edge.from) === current && next !== id && !found.has(next)) { found.add(next); pending.push(next); }
    }
  }
  return found;
}

export function flowLayers(flow: FlowGraph) {
  const edges = flowEdges(flow), remaining = new Set(flow.workflow), layers: string[][] = [];
  while (remaining.size) {
    const layer = flow.workflow.filter(id => remaining.has(id) && !edges.some(edge => edge.to === id && remaining.has(edge.from)));
    if (!layer.length) throw new Error("Connections cannot form a cycle. Use bounded revision rules to return to an earlier agent.");
    layers.push(layer);
    for (const id of layer) remaining.delete(id);
  }
  return layers;
}
