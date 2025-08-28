import Elysia from 'elysia';
import { Logger } from '../logger';

export const requestLogger = () =>
  new Elysia()
    .derive(({ request, headers }) => {
      const start = Date.now();
      const url = new URL(request.url);
      const ip = headers['x-forwarded-for'] || headers['x-real-ip'] || '';
      return { __start: start, __path: url.pathname, __ip: ip };
    })
    .onAfterHandle(async (ctx) => {
      // derived values
      const ms = Date.now() - (ctx as any).__start;
      const status = ctx.set.status || 200;
      const method = ctx.request.method;
      const path = (ctx as any).__path as string;
      const ip = (ctx as any).__ip as string;
      const userId = (ctx as any)?.accessPayload?.id as string | undefined;
      const meta = { method, path, status, ms, ip, userId };
      if (ctx.error) {
        await Logger.error('request', { ...meta, error: String(ctx.error) });
      } else {
        await Logger.info('request', meta);
      }
    })
    .onError(async ({ request, set, error }) => {
      const url = new URL(request.url);
      await Logger.error('onError', {
        method: request.method,
        path: url.pathname,
        status: set.status || 500,
        error: String(error),
      });
    });
