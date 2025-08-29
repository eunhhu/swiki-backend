import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function generateEmbedding(text: string): Promise<number[]> {
  if (!text) return [];
  try {
    const res = await ai.models.embedContent({
      model: "gemini-embedding-001",
      contents: text,
      // 768 dims is enough for most retrieval tasks and smaller to store
      outputDimensionality: 768,
    } as any);
    // typings may lag behind SDK, so cast to any and pick embeddings
    return (res as any).embeddings as number[];
  } catch (e) {
    console.error("embedding error", e);
    return [];
  }
}
