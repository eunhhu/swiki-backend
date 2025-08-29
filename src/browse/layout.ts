export interface Vec2 { x: number; y: number }
export interface Edge { source: string; target: string; distance: number }
export type Embedding = number[];

function dot(a: Embedding, b: Embedding): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function norm2(a: Embedding): number {
  return Math.sqrt(dot(a, a));
}

export function cosineSim(a: Embedding, b: Embedding): number {
  const na = norm2(a);
  const nb = norm2(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb + 1e-8);
}

export function centerEmbeddings(embs: Embedding[]): { centered: Embedding[]; mean: Embedding } {
  if (embs.length === 0) return { centered: [], mean: [] };
  // Use the maximum dimensionality across all embeddings
  const d = Math.max(...embs.map((e) => e.length), 0);
  const mean = new Array<number>(d).fill(0);
  for (const e of embs) {
    for (let i = 0; i < d; i++) mean[i] += (e[i] ?? 0);
  }
  for (let i = 0; i < d; i++) mean[i] /= embs.length;
  const centered = embs.map((e) => {
    const row = new Array<number>(d);
    for (let i = 0; i < d; i++) row[i] = (e[i] ?? 0) - mean[i];
    return row;
  });
  return { centered, mean };
}

function sanitizeNumber(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function quantizeVec2(coords: Vec2[]): Vec2[] {
  return coords.map((c) => ({ x: Math.round(c.x), y: Math.round(c.y) }));
}

function scatterCircle(n: number): Vec2[] {
  if (n <= 0) return [];
  if (n === 1) return [{ x: 0, y: 0 }];
  const r = 1;
  return Array.from({ length: n }, (_, i) => {
    const theta = (2 * Math.PI * i) / n;
    return { x: r * Math.cos(theta), y: r * Math.sin(theta) };
  });
}

function isCollapsed(coords: Vec2[], eps: number = 1e-8): boolean {
  const n = coords.length;
  if (n <= 1) return false;
  let maxD = 0;
  for (let i = 0; i < n; i++) {
    const ai = coords[i]!;
    for (let j = i + 1; j < n; j++) {
      const aj = coords[j]!;
      const d = Math.hypot(ai.x - aj.x, ai.y - aj.y);
      if (Number.isFinite(d) && d > maxD) maxD = d;
    }
  }
  return maxD <= eps;
}

function gramMatrix(X: Embedding[]): number[][] {
  const n = X.length;
  const G: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const g = dot(X[i], X[j]);
      G[i][j] = g;
      G[j][i] = g;
    }
  }
  return G;
}

function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) + 1e-12;
  return v.map((x) => x / n);
}

function powerIterationSym(A: number[][], iters: number = 100): { vec: number[]; val: number } {
  const n = A.length;
  let v = normalize(Array.from({ length: n }, () => Math.random() - 0.5));
  for (let t = 0; t < iters; t++) {
    const Av = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const Ai = A[i];
      for (let j = 0; j < n; j++) s += Ai[j] * v[j];
      Av[i] = s;
    }
    v = normalize(Av);
  }
  // Rayleigh quotient for eigenvalue
  let num = 0, den = 0;
  const Av = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += A[i][j] * v[j];
    Av[i] = s;
    num += v[i] * s;
    den += v[i] * v[i];
  }
  const val = num / (den + 1e-12);
  return { vec: v, val };
}

export function projectTo2D(embs: Embedding[]): { coords: Vec2[] } {
  if (embs.length === 0) return { coords: [] };
  const { centered } = centerEmbeddings(embs);
  const G = gramMatrix(centered);
  const { vec: v1, val: l1 } = powerIterationSym(G, 60);
  // deflate
  const n = G.length;
  const G2: number[][] = Array.from({ length: n }, (_, i) => G[i].slice());
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      G2[i][j] -= l1 * v1[i] * v1[j];
    }
  }
  const { vec: v2, val: l2 } = powerIterationSym(G2, 60);
  const s1 = Math.sqrt(Math.max(l1, 0));
  const s2 = Math.sqrt(Math.max(l2, 0));
  let coords: Vec2[] = Array.from({ length: n }, (_, i) => ({
    x: sanitizeNumber(s1 * v1[i]),
    y: sanitizeNumber(s2 * v2[i]),
  }));
  // Fallback: if projection collapses (e.g., zero/identical embeddings), spread points on a circle
  if (isCollapsed(coords)) {
    coords = scatterCircle(n);
  }
  // Quantize to integers
  coords = quantizeVec2(coords);
  return { coords };
}

export function buildKnnEdges(ids: string[], embs: Embedding[], k: number): Edge[] {
  const n = embs.length;
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const sims: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    sims[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const s = cosineSim(embs[i], embs[j]);
      sims[i][j] = s;
      sims[j][i] = s;
    }
  }
  for (let i = 0; i < n; i++) {
    const neighbors = Array.from({ length: n }, (_, j) => j)
      .filter((j) => j !== i)
      .map((j) => ({ j, s: sims[i][j] }))
      .sort((a, b) => b.s - a.s)
      .slice(0, Math.max(1, Math.min(k, n - 1)));
    for (const nb of neighbors) {
      const a = Math.min(i, nb.j);
      const b = Math.max(i, nb.j);
      const key = `${a}:${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const s = Number.isFinite(nb.s) ? nb.s : 0;
      const clamped = Math.max(0, Math.min(1, s));
      edges.push({ source: ids[a], target: ids[b], distance: sanitizeNumber(1 - clamped) });
    }
  }
  return edges;
}
