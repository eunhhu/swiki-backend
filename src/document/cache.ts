import type { PrismaClient } from "@prisma/client";

export interface CachedDoc {
  content: string;
  updatedCount: number;
  dirty: boolean;
}

// In-memory cache for documents currently being edited.
const docCache = new Map<string, CachedDoc>();

export function getCachedDoc(id: string): CachedDoc | undefined {
  return docCache.get(id);
}

export async function loadDocToCache(id: string, prisma: PrismaClient): Promise<CachedDoc | null> {
  let cached = docCache.get(id);
  if (cached) return cached;
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) return null;
  cached = { content: doc.contentMd, updatedCount: doc.updatedCount, dirty: false };
  docCache.set(id, cached);
  return cached;
}

export function updateCachedContent(id: string, newContent: string) {
  const c = docCache.get(id);
  if (c) {
    if (c.content !== newContent) {
      c.content = newContent;
      c.updatedCount += 1;
      c.dirty = true;
    }
  } else {
    docCache.set(id, { content: newContent, updatedCount: 1, dirty: true });
  }
}

export async function flushDoc(id: string, prisma: PrismaClient, writenBy: string) {
  const cached = docCache.get(id);
  if (!cached) return;
  if (!cached.dirty) { // no change
    docCache.delete(id);
    return;
  }
  await prisma.$transaction([
    prisma.history.create({
      data: {
        contentMd: cached.content,
        documentId: id,
        writenBy,
      },
    }),
    prisma.document.update({
      where: { id },
      data: {
        contentMd: cached.content,
        updatedCount: cached.updatedCount,
      },
    }),
  ]);
  docCache.delete(id);
}
