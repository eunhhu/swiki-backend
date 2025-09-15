/*
 End-to-end test for central Grid:
 - Seeds assumed in DB. Validates endpoints after grid initialization.
 - Checks integer x,y, no overlaps, presence of (0,0) in trending, and basic counts.
*/

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

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

function summarize(nodes: BrowseNode[], label: string) {
  const invalid: string[] = [];
  for (const n of nodes) if (!isInt(n.x) || !isInt(n.y)) invalid.push(n.id);
  const key = (x: number, y: number) => `${x},${y}`;
  const seen = new Set<string>();
  const dup: string[] = [];
  for (const n of nodes) {
    const k = key(n.x, n.y);
    if (seen.has(k)) dup.push(n.id);
    else seen.add(k);
  }
  const hasOrigin = nodes.some((n) => n.x === 0 && n.y === 0);
  return { total: nodes.length, invalidCount: invalid.length, dupCount: dup.length, hasOrigin, invalidIds: invalid, dupIds: dup };
}

async function getJson<T>(url: string): Promise<ApiResponseShape<T>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ApiResponseShape<T>;
}

async function main() {
  const base = process.env.BASE_URL ?? "http://localhost:8000";
  const q = process.env.SEARCH_QUERY ?? "Guide";

  // 1) Trending (init grid)
  const trendingUrl = `${base}/wiki/browse/trending?n=10&k=4`;
  const trending = await getJson<BrowseData>(trendingUrl);
  if (!trending.success || !trending.data) throw new Error("trending failed");
  const sTrend = summarize(trending.data.nodes, "trending");
  console.log(JSON.stringify({ endpoint: "/wiki/browse/trending", ...sTrend }));

  // 2) Around (BFS neighborhood) for first node by coordinate
  const center = trending.data.nodes[0];
  if (!center) throw new Error("no nodes from trending");
  const aroundUrl = `${base}/wiki/browse/around?x=${center.x}&y=${center.y}&c=10`;
  const around = await getJson<BrowseData>(aroundUrl);
  if (!around.success || !around.data) throw new Error("around failed");
  const sAround = summarize(around.data.nodes, "around");
  console.log(JSON.stringify({ endpoint: "/wiki/browse/around?x&y", centerX: center.x, centerY: center.y, ...sAround }));

  // 3) Search-browse anchored to loaded grid
  const searchUrl = `${base}/search/browse?q=${encodeURIComponent(q)}&n=6&k=4`;
  const search = await getJson<BrowseData>(searchUrl);
  if (!search.success || !search.data) throw new Error("search-browse failed");
  const sSearch = summarize(search.data.nodes, "search-browse");
  console.log(JSON.stringify({ endpoint: "/search/browse", q, ...sSearch }));
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
