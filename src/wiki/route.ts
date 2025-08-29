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
    /* Browse: trending with 2D layout */
    .get(
      "/browse/trending",
      async ({ query }) => {
        const { n: nRaw, k: kRaw } = query as { n?: string; k?: string };
        const n = Number(nRaw ?? 50);
        const k = Number(kRaw ?? 4);

        const docs = await opts.prisma.document.findMany({
          select: {
            id: true,
            title: true,
            views: true,
            updatedAt: true,
            updatedCount: true,
            embedding: true,
          },
        });

        const scored = docs
          .map((d) => ({
            ...d,
            score: computeTrendingScore(d.views ?? 0, d.updatedAt, d.updatedCount ?? 0),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.max(0, n));

        const withEmbeddings = await Promise.all(
          scored.map(async (d) => {
            let emb = (d.embedding as unknown as number[]) ?? [];
            if (!Array.isArray(emb) || emb.length === 0) {
              emb = await generateEmbedding(d.title);
              await opts.prisma.document.update({ where: { id: d.id }, data: { embedding: emb } });
            }
            return { ...d, emb };
          }),
        );

        const ids = withEmbeddings.map((d) => d.id);
        const embs = withEmbeddings.map((d) => d.emb as number[]);
        const { coords } = projectTo2D(embs);
        const nodes = withEmbeddings.map((d, i) => ({
          id: d.id,
          title: d.title,
          x: coords[i]?.x ?? 0,
          y: coords[i]?.y ?? 0,
          score: d.score,
          views: d.views,
          updatedAt: d.updatedAt.toISOString(),
        }));
        const edges = buildKnnEdges(
          ids,
          embs,
          Math.max(1, Math.min(k, Math.max(0, ids.length - 1))),
        );
        return Api.success({ nodes, edges });
      },
      {
        query: BrowseQuerySchema,
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
