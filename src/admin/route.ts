import { Elysia, t } from "elysia";
import type { PrismaClient } from "@prisma/client";
import { Api } from "../api/util";
import { ApiResponse } from "../api/schema";
import { Grid } from "../browse/grid";

interface AdminRoutesOptions {
  prisma: PrismaClient;
  prefix?: string;
}

const MetricsSchema = t.Object({
  total: t.Number(),
  placedOrder: t.Number(),
  removedCount: t.Number(),
  lastSaveTs: t.Optional(t.Number()),
  placement: t.String(),
  persistPath: t.Optional(t.String()),
});

export const adminRoutes = (opts: AdminRoutesOptions) =>
  new Elysia({ prefix: opts.prefix })
    .get(
      "/grid/metrics",
      ({ request }) => {
        const expected = process.env.ADMIN_TOKEN || (process.env.NODE_ENV !== "production" ? "dev-admin-token" : "");
        const token = request.headers.get("x-admin-token") || "";
        if (!expected || token !== expected) return Api.unauthorized("invalid admin token");
        return Api.success(Grid.getMetrics());
      },
      {
        response: ApiResponse(MetricsSchema),
      },
    );
