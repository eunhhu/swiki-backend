import { Elysia, t } from "elysia";
import type { PrismaClient } from "@prisma/client";
import { TagType } from "@prisma/client";
import { Api } from "../api/util";
import { mkdir } from "node:fs/promises";
import { generateEmbedding } from "../embedding";
import { hashIpUa } from "../document/hash";
import { ApiResponse } from "../api/schema";
import { DocumentSummarySchema, CreateDocumentBodySchema, CreateDocumentResponseSchema, DocumentSchema, DocCreateBodySchema, DocPatchBodySchema } from "./schema";
import { flushDoc, loadDocToCache, updateCachedContent } from "../document/cache";
import { BrowseResponseSchema, BrowseQuerySchema, BrowseBoxQuerySchema } from "../browse/schema";
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
// Debounced grid update timers for REST-based content updates
const gridUpdateTimers = new Map<string, NodeJS.Timeout>();
const GRID_UPDATE_DEBOUNCE_MS = 60_000;

const asPositiveInt = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return null;
};
export const wikiRoutes = (opts: WikiRoutesOptions) =>
  new Elysia({ prefix: opts.prefix })
    /* Browse: trending via central Grid map (integer grid, stable) */
    .get(
      "/browse/trending",
      async ({ query }) => {
        const { n: nRaw, count: countRaw } = query as { n?: string | number; count?: string | number };
        const MAX_N = Number(process.env.GRID_MAX_N ?? 200);

        const requestedCount = asPositiveInt(countRaw) ?? asPositiveInt(nRaw) ?? 50;
        const n = Math.max(1, Math.min(requestedCount, MAX_N));

        const bootstrapCount = Math.max(50, n);
        if (!Grid.isInitialized()) {
          await Grid.ensureInitialized(opts.prisma, bootstrapCount);
          Grid.startCleanup();
        }

        const docs = await opts.prisma.document.findMany({
          select: {
            id: true,
            title: true,
            views: true,
            words: true,
            thumbnail: true,
            updatedAt: true,
            updatedCount: true,
          },
        });

        const ranked = docs
          .map((d) => ({
            id: d.id,
            title: d.title,
            views: d.views ?? 0,
            words: d.words ?? 0,
            thumbnail: d.thumbnail ?? null,
            updatedAt: d.updatedAt,
            score: computeTrendingScore(d.views ?? 0, d.updatedAt, d.updatedCount ?? 0),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, n);

        if (!ranked.length) return Api.success({ nodes: [] });

        const ids = ranked.map((d) => d.id);
        await Grid.ensureNodesPlacedByIds(opts.prisma, ids);
        const nodesRaw = Grid.getByIds(ids);
        const byId = new Map(nodesRaw.map((node) => [node.id, node] as const));

        const nodes = ranked.map((doc) => {
          const node = byId.get(doc.id);
          const fallbackImg = `https://picsum.photos/seed/${encodeURIComponent(doc.id)}/1080/1080`;
          return {
            id: doc.id,
            title: doc.title,
            image: doc.thumbnail ?? fallbackImg,
            words: doc.words ?? node?.words ?? 0,
            x: node?.x ?? 0,
            y: node?.y ?? 0,
            score: node?.score ?? doc.score,
            views: node?.views ?? doc.views,
            updatedAt: node?.updatedAt ?? doc.updatedAt.toISOString(),
          };
        });

        return Api.success({ nodes });
      },
      {
        query: BrowseQuerySchema,
        response: ApiResponse(BrowseResponseSchema),
      },
    )

    /* Browse: around a focused coordinate (x, y), return c docs from grid (BFS around nearest cell) */
    .get(
      "/browse/around",
      async ({ query }) => {
        const { x: xRaw, y: yRaw, c: cRaw } = query as { x?: string; y?: string; c?: string | number };
        if (typeof xRaw === "undefined" || typeof yRaw === "undefined") {
          return Api.badRequest("x and y are required");
        }
        const x = Number(xRaw), y = Number(yRaw);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return Api.badRequest("x and y must be numbers");
        }
        const MAX_C = Number(process.env.GRID_MAX_C ?? 200);
        const requestedCount = asPositiveInt(cRaw) ?? 20;
        const c = Math.max(1, Math.min(requestedCount, MAX_C));
        if (!Grid.isInitialized()) {
          await Grid.ensureInitialized(opts.prisma, Math.max(50, c));
          Grid.startCleanup();
        }
        const picked = Grid.getAroundCoord(x, y, c);
        if (!picked.length) return Api.notFound("focus coordinate not found in grid");

        const reqX = Math.round(x);
        const reqY = Math.round(y);
        const focus = picked.reduce<{ node: typeof picked[number]; dist: number } | null>((best, node) => {
          const dist = Math.abs(node.x - reqX) + Math.abs(node.y - reqY);
          if (!best) return { node, dist };
          if (dist < best.dist) return { node, dist };
          if (dist === best.dist && node.score > best.node.score) return { node, dist };
          return best;
        }, null);
        const focusNode = focus?.node ?? picked[0];
        const offsetX = reqX - focusNode.x;
        const offsetY = reqY - focusNode.y;
        const ids = picked.map((d) => d.id);
        const edges = Grid.buildEdges(ids, Math.min(4, Math.max(1, Math.floor(Math.sqrt(c)))));
        const metaList = await opts.prisma.document.findMany({
          where: { id: { in: ids } },
          select: { id: true, words: true, thumbnail: true },
        });
        const metaById = Object.fromEntries(metaList.map((m) => [m.id, m] as const));
        const nodes = picked.map((d) => {
          const fallbackImg = `https://picsum.photos/seed/${encodeURIComponent(d.id)}/1080/1080`;
          return {
            id: d.id,
            title: d.title,
            image: metaById[d.id]?.thumbnail ?? fallbackImg,
            words: metaById[d.id]?.words ?? 0,
            x: d.x + offsetX,
            y: d.y + offsetY,
            score: d.score,
            views: d.views ?? 0,
            updatedAt: d.updatedAt,
          };
        });
        return Api.success({ nodes });
      },
      {
        query: t.Object({ x: t.String(), y: t.String(), c: t.Optional(t.String()) }),
        response: ApiResponse(BrowseResponseSchema),
      },
    )

    .get(
      "/browse/box",
      async ({ query }) => {
        const { x: xRaw, y: yRaw, w: wRaw, h: hRaw } = query as {
          x?: string;
          y?: string;
          w?: string;
          h?: string;
        };
        if (
          typeof xRaw === "undefined" ||
          typeof yRaw === "undefined" ||
          typeof wRaw === "undefined" ||
          typeof hRaw === "undefined"
        ) {
          return Api.badRequest("x, y, w and h are required");
        }

        const x = Number(xRaw);
        const y = Number(yRaw);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return Api.badRequest("x and y must be numbers");
        }

        const widthParsed = asPositiveInt(wRaw);
        const heightParsed = asPositiveInt(hRaw);
        if (widthParsed === null || heightParsed === null) {
          return Api.badRequest("w and h must be positive integers");
        }

        const MAX_SPAN = Number(process.env.GRID_MAX_BOX_SPAN ?? 200);
        const MAX_RESULTS = Number(process.env.GRID_MAX_BOX_RESULTS ?? 2000);

        const width = Math.max(1, Math.min(widthParsed, MAX_SPAN));
        const height = Math.max(1, Math.min(heightParsed, MAX_SPAN));

        if (!Grid.isInitialized()) {
          const initCount = Math.max(50, Math.min(width * height, MAX_RESULTS));
          await Grid.ensureInitialized(opts.prisma, initCount);
          Grid.startCleanup();
        }

        const picked = Grid.getInBox(x, y, width, height);
        if (!picked.length) return Api.success({ nodes: [] });

        const limited = picked.slice(0, Math.min(picked.length, MAX_RESULTS));
        const ids = limited.map((d) => d.id);

        const metaList = ids.length
          ? await opts.prisma.document.findMany({
              where: { id: { in: ids } },
              select: { id: true, words: true, thumbnail: true },
            })
          : [];
        const metaById = new Map(metaList.map((m) => [m.id, m] as const));

        const nodes = limited.map((d) => {
          const fallbackImg = `https://picsum.photos/seed/${encodeURIComponent(d.id)}/1080/1080`;
          const meta = metaById.get(d.id);
          return {
            id: d.id,
            title: d.title,
            image: meta?.thumbnail ?? fallbackImg,
            words: meta?.words ?? d.words ?? 0,
            x: d.x,
            y: d.y,
            score: d.score,
            views: d.views ?? 0,
            updatedAt: d.updatedAt,
          };
        });

        return Api.success({ nodes });
      },
      {
        query: BrowseBoxQuerySchema,
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

    /* FE-aligned: create a document (title optional) */
    .post(
      "/docs",
      async ({ body }) => {
        const { title, content, tags } = (body || {}) as {
          title?: string;
          content?: unknown;
          tags?: string[];
        };
        const safeTitle = (title && title.trim()) || "Untitled";
        const embedding = await generateEmbedding(safeTitle);
        const created = await opts.prisma.document.create({
          data: {
            title: safeTitle,
            contentMd: "",
            contentJson: content as any,
            embedding,
            editable: true,
            tags: {
              connectOrCreate: (tags || []).map((tg) => ({
                where: { content: tg },
                create: { type: TagType.CUSTOM, content: tg },
              })),
            },
          } as any,
        });
        return Api.success({ id: created.id, title: created.title, content: (created as any).contentJson });
      },
      {
        body: DocCreateBodySchema,
        response: ApiResponse(DocumentSchema),
      },
    )

    /* FE-aligned: get a document detail */
    .get(
      "/docs/:id",
      async ({ params }) => {
        const { id } = params as { id: string };
        const doc = await opts.prisma.document.findUnique({ where: { id } });
        if (!doc) return Api.notFound("document not found");
        return Api.success({ id: doc.id, title: doc.title, content: (doc as any).contentJson });
      },
      {
        response: ApiResponse(DocumentSchema),
      },
    )

    /* FE-aligned: update document title and/or content (BlockNote JSON) */
    .patch(
      "/docs/:id",
      async ({ params, body }) => {
        const { id } = params as { id: string };
        const { title, content } = (body || {}) as { title?: string; content?: unknown };
        const data: any = {};
        if (typeof title === "string" && title.trim().length > 0) data.title = title.trim();
        if (typeof content !== "undefined") {
          data.contentJson = content as any;
          // lightweight word estimation from JSON text fields
          try {
            const text = JSON.stringify(content);
            const words = text ? text.split(/\s+/g).filter(Boolean).length : 0;
            data.words = words;
            data.updatedCount = { increment: 1 } as any;
          } catch {}
        }
        if (!Object.keys(data).length) return Api.badRequest("no-op");
        const updated = await opts.prisma.document.update({ where: { id }, data: data as any });
        // Schedule grid update debounced to avoid excessive recomputation
        try {
          if (gridUpdateTimers.has(id)) clearTimeout(gridUpdateTimers.get(id)!);
          gridUpdateTimers.set(
            id,
            setTimeout(async () => {
              try { await Grid.onDocFlushed(opts.prisma, id); } catch {}
              gridUpdateTimers.delete(id);
            }, GRID_UPDATE_DEBOUNCE_MS),
          );
        } catch {}
        return Api.success({ id: updated.id, title: updated.title, content: (updated as any).contentJson });
      },
      {
        body: DocPatchBodySchema,
        response: ApiResponse(DocumentSchema),
      },
    )

    /* FE-aligned: upload endpoint for images/files used by BlockNote */
    .post(
      "/uploads",
      async ({ request }) => {
        try {
          const form = await request.formData();
          const file = form.get("file");
          if (!file || typeof file === "string") {
            return Api.badRequest("file is required");
          }
          const original = (file as any).name || "upload.bin";
          const safeName = `${Date.now()}_${original.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
          const dir = "public/uploads";
          await mkdir(dir, { recursive: true });
          await Bun.write(`${dir}/${safeName}`, file as any);
          // build absolute URL from request origin
          const origin = new URL(request.url).origin;
          const url = `${origin}/uploads/${safeName}`;
          return Api.success({ url });
        } catch (e) {
          return Api.internalServerError(String(e));
        }
      },
      {
        response: ApiResponse(t.Object({ url: t.String() })),
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
