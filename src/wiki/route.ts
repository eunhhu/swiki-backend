import { Elysia, t } from "elysia";
import type { PrismaClient } from "@prisma/client";
import { TagType } from "@prisma/client";
import { Api } from "../api/util";
import { generateEmbedding } from "../embedding";
import { hashIpUa } from "../document/hash";
import { ApiResponse } from "../api/schema";
import { DocumentSummarySchema, CreateDocumentBodySchema, CreateDocumentResponseSchema } from "./schema";
import { flushDoc, loadDocToCache, updateCachedContent } from "../document/cache";
import { BrowseResponseSchema, BrowseQuerySchema } from "../browse/schema";
import { projectTo2D, buildKnnEdges } from "../browse/layout";
import { Grid } from "../browse/grid";
import { trendingScore as computeTrendingScore } from "../browse/score";

interface WikiRoutesOptions {
  prisma: PrismaClient;
  prefix?: string;
}

// Active connection count per document to decide when to flush
const activeConnections = new Map<string, number>();
// schedule flush when last user disconnects
const flushTimers = new Map<string, NodeJS.Timeout>();
// author based flush rate limit (ms)
const authorLastFlush = new Map<string, number>();
// presence per document
const docPresence = new Map<string, Map<string, { color: string }>>();
const GRACE_MS = 5 * 60_000; // 5 minutes
const FLUSH_RATE_MS = 60_000;

export const wikiRoutes = (opts: WikiRoutesOptions) =>
  new Elysia({ prefix: opts.prefix })
    /* Browse: trending via central Grid map (integer grid, stable) */
    .get(
      "/browse/trending",
      async ({ query }) => {
        const { n: nRaw, k: kRaw } = query as { n?: string; k?: string };
        const n = Number(nRaw ?? 50);
        const k = Number(kRaw ?? 4);

        if (!Grid.isInitialized()) {
          await Grid.ensureInitialized(opts.prisma, n);
          Grid.startCleanup();
        }

        const nodesRaw = Grid.getNodes(n);
        const ids = nodesRaw.map((d) => d.id);
        const edges = Grid.buildEdges(ids, k);
        const nodes = nodesRaw.map((d) => ({
          id: d.id,
          title: d.title,
          x: d.x,
          y: d.y,
          score: d.score,
          views: d.views,
          updatedAt: d.updatedAt,
        }));
        return Api.success({ nodes, edges });
      },
      {
        query: BrowseQuerySchema,
        response: ApiResponse(BrowseResponseSchema),
      },
    )

    /* Browse: around a focused document id, return c docs from grid (BFS around) */
    .get(
      "/browse/around/:id",
      async ({ params, query }) => {
        const { id } = params as { id: string };
        const c = Number((query as any)?.c ?? 20);
        if (!Grid.isInitialized()) {
          await Grid.ensureInitialized(opts.prisma, Math.max(50, c));
          Grid.startCleanup();
        }
        const picked = Grid.getAround(id, c);
        const ids = picked.map((d) => d.id);
        const edges = Grid.buildEdges(ids, Math.min(4, Math.max(1, Math.floor(Math.sqrt(c)))));
        const nodes = picked.map((d) => ({ id: d.id, title: d.title, x: d.x, y: d.y, score: d.score, views: d.views, updatedAt: d.updatedAt }));
        return Api.success({ nodes, edges });
      },
      {
        query: t.Object({ c: t.Optional(t.String()) }),
        response: ApiResponse(BrowseResponseSchema),
      },
    )

    /* Create new document */
    .post(
      "/documents",
      async ({ body }) => {
        const { title, tags } = body as { title: string; tags: string[] };
        const embedding = await generateEmbedding(title);
        const doc = await opts.prisma.document.create({
          data: {
            title,
            contentMd: "",
            embedding,
            editable: true,
            tags: {
              connectOrCreate: (tags || []).map((tg) => ({
                where: { content: tg },
                create: { type: TagType.CUSTOM, content: tg },
              })),
            },
          },
          select: { id: true },
        });
        return Api.success(doc);
      },
      {
        body: CreateDocumentBodySchema,
        response: ApiResponse(CreateDocumentResponseSchema),
      },
    )

    /* Collaborative editing websocket */

    .ws("/ws/doc/:id", {
      // schema intentionally omitted for brevity
      async open(ws: any) {
        const { params, headers } = ws.data as any;
        const docId = params.id as string;
        // cancel pending flush if any (someone rejoined within grace period)
        if (flushTimers.has(docId)) {
          clearTimeout(flushTimers.get(docId)!);
          flushTimers.delete(docId);
        }
        // increment views once per connection
        await opts.prisma.document.update({ where: { id: docId }, data: { views: { increment: 1 } } });

        // active count
        activeConnections.set(docId, (activeConnections.get(docId) ?? 0) + 1);

        // join room for broadcasting
        ws.subscribe(docId);

        // load doc content and send to client
        const cached = await loadDocToCache(docId, opts.prisma);
        if (cached) ws.send(JSON.stringify({ type: "init", content: cached.content }));
      },

      message(ws: any, raw: unknown) {
        const { params } = ws.data as any;
        const message = raw;
        let parsed: any;
        try {
          parsed = JSON.parse(String(message));
        } catch {
          return;
        }
        const docId = params.id as string;
        if (parsed.type === "edit" && typeof parsed.content === "string") {
          updateCachedContent(docId, parsed.content); // mark dirty
          // broadcast new content to others
          ws.publish(docId, JSON.stringify({ type: "content", content: parsed.content }));
        } else if (parsed.type === "join" && typeof parsed.userId === "string") {
          const users = docPresence.get(docId) ?? new Map();
          users.set(parsed.userId, { color: parsed.color ?? "#000" });
          docPresence.set(docId, users);
          // send current presence list to new user
          ws.send(JSON.stringify({ type: "presence", users: Array.from(users.entries()).map(([id,v])=>({id,color:v.color})) }));
          // notify others
          ws.publish(docId, JSON.stringify({ type: "user_join", userId: parsed.userId, color: parsed.color }));
        } else if (parsed.type === "cursor") {
          ws.publish(docId, JSON.stringify({ type: "cursor", cursor: parsed.cursor }));
        }
      },

      async close(ws: any, code: number, reason: string) {
        const { params, headers, request } = ws.data as any;
        const docId = params.id as string;
        const ip = (headers["x-forwarded-for"] || request.headers.get("x-forwarded-for")) as string | undefined;
        const ua = headers["user-agent"] as string | undefined;
        const author = hashIpUa(ip, ua);

        // decrement active count and flush if 0
        const cnt = (activeConnections.get(docId) ?? 1) - 1;
        if (cnt <= 0) {
          // remove presence map
          docPresence.delete(docId);
          // schedule flush with grace period
          if (flushTimers.has(docId)) clearTimeout(flushTimers.get(docId)!);
          flushTimers.set(
            docId,
            setTimeout(async () => {
              const last = authorLastFlush.get(author) ?? 0;
              if (Date.now() - last < FLUSH_RATE_MS) {
                return; // rate limited
              }
              await flushDoc(docId, opts.prisma, author);
              // Update grid embedding for this document, keep position stable
              try {
                await Grid.onDocFlushed(opts.prisma, docId);
              } catch {}
              authorLastFlush.set(author, Date.now());
              flushTimers.delete(docId);
            }, GRACE_MS),
          );
          activeConnections.delete(docId);
        } else {
          activeConnections.set(docId, cnt);
          // remove user from presence and broadcast leave
          const users = docPresence.get(docId);
          if (users) {
            users.delete(author);
            ws.publish(docId, JSON.stringify({ type: "user_leave", userId: author }));
          }
        }
      },
    });
