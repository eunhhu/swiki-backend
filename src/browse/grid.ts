import type { PrismaClient } from "@prisma/client";
import { generateEmbedding } from "../embedding";
import { projectTo2D, buildKnnEdges, type Embedding, type Vec2, type Edge } from "./layout";
import { trendingScore } from "./score";

export interface GridDocNode {
  id: string;
  title: string;
  x: number; // integer grid
  y: number; // integer grid
  score: number; // trending score or search score
  views?: number;
  updatedAt?: string;
  emb: number[]; // embedding used for edges/search
}

interface PlaceCandidate {
  id: string;
  title: string;
  views: number;
  updatedAt: Date;
  updatedCount: number;
  emb: number[];
  score: number; // trending score
  coord: Vec2; // projected (float, pre-quantize)
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function* spiralPositions(limit: number): Generator<{ x: number; y: number }> {
  // (0,0), (1,0), (1,1), (0,1), (-1,1), (-1,0), (-1,-1), (0,-1), (1,-1), ...
  let x = 0, y = 0;
  yield { x, y };
  if (limit <= 1) return;
  let step = 1;
  let produced = 1;
  while (produced < limit) {
    // move right step
    for (let i = 0; i < step && produced < limit; i++) { x += 1; yield { x, y }; produced++; }
    // move down step
    for (let i = 0; i < step && produced < limit; i++) { y += 1; yield { x, y }; produced++; }
    step++;
    // move left step
    for (let i = 0; i < step && produced < limit; i++) { x -= 1; yield { x, y }; produced++; }
    // move up step
    for (let i = 0; i < step && produced < limit; i++) { y -= 1; yield { x, y }; produced++; }
    step++;
  }
}

function angleOf(v: Vec2): number {
  // [0, 2pi)
  const a = Math.atan2(v.y, v.x);
  return a < 0 ? a + 2 * Math.PI : a;
}

function now(): number { return Date.now(); }

export class GridMapService {
  private docsById = new Map<string, GridDocNode>();
  private idByCell = new Map<string, string>();
  private placedOrder: string[] = []; // ids in placement order (spiral order)
  private lastAccess = new Map<string, number>();
  private initialized = false;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: { ttlMs: number; minCoreRadius: number }) {}

  isInitialized(): boolean { return this.initialized; }

  startCleanup() {
    if (this.cleanupTimer) return;
    const { ttlMs, minCoreRadius } = this.options;
    this.cleanupTimer = setInterval(() => {
      const cutoff = now() - ttlMs;
      // Only remove cells outside of the core radius to avoid holes near origin
      for (const id of Array.from(this.docsById.keys())) {
        const node = this.docsById.get(id)!;
        const manhattan = Math.abs(node.x) + Math.abs(node.y);
        const la = this.lastAccess.get(id) ?? 0;
        if (manhattan > minCoreRadius && la > 0 && la < cutoff) {
          this.removeNode(id);
        }
      }
    }, 60_000);
  }

  stopCleanup() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  private removeNode(id: string) {
    const node = this.docsById.get(id);
    if (!node) return;
    this.docsById.delete(id);
    this.lastAccess.delete(id);
    const key = cellKey(node.x, node.y);
    this.idByCell.delete(key);
    this.placedOrder = this.placedOrder.filter((x) => x !== id);
  }

  private placeInSpiral(cands: PlaceCandidate[]) {
    // Sort: trending score desc, then by angle, then by radius
    const sorted = cands.slice().sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aa = angleOf(a.coord), ab = angleOf(b.coord);
      if (aa !== ab) return aa - ab;
      const ra = Math.hypot(a.coord.x, a.coord.y);
      const rb = Math.hypot(b.coord.x, b.coord.y);
      return ra - rb;
    });
    const positions = spiralPositions(sorted.length);
    let i = 0;
    for (const pos of positions) {
      const d = sorted[i++];
      const node: GridDocNode = {
        id: d.id,
        title: d.title,
        x: pos.x,
        y: pos.y,
        score: d.score,
        views: d.views,
        updatedAt: d.updatedAt.toISOString(),
        emb: d.emb,
      };
      this.docsById.set(d.id, node);
      this.idByCell.set(cellKey(pos.x, pos.y), d.id);
      this.placedOrder.push(d.id);
      this.lastAccess.set(d.id, now());
    }
  }

  async ensureInitialized(prisma: PrismaClient, initialN: number = 50) {
    if (this.initialized) return;
    const docs = await prisma.document.findMany({
      select: { id: true, title: true, views: true, updatedAt: true, updatedCount: true, embedding: true },
    });
    const scored = docs.map((d) => ({
      ...d,
      score: trendingScore(d.views ?? 0, d.updatedAt, d.updatedCount ?? 0),
    })).sort((a, b) => b.score - a.score).slice(0, Math.max(0, initialN));

    const withEmb = await Promise.all(scored.map(async (d) => {
      let emb = Array.isArray(d.embedding) ? (d.embedding as number[]) : [];
      if (!emb.length) {
        emb = await generateEmbedding(d.title);
        await prisma.document.update({ where: { id: d.id }, data: { embedding: emb } });
      }
      return { ...d, emb };
    }));

    const embs: Embedding[] = withEmb.map((d) => d.emb);
    const { coords } = projectTo2D(embs);
    const cands: PlaceCandidate[] = withEmb.map((d, i) => ({
      id: d.id,
      title: d.title,
      views: d.views ?? 0,
      updatedAt: d.updatedAt,
      updatedCount: d.updatedCount ?? 0,
      emb: d.emb,
      score: d.score,
      coord: coords[i] ?? { x: 0, y: 0 },
    }));

    this.placeInSpiral(cands);
    this.initialized = true;
  }

  getNodes(limit: number): GridDocNode[] {
    const ids = this.placedOrder.slice(0, Math.max(0, limit));
    const out: GridDocNode[] = [];
    for (const id of ids) {
      const n = this.docsById.get(id);
      if (n) {
        out.push(n);
        this.lastAccess.set(id, now());
      }
    }
    return out;
  }

  getByIds(ids: string[]): GridDocNode[] {
    const out: GridDocNode[] = [];
    for (const id of ids) {
      const n = this.docsById.get(id);
      if (n) {
        out.push(n);
        this.lastAccess.set(id, now());
      }
    }
    return out;
  }

  getAround(docId: string, c: number): GridDocNode[] {
    const start = this.docsById.get(docId);
    if (!start) return [];
    const visited = new Set<string>();
    const q: { x: number; y: number }[] = [{ x: start.x, y: start.y }];
    const result: GridDocNode[] = [];
    while (q.length && result.length < c) {
      const p = q.shift()!;
      const id = this.idByCell.get(cellKey(p.x, p.y));
      if (id && !visited.has(id)) {
        visited.add(id);
        const n = this.docsById.get(id)!;
        result.push(n);
        this.lastAccess.set(id, now());
      }
      // 4-neighborhood
      const neigh = [
        { x: p.x + 1, y: p.y },
        { x: p.x - 1, y: p.y },
        { x: p.x, y: p.y + 1 },
        { x: p.x, y: p.y - 1 },
      ];
      for (const nb of neigh) {
        const nid = this.idByCell.get(cellKey(nb.x, nb.y));
        if (nid && !visited.has(nid)) q.push(nb);
      }
    }
    return result;
  }

  searchByEmbedding(qEmb: number[], n: number): GridDocNode[] {
    // cosine similarity against loaded docs
    function cos(a: number[], b: number[]): number {
      if (!a.length || !b.length || a.length !== b.length) return -1;
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
      return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
    }
    const all = Array.from(this.docsById.values());
    all.sort((a, b) => cos(qEmb, b.emb) - cos(qEmb, a.emb));
    const top = all.slice(0, Math.max(0, n));
    for (const t of top) this.lastAccess.set(t.id, now());
    return top;
  }

  buildEdges(ids: string[], k: number): Edge[] {
    const embs = ids.map((id) => this.docsById.get(id)!.emb);
    return buildKnnEdges(ids, embs, Math.max(1, Math.min(k, Math.max(0, ids.length - 1))))
  }

  async onDocFlushed(prisma: PrismaClient, id: string) {
    // recompute embedding based on title (or leave unchanged if missing)
    const doc = await prisma.document.findUnique({ where: { id }, select: { title: true } });
    if (!doc) return;
    const emb = await generateEmbedding(doc.title);
    await prisma.document.update({ where: { id }, data: { embedding: emb } });
    const existing = this.docsById.get(id);
    if (existing) {
      existing.emb = emb;
      this.lastAccess.set(id, now());
      // keep position stable to avoid expensive re-layout
    }
  }
}

// Singleton instance with defaults
export const Grid = new GridMapService({ ttlMs: Number(process.env.GRID_TTL_MS ?? 10 * 60_000), minCoreRadius: Number(process.env.GRID_CORE_RADIUS ?? 2) });
