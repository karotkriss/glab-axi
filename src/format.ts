export interface CountLineOptions {
  count: number;
  limit?: number;
  totalCount?: number;
  displayLimit?: number;
}

/**
 * Build a definitive count line. Prefers a true total when known, else signals
 * that only the first page is shown so the agent knows there may be more.
 */
export function formatCountLine(opts: CountLineOptions): string {
  const { count, limit, totalCount, displayLimit } = opts;
  if (totalCount != null) return `count: ${count} of ${totalCount} total`;
  if (displayLimit !== undefined && count > displayLimit) {
    return `count: ${count} (showing first ${displayLimit})`;
  }
  if (limit !== undefined && count === limit && count > 0) {
    return `count: ${count} (showing first ${count})`;
  }
  return `count: ${count}`;
}
