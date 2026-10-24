// Periodically creates "overdue" notifications. Safe to run as often as you like: each item is notified once.
import type { Clock, WorkRepo } from './workTypes.ts';
import type { Logger } from './ports.ts';

export async function runSweepOnce(work: WorkRepo, clock: Clock, logger: Logger): Promise<number> {
  try {
    return await work.sweepOverdue(clock.today());
  } catch (err) {
    logger.error('overdue_sweep_failed', err);   // never crashes the server; the next run tries again
    return 0;
  }
}

/** Starts the periodic sweep. Returns a function that stops it. */
export function startSweeper(work: WorkRepo, clock: Clock, logger: Logger, everyMs = 15 * 60_000): () => void {
  const first = setTimeout(() => void runSweepOnce(work, clock, logger), 30_000);
  const timer = setInterval(() => void runSweepOnce(work, clock, logger), everyMs);
  first.unref?.(); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
