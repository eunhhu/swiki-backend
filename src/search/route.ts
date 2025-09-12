import { Elysia, t } from "elysia";
import type { PrismaClient } from "@prisma/client";
import { generateEmbedding } from "../embedding";
import { Api } from "../api/util";
import { ApiResponse } from "../api/schema";
import { SearchResultItemSchema } from "../wiki/schema";
import { BrowseResponseSchema, SearchBrowseQuerySchema } from "../browse/schema";
import { projectTo2D, buildKnnEdges } from "../browse/layout";
import { Grid } from "../browse/grid";

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
        const MAX_N = Number(process.env.GRID_MAX_N ?? 200);
        const MAX_K = Number(process.env.GRID_MAX_K ?? 20);
        const n = Math.max(1, Math.min(Number(nRaw ?? 50), MAX_N));
        const k = Math.max(1, Math.min(Number(kRaw ?? 4), MAX_K));
        if (!q) return Api.badRequest("q is required");

        const qEmb = await generateEmbedding(q);
        if (!qEmb.length) return Api.internalServerError("embedding failed");

        if (!Grid.isInitialized()) {
          await Grid.ensureInitialized(opts.prisma, Math.max(50, n));
          Grid.startCleanup();
        }

        const top = Grid.searchByEmbedding(qEmb, Math.max(1, n));
        if (top.length === 0) return Api.success({ nodes: [], edges: [] });
        const center = top[0];
        const around = Grid.getAround(center.id, n);
        const ids = around.map((d) => d.id);
        const edges = Grid.buildEdges(ids, k);
        const nodes = around.map((d) => ({ id: d.id, title: d.title, x: d.x, y: d.y, score: d.score, views: d.views, updatedAt: d.updatedAt }));
        return Api.success({ nodes, edges });
      },
      {
        query: SearchBrowseQuerySchema,
        response: ApiResponse(BrowseResponseSchema),
      },
    );
