export const RUN_START_TIMEOUT_MS = 15_000;

type RunStartupSnapshot = {
  status: string;
  createdAt: number;
  latestStage: string | null;
  lastEventId: number;
  progress: { totalCount: number };
  tasks: unknown[];
};

const terminalStatuses = new Set([
  "completed",
  "partial_failed",
  "failed",
  "cancelled",
]);

export function hasRunStarted(snapshot: RunStartupSnapshot) {
  return terminalStatuses.has(snapshot.status) ||
    snapshot.latestStage !== null ||
    snapshot.lastEventId > 0 ||
    snapshot.tasks.length > 0 ||
    snapshot.progress.totalCount > 0;
}

/**
 * Detects only a run whose executor never started. Slow Agent inference is not
 * timed out once the first progress event or coordinator task is observable.
 */
export function isRunStartStalled(
  snapshot: RunStartupSnapshot,
  now = Date.now(),
  timeoutMs = RUN_START_TIMEOUT_MS,
) {
  if (hasRunStarted(snapshot)) return false;
  return now - snapshot.createdAt >= timeoutMs;
}
