export function getRequiredEnv(name: string, devFallback?: string): string {
  const value = process.env[name] || '';
  const isProd = process.env.NODE_ENV === 'production';
  if (!value) {
    if (isProd) throw new Error(`Missing required env: ${name}`);
    if (devFallback !== undefined) return devFallback;
  }
  return value;
}
