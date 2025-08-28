import Elysia from 'elysia';

export const securityHeaders = () =>
  new Elysia().onRequest(({ set, request }) => {
    set.headers['X-Content-Type-Options'] = 'nosniff';
    set.headers['X-Frame-Options'] = 'DENY';
    set.headers['X-XSS-Protection'] = '1; mode=block';
    set.headers['Referrer-Policy'] = 'no-referrer';
    set.headers['Permissions-Policy'] = 'geolocation=()';

    const isProd = process.env.NODE_ENV === 'production';
    const path = new URL(request.url).pathname;

    // Base strict policy
    const cspBase = [
      "default-src 'none'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ];

    // Relax CSP for Swagger UI only in non-production to allow CDN assets
    if (!isProd && path.startsWith('/swagger')) {
      // allow jsDelivr for swagger scalar assets
      const relax = [
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        "img-src 'self' data: https://cdn.jsdelivr.net",
        "font-src 'self' data: https://cdn.jsdelivr.net",
      ];
      // replace the base entries for script/style
      const adjusted = cspBase
        .filter((d) => !d.startsWith('script-src') && !d.startsWith('style-src') && !d.startsWith('img-src') && !d.startsWith('font-src'))
        .concat(relax);
      set.headers['Content-Security-Policy'] = adjusted.join('; ');
    } else {
      set.headers['Content-Security-Policy'] = cspBase.join('; ');
    }

    if (isProd) {
      set.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
    }
  });
