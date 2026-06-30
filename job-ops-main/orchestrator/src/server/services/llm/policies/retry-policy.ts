export function shouldRetryAttempt(args: {
  message: string;
  status?: number;
}): boolean {
  return (
    args.message.includes("parse") ||
    args.status === 429 ||
    (args.status !== undefined && args.status >= 500 && args.status <= 599) ||
    args.message.toLowerCase().includes("timeout") ||
    args.message.toLowerCase().includes("timed out") ||
    args.message.toLowerCase().includes("fetch failed")
  );
}

export function getRetryDelayMs(baseDelayMs: number, attempt: number): number {
  const delay = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 0.5 * delay;
  return Math.round(delay + jitter);
}
