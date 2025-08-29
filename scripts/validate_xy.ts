/*
 Validate that all nodes from /wiki/browse/trending have finite numeric x,y.
 Falls back to computing the layout from DB if HTTP endpoint is unavailable.
*/

import { PrismaClient } from "@prisma/client";
import { projectTo2D, type Embedding } from "../src/browse/layout";

// ---------------- Types & Type Guards ----------------
interface BrowseNode {
  id: string;
  title: string;
  x: number;
  y: number;
  score: number;
  views?: number;
  updatedAt?: string;
}

interface BrowseEdge {
  source: string;
  target: string;
  distance: number;
}

interface BrowseData {
  nodes: BrowseNode[];
  edges: BrowseEdge[];
}

interface ApiErrorShape {
  status: number;
  code: string;
  details?: unknown;
}

interface ApiResponseShape<T> {
  data?: T;
  timestamp: string;
  success: boolean;
  error?: ApiErrorShape;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isIntegerNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function isBrowseNode(v: unknown): v is BrowseNode {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.title === "string" &&
    isIntegerNumber(o.x) &&
    isIntegerNumber(o.y) &&
    isFiniteNumber(o.score) &&
    (o.views === undefined || isFiniteNumber(o.views)) &&
    (o.updatedAt === undefined || typeof o.updatedAt === "string")
  );
}

function isBrowseEdge(v: unknown): v is BrowseEdge {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.source === "string" &&
    typeof o.target === "string" &&
    isFiniteNumber(o.distance)
  );
}

function isBrowseData(v: unknown): v is BrowseData {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    Array.isArray(o.nodes) && o.nodes.every(isBrowseNode) &&
    Array.isArray(o.edges) && o.edges.every(isBrowseEdge)
  );
}

function isApiErrorShape(v: unknown): v is ApiErrorShape {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return isFiniteNumber(r.status) && typeof r.code === "string";
}

function isApiResponseBrowseData(v: unknown): v is ApiResponseShape<BrowseData> {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const hasTimestamp = typeof o.timestamp === "string";
  const hasSuccess = typeof o.success === "boolean";
  const hasData = o.data === undefined || isBrowseData(o.data);
  const hasError = o.error === undefined || isApiErrorShape(o.error);
  return hasTimestamp && hasSuccess && hasData && hasError;
}

// ---------------- Validation Logic ----------------
interface XYValidationSummary {
  total: number;
  invalidCount: number;
  invalidIds: string[];
  exactOverlapGroups: string[][]; // groups of ids with identical coordinates
  nearOverlapPairs: { a: string; b: string; distance: number }[];
  eps: number;
}

function validateNodesXY(
  nodes: BrowseNode[],
  eps: number,
): XYValidationSummary {
  const invalidIds: string[] = [];
  for (const n of nodes) {
    if (!Number.isInteger(n.x) || !Number.isInteger(n.y)) invalidIds.push(n.id);
  }

  // exact duplicates
  const key = (x: number, y: number): string => `${x}::${y}`;
  const buckets = new Map<string, string[]>();
  for (const n of nodes) {
    const k = key(n.x, n.y);
    const arr = buckets.get(k) ?? [];
    arr.push(n.id);
    buckets.set(k, arr);
  }
  const exactOverlapGroups = Array.from(buckets.values()).filter((g) => g.length > 1);

  // near duplicates within eps (euclidean)
  const nearOverlapPairs: { a: string; b: string; distance: number }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[i]!.x - nodes[j]!.x;
      const dy = nodes[i]!.y - nodes[j]!.y;
      const d = Math.hypot(dx, dy);
      if (Number.isFinite(d) && d <= eps) {
        nearOverlapPairs.push({ a: nodes[i]!.id, b: nodes[j]!.id, distance: d });
      }
    }
  }

  return {
    total: nodes.length,
    invalidCount: invalidIds.length,
    invalidIds,
    exactOverlapGroups,
    nearOverlapPairs,
    eps,
  };
}

async function tryTrendingHttp(eps: number): Promise<
  { ok: true; result: XYValidationSummary } | { ok: false; reason: string }
> {
  const base = process.env.BASE_URL ?? "http://localhost:8000";
  const url = `${base}/wiki/browse/trending?n=50&k=4`;
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` } as const;
    const json: unknown = await res.json();
    if (!isApiResponseBrowseData(json)) return { ok: false, reason: "Response shape invalid" } as const;
    const data = (json as ApiResponseShape<BrowseData>).data ?? { nodes: [], edges: [] };
    const summary = validateNodesXY(data.nodes, eps);
    return { ok: true, result: summary } as const;
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "unknown error" } as const;
  }
}

async function trySearchHttp(eps: number): Promise<
  { ok: true; result: XYValidationSummary } | { ok: false; reason: string }
> {
  const base = process.env.BASE_URL ?? "http://localhost:8000";
  const query = process.env.SEARCH_QUERY ?? "Guide";
  const n = process.env.SEARCH_N ?? "20";
  const k = process.env.SEARCH_K ?? "4";
  const url = `${base}/search/browse?q=${encodeURIComponent(query)}&n=${n}&k=${k}`;
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` } as const;
    const json: unknown = await res.json();
    if (!isApiResponseBrowseData(json)) return { ok: false, reason: "Response shape invalid" } as const;
    const data = (json as ApiResponseShape<BrowseData>).data ?? { nodes: [], edges: [] };
    const summary = validateNodesXY(data.nodes, eps);
    return { ok: true, result: summary } as const;
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "unknown error" } as const;
  }
}

async function fallbackOffline(eps: number): Promise<XYValidationSummary> {
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    const docs = await prisma.document.findMany({
      select: { id: true, title: true, embedding: true },
    });
    const ids: string[] = [];
    const embs: Embedding[] = [];
    for (const d of docs) {
      ids.push(d.id);
      const emb = Array.isArray(d.embedding) ? (d.embedding as number[]) : [];
      embs.push(emb);
    }
    const { coords } = projectTo2D(embs);
    // Build BrowseNode-like array to reuse the same validator
    const nodes: BrowseNode[] = ids.map((id, i) => ({ id, title: docs[i]!.title, x: coords[i]?.x ?? 0, y: coords[i]?.y ?? 0, score: 0 }));
    return validateNodesXY(nodes, eps);
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  const eps = Number.isFinite(Number(process.env.EPS)) ? Number(process.env.EPS) : 1e-6;

  // Trending
  const trending = await tryTrendingHttp(eps);
  if (trending.ok) {
    console.log(
      JSON.stringify({ mode: "http", endpoint: "/wiki/browse/trending", ...trending.result }),
    );
  } else {
    const offline = await fallbackOffline(eps);
    console.log(
      JSON.stringify({ mode: "offline", endpoint: "/wiki/browse/trending", ...offline, reason: trending.reason }),
    );
  }

  // Search Browse
  const search = await trySearchHttp(eps);
  if (search.ok) {
    console.log(
      JSON.stringify({ mode: "http", endpoint: "/search/browse", ...search.result }),
    );
  } else {
    console.log(
      JSON.stringify({ mode: "error", endpoint: "/search/browse", reason: search.reason }),
    );
  }
}

// Run
main().catch((e) => {
  console.error(JSON.stringify({ mode: "error", error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
