/**
 * Shared formatting helpers for consistent count and truncation phrasing.
 *
 * Standard phrases:
 *   count: N                                — simple count
 *   count: N of T total                     — when total is known
 *   count: N (showing first N)              — when truncated by limit
 */
export interface CountOptions {
  count: number;
  limit?: number;
  totalCount?: number | null;
  displayLimit?: number;
}

export function formatCountLine(opts: CountOptions): string {
  const { count, limit, totalCount, displayLimit } = opts;
  // Total count known from API headers
  if (totalCount !== undefined && totalCount !== null) {
    return `count: ${count} of ${totalCount} total`;
  }
  // Display limit truncation (e.g. search showing first N of results)
  if (displayLimit !== undefined && count > displayLimit) {
    return `count: ${count} (showing first ${displayLimit})`;
  }
  // Hit the request limit — results may be truncated
  if (limit !== undefined && count === limit && count > 0) {
    return `count: ${count} (showing first ${count})`;
  }
  // Simple count
  return `count: ${count}`;
}
