import { sanitizeSensitiveText } from "./data-loss-prevention.ts";
import type {
  OrchestrationProgressEvent,
  RunMode,
} from "./orchestrator.ts";
import {
  requestCoordinator,
  type RequestStatus,
  type TaskSnapshot,
} from "./request-coordinator.ts";

const terminalStatuses = new Set<RequestStatus>([
  "completed",
  "partial_failed",
  "failed",
  "cancelled",
]);

const publicBlockedKeys = new Set([
  "query",
  "rawQuery",
  "minimalQuery",
  "question",
  "prompt",
  "rawCorpus",
  "corpus",
  "sourceText",
]);

export type PublicRunEvent = {
  id: number;
  type: "progress" | "completed" | "failed" | "cancelled";
  createdAt: number;
  data: Record<string, unknown>;
};

export type PublicRunTask = Pick<
  TaskSnapshot,
  "taskId" | "kind" | "assignee" | "required" | "status" | "createdAt" | "updatedAt" | "startedAt" | "completedAt"
> & {
  queuePosition: number | null;
  waitingMs: number;
};

export type PublicRunSnapshot = {
  requestId: string;
  mode: RunMode;
  status: RequestStatus;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  version: number;
  latestStage: string | null;
  lastEventId: number;
  progress: {
    totalCount: number;
    terminalCount: number;
    remainingCount: number;
  };
  tasks: PublicRunTask[];
  result?: unknown;
  errorCode?: "EXECUTION_FAILED" | "CANCELLED";
};

export type StartRunInput = {
  query: string;
  mode: RunMode;
  commercialJudge: boolean;
  idempotencyKey?: string;
};

type RunExecutor = (
  input: StartRunInput & { requestId: string },
  report: (event: OrchestrationProgressEvent) => void,
  signal: AbortSignal,
) => Promise<unknown>;

type StoredRun = {
  requestId: string;
  coordinatorRequestId: string | null;
  mode: RunMode;
  status: RequestStatus;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  version: number;
  latestStage: string | null;
  lastEventId: number;
  progress: PublicRunSnapshot["progress"];
  result?: unknown;
  errorCode?: PublicRunSnapshot["errorCode"];
  controller: AbortController;
  events: PublicRunEvent[];
  listeners: Set<(event: PublicRunEvent) => void>;
  execution: Promise<void> | null;
};

type IdempotencyEntry = {
  requestId: string;
  fingerprint: string;
};

export class RunRegistryError extends Error {
  readonly code: "RUN_NOT_FOUND" | "IDEMPOTENCY_CONFLICT" | "INVALID_IDEMPOTENCY_KEY";

  constructor(
    code: "RUN_NOT_FOUND" | "IDEMPOTENCY_CONFLICT" | "INVALID_IDEMPOTENCY_KEY",
    message: string,
  ) {
    super(message);
    this.name = "RunRegistryError";
    this.code = code;
  }
}

export type RunRegistryOptions = {
  clock?: () => number;
  idFactory?: () => string;
  executor?: RunExecutor;
  ttlMs?: number;
  maxRuns?: number;
  maxEventsPerRun?: number;
};

async function defaultExecutor(
  input: StartRunInput & { requestId: string },
  report: (event: OrchestrationProgressEvent) => void,
  signal: AbortSignal,
) {
  const { orchestrate } = await import("./orchestrator.ts");
  return orchestrate(
    input.query,
    input.mode,
    input.commercialJudge,
    report,
    signal,
    input.requestId,
  );
}

function safeIdentifier() {
  return `RUN-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The public run APIs never retain or return the input query, prompts, raw
 * corpus fields, or unmasked sensitive strings. This is intentionally applied
 * again even though the Edge contract already performs DLP.
 */
function sanitizeForPublic(value: unknown): unknown {
  if (typeof value === "string") return sanitizeSensitiveText(value).sanitized;
  if (Array.isArray(value)) return value.map(sanitizeForPublic);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !publicBlockedKeys.has(key))
      .map(([key, item]) => [key, sanitizeForPublic(item)]),
  );
}

function safeRouterDecision(value: OrchestrationProgressEvent["routerDecision"]) {
  if (!value) return undefined;
  return {
    version: value.version,
    strategy: value.strategy,
    securityLevel: value.securityLevel,
    purpose: value.purpose,
    primaryAgent: value.primaryAgent,
    candidateAgents: [...value.candidateAgents],
    required: [...value.required],
    selected: [...value.selected],
    supportingAgents: [...value.supportingAgents],
    requiredConcepts: value.requiredConcepts.map((concept) => ({
      id: concept.id,
      label: concept.label,
      owner: concept.owner,
      aliases: [],
    })),
    predictedCoverage: value.predictedCoverage,
    objectiveCost: value.objectiveCost,
    adaptiveAdditions: [...value.adaptiveAdditions],
    humanReviewRequired: value.humanReviewRequired,
    rationale: ["Boundary constraint, evidence coverage, and execution cost were evaluated."],
    primarySelection: value.primarySelection
      ? {
          algorithm: value.primarySelection.algorithm,
          hardGate: {
            applied: value.primarySelection.hardGate.applied,
            forcedAgent: value.primarySelection.hardGate.forcedAgent,
            reasons: [...value.primarySelection.hardGate.reasons],
          },
          rankedCandidates: value.primarySelection.rankedCandidates.map((candidate) => ({
            agentId: candidate.agentId,
            rank: candidate.rank,
            totalScore: candidate.totalScore,
            components: { ...candidate.components },
          })),
          confidence: value.primarySelection.confidence,
          top1Top2Margin: value.primarySelection.top1Top2Margin,
          decisionThreshold: value.primarySelection.decisionThreshold,
          fallbackUsed: value.primarySelection.fallbackUsed,
          fallbackReason: value.primarySelection.fallbackReason,
          reviewReasons: [...value.primarySelection.reviewReasons],
        }
      : undefined,
  };
}

function safeProgressEvent(event: OrchestrationProgressEvent) {
  return sanitizeForPublic({
    runId: event.runId,
    mode: event.mode,
    stage: event.stage,
    message: event.message,
    timestamp: event.timestamp,
    sequence: event.sequence,
    agentId: event.agentId,
    agentName: event.agentName,
    selectedAgents: event.selectedAgents,
    executionRole: event.executionRole,
    routerDecision: safeRouterDecision(event.routerDecision),
    evidencePlan: event.evidencePlan,
    evidenceCount: event.evidenceCount,
    backend: event.backend,
    model: event.model,
    execution: event.execution,
  }) as Record<string, unknown>;
}

async function fingerprint(input: StartRunInput) {
  const payload = JSON.stringify({
    query: input.query,
    mode: input.mode,
    commercialJudge: input.commercialJudge,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function eventIsTerminal(event: PublicRunEvent) {
  return event.type === "completed" || event.type === "failed" || event.type === "cancelled";
}

export class RunRegistry {
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly executor: RunExecutor;
  private readonly ttlMs: number;
  private readonly maxRuns: number;
  private readonly maxEventsPerRun: number;
  private readonly runs = new Map<string, StoredRun>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();

  constructor(options: RunRegistryOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? safeIdentifier;
    this.executor = options.executor ?? defaultExecutor;
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    this.maxRuns = options.maxRuns ?? 200;
    this.maxEventsPerRun = options.maxEventsPerRun ?? 250;
  }

  async start(
    input: StartRunInput,
    registerLifetime?: (execution: Promise<void>) => void,
  ): Promise<{ requestId: string; reused: boolean }> {
    this.prune();
    const idempotencyKey = input.idempotencyKey?.trim();
    if (idempotencyKey && !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)) {
      throw new RunRegistryError(
        "INVALID_IDEMPOTENCY_KEY",
        "Idempotency-Key must be 8-128 safe ASCII characters.",
      );
    }
    const requestFingerprint = await fingerprint(input);
    if (idempotencyKey) {
      const existing = this.idempotency.get(idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== requestFingerprint) {
          throw new RunRegistryError(
            "IDEMPOTENCY_CONFLICT",
            "The idempotency key was already used with a different request.",
          );
        }
        const existingRun = this.runs.get(existing.requestId);
        if (existingRun) {
          if (existingRun.execution) registerLifetime?.(existingRun.execution);
          return { requestId: existing.requestId, reused: true };
        }
        this.idempotency.delete(idempotencyKey);
      }
    }

    const requestId = this.idFactory();
    const now = this.clock();
    const record: StoredRun = {
      requestId,
      coordinatorRequestId: null,
      mode: input.mode,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      version: 1,
      latestStage: null,
      lastEventId: 0,
      progress: { totalCount: 0, terminalCount: 0, remainingCount: 0 },
      controller: new AbortController(),
      events: [],
      listeners: new Set(),
      execution: null,
    };
    this.runs.set(requestId, record);
    if (idempotencyKey) {
      this.idempotency.set(idempotencyKey, { requestId, fingerprint: requestFingerprint });
    }
    this.enforceCapacity();

    const execution = Promise.resolve().then(() => this.execute(record, { ...input, requestId }));
    record.execution = execution;
    registerLifetime?.(execution);
    return { requestId, reused: false };
  }

  get(requestId: string): PublicRunSnapshot | null {
    this.prune();
    const record = this.runs.get(requestId);
    if (!record) return null;
    const coordinator = record.coordinatorRequestId
      ? requestCoordinator.getRequest(record.coordinatorRequestId)
      : null;
    const recordIsTerminal = record.completedAt !== null && terminalStatuses.has(record.status);
    const tasks = coordinator
      ? coordinator.taskIds
          .map((taskId) => requestCoordinator.getTask(taskId))
          .filter((task): task is TaskSnapshot => task !== null)
          .map((task) => {
            const queue = requestCoordinator.getAssigneeQueue(task.assignee);
            const queued = queue.queue.find((item) => item.taskId === task.taskId);
            return {
              taskId: task.taskId,
              kind: task.kind,
              assignee: task.assignee,
              required: task.required,
              status: task.status,
              createdAt: task.createdAt,
              updatedAt: task.updatedAt,
              startedAt: task.startedAt,
              completedAt: task.completedAt,
              queuePosition: queued?.position ?? null,
              waitingMs: queued?.waitingMs ?? 0,
            } satisfies PublicRunTask;
          })
      : [];
    return {
      requestId: record.requestId,
      mode: record.mode,
      // The executor terminal result is authoritative. A failed executor can
      // leave unstarted coordinator tasks behind; those must not make the
      // public run appear active forever.
      status: recordIsTerminal ? record.status : coordinator?.status ?? record.status,
      createdAt: record.createdAt,
      updatedAt: Math.max(record.updatedAt, coordinator?.updatedAt ?? 0),
      completedAt: record.completedAt,
      version: Math.max(record.version, coordinator?.version ?? 0),
      latestStage: record.latestStage,
      lastEventId: record.lastEventId,
      progress: coordinator && !recordIsTerminal
        ? {
            totalCount: coordinator.progress.total,
            terminalCount: coordinator.progress.total - coordinator.progress.remaining,
            remainingCount: coordinator.progress.remaining,
          }
        : { ...record.progress },
      tasks,
      ...(record.result === undefined ? {} : { result: record.result }),
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    };
  }

  cancel(requestId: string) {
    const record = this.runs.get(requestId);
    if (!record) throw new RunRegistryError("RUN_NOT_FOUND", `Run ${requestId} was not found.`);
    if (terminalStatuses.has(record.status)) return this.get(requestId)!;
    record.controller.abort(new DOMException("Run cancelled by user.", "AbortError"));
    if (record.coordinatorRequestId) {
      try {
        requestCoordinator.cancelRequest(record.coordinatorRequestId, this.clock());
      } catch {
        // The execution may have reached terminal state between the two reads.
      }
    }
    this.finish(record, "cancelled", "CANCELLED");
    return this.get(requestId)!;
  }

  subscribe(
    requestId: string,
    afterEventId: number,
    listener: (event: PublicRunEvent) => void,
  ) {
    const record = this.runs.get(requestId);
    if (!record) throw new RunRegistryError("RUN_NOT_FOUND", `Run ${requestId} was not found.`);
    const backlog = record.events.filter((event) => event.id > afterEventId);
    if (!terminalStatuses.has(record.status)) record.listeners.add(listener);
    return {
      backlog,
      terminal: terminalStatuses.has(record.status),
      unsubscribe: () => record.listeners.delete(listener),
    };
  }

  snapshot() {
    this.prune();
    const runs = [...this.runs.values()];
    return {
      capturedAt: this.clock(),
      total: runs.length,
      active: runs.filter((run) => !terminalStatuses.has(run.status)).length,
      byStatus: Object.fromEntries(
        ["queued", "running", "integrating", "completed", "partial_failed", "failed", "cancelled"]
          .map((status) => [status, runs.filter((run) => run.status === status).length]),
      ),
    };
  }

  private async execute(record: StoredRun, input: StartRunInput & { requestId: string }) {
    this.touch(record, "running");
    try {
      const result = await this.executor(
        input,
        (event) => this.onProgress(record, event),
        record.controller.signal,
      );
      if (record.status === "cancelled") return;
      const safeResult = sanitizeForPublic(result);
      const executionStatus = isRecord(safeResult) && typeof safeResult.executionStatus === "string"
        ? safeResult.executionStatus
        : "completed";
      const finalStatus: RequestStatus = terminalStatuses.has(executionStatus as RequestStatus)
        ? executionStatus as RequestStatus
        : "completed";
      record.result = safeResult;
      this.finish(record, finalStatus);
    } catch {
      if (record.controller.signal.aborted || record.status === "cancelled") {
        this.finish(record, "cancelled", "CANCELLED");
      } else {
        this.finish(record, "failed", "EXECUTION_FAILED");
      }
    }
  }

  private onProgress(record: StoredRun, event: OrchestrationProgressEvent) {
    if (terminalStatuses.has(record.status)) return;
    record.coordinatorRequestId = event.runId;
    record.latestStage = event.stage;
    if (event.execution) {
      record.status = event.execution.executionStatus;
      record.progress = {
        totalCount: event.execution.totalCount,
        terminalCount: event.execution.terminalCount,
        remainingCount: event.execution.remainingCount,
      };
    } else if (event.stage.startsWith("central.") || event.stage.startsWith("judge.")) {
      record.status = "integrating";
    } else {
      record.status = "running";
    }
    this.touch(record);
    this.emit(record, "progress", safeProgressEvent({ ...event, runId: record.requestId }));
  }

  private finish(
    record: StoredRun,
    status: RequestStatus,
    errorCode?: PublicRunSnapshot["errorCode"],
  ) {
    if (terminalStatuses.has(record.status) && record.completedAt !== null) return;
    record.status = status;
    record.errorCode = errorCode;
    record.completedAt = this.clock();
    record.progress = {
      ...record.progress,
      terminalCount: record.progress.totalCount,
      remainingCount: 0,
    };
    this.touch(record);
    this.emit(
      record,
      status === "cancelled" ? "cancelled" : status === "failed" ? "failed" : "completed",
      {
        requestId: record.requestId,
        status,
        errorCode,
        progress: { ...record.progress },
      },
    );
    record.listeners.clear();
  }

  private touch(record: StoredRun, status?: RequestStatus) {
    if (status) record.status = status;
    record.updatedAt = this.clock();
    record.version += 1;
  }

  private emit(record: StoredRun, type: PublicRunEvent["type"], data: Record<string, unknown>) {
    const event: PublicRunEvent = {
      id: ++record.lastEventId,
      type,
      createdAt: this.clock(),
      data,
    };
    record.events.push(event);
    if (record.events.length > this.maxEventsPerRun) record.events.shift();
    for (const listener of [...record.listeners]) listener(event);
  }

  private prune() {
    const cutoff = this.clock() - this.ttlMs;
    for (const [requestId, record] of this.runs) {
      if (record.completedAt !== null && record.completedAt < cutoff) {
        this.runs.delete(requestId);
      }
    }
    for (const [key, entry] of this.idempotency) {
      if (!this.runs.has(entry.requestId)) this.idempotency.delete(key);
    }
  }

  private enforceCapacity() {
    if (this.runs.size <= this.maxRuns) return;
    const removable = [...this.runs.values()]
      .filter((run) => terminalStatuses.has(run.status))
      .sort((left, right) => (left.completedAt ?? 0) - (right.completedAt ?? 0));
    while (this.runs.size > this.maxRuns && removable.length) {
      this.runs.delete(removable.shift()!.requestId);
    }
  }
}

export const runRegistry = new RunRegistry();

export function publicRunEventIsTerminal(event: PublicRunEvent) {
  return eventIsTerminal(event);
}
