import { t } from "elysia";

export const DocumentSummarySchema = t.Object({
  id: t.String(),
  title: t.String(),
  views: t.Optional(t.Number()),
  updatedAt: t.Optional(t.String({ format: "date-time" })),
});

export const DocumentSchema = t.Intersect([
  DocumentSummarySchema,
  t.Object({
    // BlockNote JSON structure (kept as Any to avoid tight coupling)
    content: t.Optional(t.Any()),
    updatedCount: t.Optional(t.Number()),
  }),
]);

export const CreateDocumentBodySchema = t.Object({
  title: t.String({ minLength: 1 }),
  tags: t.Array(t.String(), { default: [] }),
});

export const CreateDocumentResponseSchema = t.Object({ id: t.String() });

// More flexible bodies used by FE `/wiki/docs` endpoints
export const DocCreateBodySchema = t.Object({
  title: t.Optional(t.String({ minLength: 1 })),
  content: t.Optional(t.Any()),
  tags: t.Optional(t.Array(t.String())),
});

export const DocPatchBodySchema = t.Object({
  title: t.Optional(t.String({ minLength: 1 })),
  content: t.Optional(t.Any()),
});

export const SearchResultItemSchema = t.Intersect([
  DocumentSummarySchema,
  t.Object({
    score: t.Number(),
    x: t.Optional(t.Integer()),
    y: t.Optional(t.Integer()),
  }),
]);
