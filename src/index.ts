import cookie from "@elysiajs/cookie";
import cors from "@elysiajs/cors";
import staticPlugin from "@elysiajs/static";
import swagger from "@elysiajs/swagger";
import { PrismaClient } from "@prisma/client";
import { Elysia } from "elysia";
import { authRoutes } from "./auth/route";
import { wikiRoutes } from "./wiki/route";
import { searchRoutes } from "./search/route";
import { Api } from "./api/util";
import { securityHeaders } from "./middleware/securityHeaders";
import { requestLogger } from "./middleware/requestLogger";
import { Logger } from "./logger";
import { rateLimitPlugin } from "./middleware/rateLimit";

const prisma = new PrismaClient();

prisma.$connect().then(() => {
  console.log('Connected to database');
}).catch((e: Error) => {
  console.error('Failed to connect to database', e);
});

const PORT = Number(process.env.PORT ?? 8000);

const app = new Elysia();

// Plugins
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(",") || ["http://localhost:3000", `http://localhost:${PORT}`],
  credentials: true,
}));
app.use(cookie());
// Global rate limiting
app.use(rateLimitPlugin({
  windowMs: 60_000,
  max: 100,
  keyPrefix: 'global',
  skip: (ctx) => {
    const p = new URL(ctx.request.url).pathname;
    if (p === '/health' || p === '/') return true;
    if (p.startsWith('/docs') || p.startsWith('/swagger')) return true;
    if (p.startsWith('/public') || p.startsWith('/assets') || p === '/favicon.ico') return true;
    return false;
  }
}));

// Security & Observability
app.use(securityHeaders());
app.use(requestLogger());

// Enable Swagger only in non-production
if (process.env.NODE_ENV !== 'production') {
  app.use(swagger());
}

app
  .use(staticPlugin({
    assets: "public",
    prefix: "",
  }))
  // Routes
  .get("/", ({redirect}) => redirect("/health"))
  .get("/health", () => "OK")
  .use(authRoutes({ prisma, prefix: "/auth" }))
  .use(wikiRoutes({ prisma, prefix: "/wiki" }))
  .use(searchRoutes({ prisma }))
  // Error handling
  .onError(({ error, set, request }) => {
    // structured error log
    try { void Logger.error('unhandled', { path: new URL(request.url).pathname, error: String(error) }); } catch {}
    set.status = 500;
    return Api.internalServerError(error);
  })

try {
  const started = app.listen(PORT, () => {
    console.log("Server is running on *:" + PORT.toString());
  });
  console.log(`Server listening on http://localhost:${PORT}`);
} catch (e) {
  console.error(`Failed to start server. Is port ${PORT} in use?`, e);
  process.exit(1);
}

// export default app;