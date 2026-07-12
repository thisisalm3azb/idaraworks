/**
 * Retry schedule for the upload path (S0 checklist §6 item 6: "retry").
 * Pure and unit-tested; the hook consumes it.
 */
export const MAX_UPLOAD_ATTEMPTS = 3;

/** Delay in ms before retry attempt N (1-based). Exponential, capped. */
export function retryDelayMs(attempt: number): number {
  if (attempt < 1) throw new Error("attempt is 1-based");
  return Math.min(1000 * 2 ** (attempt - 1), 8000); // 1s, 2s, 4s, (cap 8s)
}

export function shouldRetry(attempt: number): boolean {
  return attempt < MAX_UPLOAD_ATTEMPTS;
}
