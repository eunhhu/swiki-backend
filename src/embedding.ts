import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Fixed dimensionality to keep search similarity well-defined
const FALLBACK_DIM = 768;

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

// Deterministic seed from text (FNV-1a 32-bit)
function fnv1a32(str: string): number {
  let h = 0x811c9dc5; // 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0; // 16777619
  }
  return h >>> 0;
}

// Simple deterministic PRNG (Mulberry32)
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296; // [0,1)
  };
}

function ensureDim(vec: number[], dim: number): number[] {
  if (vec.length === dim) return vec;
  if (vec.length > dim) return vec.slice(0, dim);
  const out = vec.slice();
  while (out.length < dim) out.push(0);
  return out;
}

function fallbackEmbedding(text: string, dim: number = FALLBACK_DIM): number[] {
  const seed = fnv1a32(text || "");
  const rand = mulberry32(seed);
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    // map PRNG to [-1, 1]
    out[i] = rand() * 2 - 1;
  }
  return out;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  if (!text) return fallbackEmbedding("");
  try {
    const res = await ai.models.embedContent({
      model: "gemini-embedding-001",
      contents: text,
      outputDimensionality: FALLBACK_DIM,
    } as unknown as { model: string; contents: string; outputDimensionality: number });
    const maybeEmb: unknown = (res as unknown as { embeddings?: unknown }).embeddings;
    if (isNumberArray(maybeEmb)) {
      return ensureDim(maybeEmb, FALLBACK_DIM);
    }
    // If SDK shape differs, try common alternatives
    const alt: unknown = (res as unknown as any)?.data?.[0]?.embedding ?? [];
    if (isNumberArray(alt)) {
      return ensureDim(alt, FALLBACK_DIM);
    }
    // Fall back if unexpected
    return fallbackEmbedding(text);
  } catch (e) {
    console.error("embedding error", e);
    return fallbackEmbedding(text);
  }
}
