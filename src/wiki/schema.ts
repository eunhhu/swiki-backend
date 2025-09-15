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
    content: t.String(),
    updatedCount: t.Optional(t.Number()),
  }),
]);

export const CreateDocumentBodySchema = t.Object({
  title: t.String({ minLength: 1 }),
  tags: t.Array(t.String(), { default: [] }),
});

export const CreateDocumentResponseSchema = t.Object({ id: t.String() });

export const SearchResultItemSchema = t.Intersect([
  DocumentSummarySchema,
  t.Object({
    score: t.Number(),
    x: t.Optional(t.Integer()),
    y: t.Optional(t.Integer()),
  }),
]);
