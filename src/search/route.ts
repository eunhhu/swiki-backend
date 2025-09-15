import { Elysia, t } from "elysia";
import type { PrismaClient } from "@prisma/client";
import { generateEmbedding } from "../embedding";
import { Api } from "../api/util";
import { ApiResponse } from "../api/schema";
import { SearchResultItemSchema } from "../wiki/schema";
import { BrowseResponseSchema, SearchBrowseQuerySchema } from "../browse/schema";
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
        const top = scored.slice(0, topK);
        // Ensure these results are placed onto the grid and return with coordinates
        try {
          if (!Grid.isInitialized()) {
            await Grid.ensureInitialized(opts.prisma, Math.max(50, topK));
            Grid.startCleanup();
          }
          const ids = top.map((d) => d.id);
          const nodes = await Grid.ensureNodesPlacedByIds(opts.prisma, ids);
          const byId = Object.fromEntries(nodes.map((n) => [n.id, n] as const));
          const withPos = top.map((d) => ({ ...d, x: byId[d.id]?.x, y: byId[d.id]?.y }));
          return Api.success(withPos);
        } catch {
          // Fallback: return without coordinates if grid service fails
          return Api.success(top);
        }
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

        // DB-level search for best matches to ensure placement of missing docs
        const docs = await opts.prisma.document.findMany({
          select: { id: true, title: true, embedding: true },
        });
        const scored = await Promise.all(
          docs.map(async (d) => {
            let emb = (d.embedding ?? []) as number[];
            if (!emb.length) {
              emb = await generateEmbedding(d.title);
              await opts.prisma.document.update({ where: { id: d.id }, data: { embedding: emb } });
            }
            const score = cosineSim(qEmb, emb);
            return { id: d.id, title: d.title, score };
          }),
        );
        scored.sort((a, b) => b.score - a.score);
        if (scored.length === 0) return Api.success({ nodes: [], edges: [] });
        const batchIds = scored.slice(0, Math.max(1, Math.min(n, 50))).map((s) => s.id);
        const placed = await Grid.ensureNodesPlacedByIds(opts.prisma, batchIds);
        const centerId = scored[0].id;
        const around = Grid.getAround(centerId, n);
        const ids = around.map((d) => d.id);
        const edges = Grid.buildEdges(ids, k);
        const metaList = await opts.prisma.document.findMany({
          where: { id: { in: ids } },
          select: { id: true, words: true, thumbnail: true },
        });
        const metaById = Object.fromEntries(metaList.map((m) => [m.id, m] as const));
        const nodes = around.map((d) => {
          const fallbackImg = `https://picsum.photos/seed/${encodeURIComponent(d.id)}/1080/1080`;
          return {
            id: d.id,
            title: d.title,
            image: metaById[d.id]?.thumbnail ?? fallbackImg,
            words: metaById[d.id]?.words ?? 0,
            x: d.x,
            y: d.y,
            score: d.score,
            views: d.views ?? 0,
            updatedAt: d.updatedAt,
          };
        });
        return Api.success({ nodes, edges });
      },
      {
        query: SearchBrowseQuerySchema,
        response: ApiResponse(BrowseResponseSchema),
      },
    );
