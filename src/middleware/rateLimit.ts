import type { Elysia, Context } from 'elysia';
import { Api } from '../api/util';

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
  const ip = (ctx.headers['x-forwarded-for'] || ctx.headers['x-real-ip'] || '') as string;
  const base = `${ip || 'ip:unknown'}:${url.pathname}`;
  return `${opts.keyPrefix || 'rl'}:${base}`;
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

export const rateLimitGuard = (opts: RateLimitOptions) => ({
  async onBeforeHandle(ctx: Context) {
    const allowed = await checkAndConsume(ctx, { headers: true, ...opts });
    if (!allowed) return Api.tooManyRequests();
  },
});
