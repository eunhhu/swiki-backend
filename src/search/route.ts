import { Elysia, t } from "elysia";
import type { PrismaClient } from "@prisma/client";
import { generateEmbedding } from "../embedding";
import { Api } from "../api/util";
import { ApiResponse } from "../api/schema";
import { SearchResultItemSchema } from "../wiki/schema";
import { BrowseResponseSchema, SearchBrowseQuerySchema } from "../browse/schema";
import { projectTo2D, buildKnnEdges } from "../browse/layout";

interface SearchRoutesOptions {
  prisma: PrismaClient;
  prefix?: string;
}

function cosineSim(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return -1;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

export const searchRoutes = (opts: SearchRoutesOptions) =>
  new Elysia({ prefix: opts.prefix })
    .get(
      "/search",
      async ({ query }) => {
        const q = query.q as string;
        const topK = Number(query.k ?? 10);
        if (!q) return Api.badRequest("q is required");

        const qEmb = await generateEmbedding(q);
        if (qEmb.length === 0) return Api.internalServerError("embedding failed");

        const docs = await opts.prisma.document.findMany({
          select: { id: true, title: true, embedding: true },
        });

        const scored = await Promise.all(
          docs.map(async (d) => {
            let emb = (d.embedding ?? []) as number[];
            if (!emb.length) {
              // compute and update missing embedding lazily
              emb = await generateEmbedding(d.title);
              await opts.prisma.document.update({
                where: { id: d.id },
                data: { embedding: emb },
              });
            }
            const score = cosineSim(qEmb, emb);
            return { ...d, score };
          }),
        );

        scored.sort((a, b) => b.score - a.score);
        return Api.success(scored.slice(0, topK));
      },
      {
        query: t.Object({
          q: t.String(),
          k: t.Optional(t.String()),
        }),
        response: ApiResponse(t.Array(SearchResultItemSchema)),
      },
    )
    .get(
      "/search/browse",
      async ({ query }) => {
        const { q, n: nRaw, k: kRaw } = query as { q: string; n?: string; k?: string };
        const n = Number(nRaw ?? 50);
        const k = Number(kRaw ?? 4);
        if (!q) return Api.badRequest("q is required");

        const qEmb = await generateEmbedding(q);
        if (!qEmb.length) return Api.internalServerError("embedding failed");

        const docs = await opts.prisma.document.findMany({
          select: { id: true, title: true, views: true, updatedAt: true, embedding: true, thumbnail: true, words: true },
        });

        const scored = await Promise.all(
          docs.map(async (d) => {
            let emb = (d.embedding as unknown as number[]) ?? [];
            if (!Array.isArray(emb) || emb.length === 0) {
              emb = await generateEmbedding(d.title);
              await opts.prisma.document.update({ where: { id: d.id }, data: { embedding: emb } });
            }
            const score = cosineSim(qEmb, emb);
            return { ...d, score, emb };
          }),
        );

        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, Math.max(0, n));
        const ids = top.map((d) => d.id);
        const embs = top.map((d) => d.emb as number[]);
        const { coords } = projectTo2D(embs);
        const nodes = top.map((d, i) => ({
          id: d.id,
          image: d.thumbnail,
          words: d.words,
          title: d.title,
          x: coords[i]?.x ?? 0,
          y: coords[i]?.y ?? 0,
          score: d.score,
          views: d.views,
          updatedAt: d.updatedAt?.toISOString?.() ?? undefined,
        }));
        const edges = buildKnnEdges(
          ids,
          embs,
          Math.max(1, Math.min(k, Math.max(0, ids.length - 1))),
        );
        return Api.success({ nodes, edges });
      },
      {
        query: SearchBrowseQuerySchema,
        response: ApiResponse(BrowseResponseSchema),
      },
    );
