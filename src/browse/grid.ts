import type { PrismaClient } from "@prisma/client";
import { generateEmbedding } from "../embedding";
import { projectTo2D, buildKnnEdges, cosineSim, type Embedding, type Vec2, type Edge } from "./layout";
import { trendingScore } from "./score";
import * as fs from "fs";
import * as path from "path";

export interface GridDocNode {
  id: string;
  title: string;
  x: number; // integer grid
  y: number; // integer grid
  score: number; // trending score or search score
  words: number;
  thumbnail?: string;
  views: number;
  updatedAt: string;
  emb: number[]; // embedding used for edges/search
}

interface PlaceCandidate {
  id: string;
  title: string;
  views: number;
  words: number;
  thumbnail?: string;
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
  private removedCount = 0;

  // simple mutex
  private lockQueue: Array<() => void> = [];
  private locked = false;

  private readonly placement: "spiral" | "nearest";
  private readonly persistPath: string | null;
  private lastSaveTs: number | null = null;
  private edgesCache = new Map<string, Edge[]>();
  private readonly edgesCacheMax = 100;

  constructor(private readonly options: { ttlMs: number; minCoreRadius: number; placement?: "spiral" | "nearest"; persistPath?: string | null }) {
    this.placement = options.placement ?? (process.env.GRID_PLACEMENT === "spiral" ? "spiral" : "nearest");
    this.persistPath = options.persistPath ?? (process.env.GRID_PERSIST_PATH || null);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.locked) {
      this.locked = true;
      try {
        return await fn();
      } finally {
        this.locked = false;
        const next = this.lockQueue.shift();
        if (next) next();
      }
    }
    await new Promise<void>((resolve) => this.lockQueue.push(resolve));
    return this.withLock(fn);
  }

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
          this.removedCount += 1;
        }
      }
      // periodic save if persistence enabled
      if (this.persistPath && (this.lastSaveTs === null || now() - this.lastSaveTs > 60_000)) {
        try { this.saveToDisk(); } catch {}
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
        words: d.words,
        thumbnail: d.thumbnail ?? undefined,
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

  private isOccupied(x: number, y: number): boolean {
    return this.idByCell.has(cellKey(x, y));
  }

  private* ringNeighbors(cx: number, cy: number, r: number): Generator<{ x: number; y: number }> {
    if (r === 0) { yield { x: cx, y: cy }; return; }
    let x = cx - r, y = cy - r;
    for (let i = 0; i < 2 * r; i++) { yield { x: x + i, y }; }
    x = cx + r; y = cy - r; for (let i = 0; i < 2 * r; i++) { yield { x, y: y + i }; }
    x = cx + r; y = cy + r; for (let i = 0; i < 2 * r; i++) { yield { x: x - i, y }; }
    x = cx - r; y = cy + r; for (let i = 0; i < 2 * r; i++) { yield { x, y: y - i }; }
  }

  private nearestFreeCellApprox(tx: number, ty: number, maxR: number = 2048): { x: number; y: number } {
    const qx = Math.round(tx), qy = Math.round(ty);
    if (!this.isOccupied(qx, qy)) return { x: qx, y: qy };
    for (let r = 1; r <= maxR; r++) {
      for (const p of this.ringNeighbors(qx, qy, r)) {
        if (!this.isOccupied(p.x, p.y)) return p;
      }
    }
    // fallback shouldn't happen in practical sizes
    return { x: qx, y: qy };
  }

  private placeNearest(cands: PlaceCandidate[]) {
    const sorted = cands.slice().sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ra = Math.hypot(a.coord.x, a.coord.y);
      const rb = Math.hypot(b.coord.x, b.coord.y);
      return ra - rb;
    });
    for (const d of sorted) {
      const pos = this.nearestFreeCellApprox(d.coord.x, d.coord.y);
      const node: GridDocNode = {
        id: d.id,
        title: d.title,
        x: pos.x,
        y: pos.y,
        score: d.score,
        views: d.views,
        words: d.words,
        thumbnail: d.thumbnail ?? undefined,
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
    await this.withLock(async () => {
      if (this.initialized) return;
      // try load from disk first
      const loaded = await this.tryLoadFromDisk(prisma);
      if (loaded) { this.initialized = true; return; }

      const docs = await prisma.document.findMany({
      select: { id: true, title: true, views: true, words: true, updatedAt: true, updatedCount: true, embedding: true, thumbnail: true },
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
      words: d.words,
      thumbnail: d.thumbnail ?? undefined,
      coord: coords[i] ?? { x: 0, y: 0 },
      }));

      if (this.placement === "nearest") this.placeNearest(cands);
      else this.placeInSpiral(cands);
      this.initialized = true;
      if (this.persistPath) {
        try { this.saveToDisk(); } catch {}
      }
    });
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
    const key = `${k}|${ids.join(',')}`;
    const hit = this.edgesCache.get(key);
    if (hit) {
      // refresh LRU
      this.edgesCache.delete(key);
      this.edgesCache.set(key, hit);
      return hit;
    }
    const embs = ids.map((id) => this.docsById.get(id)!.emb);
    const edges = buildKnnEdges(ids, embs, Math.max(1, Math.min(k, Math.max(0, ids.length - 1))));
    this.edgesCache.set(key, edges);
    // enforce LRU size
    if (this.edgesCache.size > this.edgesCacheMax) {
      const firstKey = this.edgesCache.keys().next().value as string | undefined;
      if (firstKey) this.edgesCache.delete(firstKey);
    }
    return edges;
  }

  // Estimate a good target coordinate for a new embedding by weighted average
  // of the k nearest existing nodes in embedding space.
  private estimateTargetCoord(emb: number[], kNeighbors: number = 8): { x: number; y: number } {
    if (this.docsById.size === 0) return { x: 0, y: 0 };
    const all = Array.from(this.docsById.values());
    const scored = all
      .map((n) => ({ n, s: cosineSim(emb, n.emb) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, Math.max(1, Math.min(kNeighbors, all.length)));
    let wx = 0, wy = 0, sw = 0;
    for (const { n, s } of scored) {
      const w = Math.max(0, Number.isFinite(s) ? s : 0);
      wx += w * n.x;
      wy += w * n.y;
      sw += w;
    }
    const tx = sw > 0 ? wx / sw : 0;
    const ty = sw > 0 ? wy / sw : 0;
    return { x: tx, y: ty };
  }

  // Place any missing documents by IDs onto the grid and return their nodes.
  async ensureNodesPlacedByIds(prisma: PrismaClient, ids: string[]): Promise<GridDocNode[]> {
    return this.withLock(async () => {
      const out: GridDocNode[] = [];
      const missing: string[] = [];
      for (const id of ids) {
        const ex = this.docsById.get(id);
        if (ex) {
          out.push(ex);
          this.lastAccess.set(id, now());
        } else {
          missing.push(id);
        }
      }
      if (missing.length === 0) return out;

      const docs = await prisma.document.findMany({
        where: { id: { in: missing } },
        select: {
          id: true,
          title: true,
          views: true,
          words: true,
          thumbnail: true,
          updatedAt: true,
          updatedCount: true,
          embedding: true,
        },
      });
      for (const d of docs) {
        let emb = Array.isArray(d.embedding) ? (d.embedding as number[]) : [];
        if (!emb.length) {
          emb = await generateEmbedding(d.title);
          await prisma.document.update({ where: { id: d.id }, data: { embedding: emb } });
        }
        const target = this.estimateTargetCoord(emb);
        const pos = this.nearestFreeCellApprox(target.x, target.y);
        const node: GridDocNode = {
          id: d.id,
          title: d.title,
          x: pos.x,
          y: pos.y,
          score: trendingScore(d.views ?? 0, d.updatedAt, d.updatedCount ?? 0),
          views: d.views ?? 0,
          words: d.words,
          thumbnail: d.thumbnail ?? undefined,
          updatedAt: d.updatedAt.toISOString(),
          emb,
        };
        this.docsById.set(d.id, node);
        this.idByCell.set(cellKey(pos.x, pos.y), d.id);
        this.placedOrder.push(d.id);
        this.lastAccess.set(d.id, now());
        out.push(node);
      }
      if (this.persistPath) {
        try {
          this.saveToDisk();
        } catch {}
      }
      return out;
    });
  }

  async onDocFlushed(prisma: PrismaClient, id: string) {
    await this.withLock(async () => {
      // recompute embedding based on title (or leave unchanged if missing)
      const doc = await prisma.document.findUnique({ where: { id }, select: { title: true } });
      if (!doc) return;
      const emb = await generateEmbedding(doc.title);
      await prisma.document.update({ where: { id }, data: { embedding: emb } });
      const existing = this.docsById.get(id);
      if (existing) {
        existing.emb = emb;
        this.lastAccess.set(id, now());
      }
      // Invalidate edges cache to avoid stale distances
      this.edgesCache.clear();
      if (this.persistPath) { try { this.saveToDisk(); } catch {} }
    });
  }

  getMetrics() {
    const lastSave = this.lastSaveTs === null ? undefined : this.lastSaveTs;
    const ppath = this.persistPath ?? undefined;
    return {
      total: this.docsById.size,
      placedOrder: this.placedOrder.length,
      removedCount: this.removedCount,
      lastSaveTs: lastSave,
      placement: this.placement,
      persistPath: ppath,
    };
  }

  private ensurePersistDir(): string | null {
    if (!this.persistPath) return null;
    const dir = path.dirname(this.persistPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return this.persistPath;
  }

  saveToDisk() {
    const p = this.ensurePersistDir();
    if (!p) return;
    const payload = {
      version: 1,
      nodes: Array.from(this.docsById.values()).map((n) => ({ id: n.id, x: n.x, y: n.y })),
      ts: now(),
    };
    fs.writeFileSync(p, JSON.stringify(payload));
    this.lastSaveTs = now();
  }

  private async tryLoadFromDisk(prisma: PrismaClient): Promise<boolean> {
    const p = this.persistPath;
    if (!p || !fs.existsSync(p)) return false;
    try {
      const raw = fs.readFileSync(p, "utf-8");
      const data = JSON.parse(raw) as { version: number; nodes: { id: string; x: number; y: number }[] };
      if (!data.nodes?.length) return false;
      // load docs by ids, attach embeddings
      const ids = data.nodes.map((n) => n.id);
      const docs = await prisma.document.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, views: true, words: true, thumbnail: true, updatedAt: true, embedding: true } });
      const byId: Record<string, typeof docs[number]> = Object.fromEntries(docs.map((d) => [d.id, d]));
      for (const n of data.nodes) {
        const d = byId[n.id];
        if (!d) continue;
        let emb = Array.isArray(d.embedding) ? (d.embedding as number[]) : [];
        if (!emb.length) {
          emb = await generateEmbedding(d.title);
          await prisma.document.update({ where: { id: d.id }, data: { embedding: emb } });
        }
        const node: GridDocNode = {
          id: d.id,
          title: d.title,
          x: n.x,
          y: n.y,
          score: trendingScore(d.views ?? 0, d.updatedAt, 0),
          views: d.views ?? 0,
          words: d.words,
          thumbnail: d.thumbnail ?? undefined,
          updatedAt: d.updatedAt.toISOString(),
          emb,
        };
        this.docsById.set(d.id, node);
        this.idByCell.set(cellKey(n.x, n.y), d.id);
        this.placedOrder.push(d.id);
        this.lastAccess.set(d.id, now());
      }
      return this.docsById.size > 0;
    } catch {
      return false;
    }
  }
}

// Singleton instance with defaults
export const Grid = new GridMapService({
  ttlMs: Number(process.env.GRID_TTL_MS ?? 10 * 60_000),
  minCoreRadius: Number(process.env.GRID_CORE_RADIUS ?? 2),
  placement: process.env.GRID_PLACEMENT === "spiral" ? "spiral" : "nearest",
  persistPath: process.env.GRID_PERSIST_PATH ?? path.join(process.cwd(), "data/grid.json"),
});
