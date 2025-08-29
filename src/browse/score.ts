export function trendingScore(views: number, updatedAt: Date, updatedCount: number): number {
  // Simple hotness score: views weighted by recency and edit activity
  const hours = Math.max(0, (Date.now() - updatedAt.getTime()) / 3_600_000);
  const recency = 1 / Math.pow(2 + hours, 1.2); // decay with time
  const edits = Math.log10(1 + Math.max(0, updatedCount));
  return (Math.log10(1 + Math.max(0, views)) + 0.5 * edits) * (1 + 4 * recency);
}
