import { t } from "elysia";

export const BrowseNodeSchema = t.Object({
  id: t.String(),
  title: t.String(),
  x: t.Number(),
  y: t.Number(),
  score: t.Number(),
  views: t.Optional(t.Number()),
  updatedAt: t.Optional(t.String({ format: "date-time" })),
});

export const BrowseEdgeSchema = t.Object({
  source: t.String(),
  target: t.String(),
  distance: t.Number(),
});

export const BrowseResponseSchema = t.Object({
  nodes: t.Array(BrowseNodeSchema),
  edges: t.Array(BrowseEdgeSchema),
});

export const BrowseQuerySchema = t.Object({
  n: t.Optional(t.String()),
  k: t.Optional(t.String()),
});

export const SearchBrowseQuerySchema = t.Object({
  q: t.String(),
  n: t.Optional(t.String()),
  k: t.Optional(t.String()),
});
