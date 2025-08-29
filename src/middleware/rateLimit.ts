import type { Elysia, Context } from 'elysia';
import { Api } from '../api/util';
import { hashIpUa } from '../document/hash';

interface RateLimitOptions {
  windowMs: number; // time window in ms
  max: number; // max requests per window per key
  keyPrefix?: string;
  headers?: boolean;
  keyGenerator?: (ctx: Context) => string;
  skip?: (ctx: Context) => boolean;
}

interface Bucket {
  count: number;
  resetAt: number; // timestamp
}

const store = new Map<string, Bucket>();

function now() {
  return Date.now();
}

function getKey(ctx: Context, opts: RateLimitOptions) {
  const url = new URL(ctx.request.url);
  const ua = (ctx.headers['user-agent'] || ctx.request.headers.get('user-agent') || '') as string;
  // Prefer server-provided connection info if available in deployment; fallback to proxy headers.
  const ip = (ctx.request.headers.get('x-forwarded-for') || ctx.request.headers.get('x-real-ip') || '') as string;
  const h = hashIpUa(ip, ua);
  return `${opts.keyPrefix || 'rl'}:${h}:${url.pathname}`;
}

function setHeaders(ctx: Context, opts: RateLimitOptions, bucket: Bucket) {
  if (!opts.headers) return;
  const retryAfter = Math.max(0, Math.ceil((bucket.resetAt - now()) / 1000));
  ctx.set.headers['X-RateLimit-Limit'] = String(opts.max);
  ctx.set.headers['X-RateLimit-Remaining'] = String(Math.max(0, opts.max - bucket.count));
  ctx.set.headers['X-RateLimit-Reset'] = String(Math.ceil(bucket.resetAt / 1000));
  if (bucket.count > opts.max) ctx.set.headers['Retry-After'] = String(retryAfter);
}

async function checkAndConsume(ctx: Context, opts: RateLimitOptions) {
  if (opts.skip && opts.skip(ctx)) return true;
  const key = opts.keyGenerator ? opts.keyGenerator(ctx) : getKey(ctx, opts);
  const ts = now();
  const bucket = store.get(key) || { count: 0, resetAt: ts + opts.windowMs };
  if (ts > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = ts + opts.windowMs;
  }
  bucket.count += 1;
  store.set(key, bucket);
  setHeaders(ctx, opts, bucket);
  if (bucket.count > opts.max) {
    ctx.set.status = 429;
    return false;
  }
  return true;
}

export const rateLimitPlugin = (opts: RateLimitOptions) => (app: Elysia) =>
  app.onBeforeHandle(async (ctx) => {
    const allowed = await checkAndConsume(ctx, { headers: true, ...opts });
    if (!allowed) return Api.tooManyRequests();
  });

export const rateLimitGuard = (opts: RateLimitOptions) => {
  const handler = async (ctx: Context) => {
    const allowed = await checkAndConsume(ctx, { headers: true, ...opts });
    if (!allowed) return Api.tooManyRequests();
  };
  return { beforeHandle: handler, onBeforeHandle: handler };
};
