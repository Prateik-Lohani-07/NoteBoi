import cytoscape from "cytoscape";
import type { VizEdge, VizNode } from "./retrieve";

const COLORS = {
  seed: "#4c8bf5",
  expanded: "#f59e0b",
  note: "#9ca3af",
  concept: "#10b981",
};

/** Renders the retrieved subgraph. Blue = vector/keyword hits, amber = pulled in by graph traversal. */
export class GraphPanel {
  private cy: cytoscape.Core | null = null;

  constructor(
    private el: HTMLElement,
    private onOpen: (node: VizNode) => void,
  ) {}

  render(nodes: VizNode[], edges: VizEdge[]) {
    this.destroy();
    const ids = new Set(nodes.map((n) => n.id));
    this.cy = cytoscape({
      container: this.el,
      elements: [
        ...nodes.map((n) => ({ data: { ...n, color: colorOf(n) } })),
        ...edges
          .filter((e) => ids.has(e.source) && ids.has(e.target))
          .map((e, i) => ({ data: { id: `e${i}`, source: e.source, target: e.target, type: e.type } })),
      ],
      layout: { name: "cose", animate: false, nodeRepulsion: () => 9000, idealEdgeLength: () => 70 },
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(color)",
            label: "data(label)",
            color: "#d1d5db",
            "font-size": 9,
            "text-valign": "bottom",
            "text-margin-y": 3,
            "text-wrap": "ellipsis",
            "text-max-width": "90px",
            width: 18,
            height: 18,
          },
        },
        { selector: 'node[kind = "note"]', style: { shape: "round-rectangle", width: 22, height: 14 } },
        { selector: 'node[kind = "concept"]', style: { shape: "diamond", width: 16, height: 16 } },
        {
          selector: "edge",
          style: {
            width: 1.2,
            "line-color": "#6b7280",
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "target-arrow-color": "#6b7280",
            "arrow-scale": 0.6,
          },
        },
        { selector: 'edge[type = "MENTIONS"]', style: { "line-style": "dashed", "line-color": "#10b981", "target-arrow-color": "#10b981" } },
        { selector: 'edge[type = "LINKS_TO"]', style: { "line-color": "#a78bfa", "target-arrow-color": "#a78bfa" } },
      ],
    });
    this.cy.on("tap", "node", (evt) => this.onOpen(evt.target.data() as VizNode));
  }

  destroy() {
    this.cy?.destroy();
    this.cy = null;
  }
}

function colorOf(n: VizNode): string {
  if (n.kind === "note") return COLORS.note;
  if (n.kind === "concept") return COLORS.concept;
  return n.role === "seed" ? COLORS.seed : COLORS.expanded;
}
