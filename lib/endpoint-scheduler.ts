export type DispatchReason = "fifo" | "last-task" | "aging" | "deadline";

export type SchedulerTaskKind =
  | "agent"
  | "central-integration"
  | "managed-supervisor"
  | "commercial-judge"
  | (string & {});

export type SchedulerTaskMetadata = {
  requestId: string;
  taskId: string;
  agentId?: string;
  taskKind: SchedulerTaskKind;
  stage: string;
  resourceKey: string;
  attempt: number;
  enqueuedAt: number;
  deadlineAt: number;
};

export type DispatchContext = {
  /** All non-terminal request tasks, including this task and supervisors. */
  remainingCount?: number;
  /** Compatibility name used by RequestCoordinator's current snapshot. */
  remainingTasks?: number;
  /** Advisory only; the scheduler still verifies the numeric remaining count. */
  lastTask?: boolean;
  requestVersion?: number;
  requestStatus?: string;
  taskStatus?: string;
  ready?: boolean;
  cancelled?: boolean;
  taskTerminal?: boolean;
};

export type GetDispatchContext = (
  task: Readonly<SchedulerTaskMetadata>,
) => DispatchContext | null | undefined;

export type EndpointExecutionOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "deadline-exceeded";

export type EndpointExecutionMetrics = {
  requestId: string;
  taskId: string;
  agentId?: string;
  taskKind: SchedulerTaskKind;
  stage: string;
  resourceKey: string;
  attempt: number;
  deadlineAt: number;
  dispatchReason: DispatchReason | null;
  outcome: EndpointExecutionOutcome;
  aborted: boolean;
  enqueuedAt: number;
  dispatchedAt: number | null;
  completedAt: number;
  queueWaitMs: number;
  inferenceMs: number;
  endToEndMs: number;
  queueDepthAtEnqueue: number;
  queueDepthAtDispatch: number | null;
  oldestWaitMsAtDispatch: number | null;
  overtakenCount: number;
};

export type ScheduledResult<T> = {
  value: T;
  metrics: EndpointExecutionMetrics;
};

export type EnqueueEndpointTask<T> = {
  requestId: string;
  taskId: string;
  agentId?: string;
  taskKind: SchedulerTaskKind;
  stage: string;
  resourceKey: string;
  attempt?: number;
  /** Absolute timestamp in the scheduler clock's time domain. */
  deadlineAt: number;
  signal?: AbortSignal;
  execute: (signal: AbortSignal) => Promise<T> | T;
};

export type QueuedTaskSnapshot = SchedulerTaskMetadata & {
  sequence: number;
  waitMs: number;
  overtakenCount: number;
};

export type ActiveTaskSnapshot = SchedulerTaskMetadata & {
  sequence: number;
  dispatchedAt: number;
  dispatchReason: DispatchReason;
  queueWaitMs: number;
};

export type EndpointQueueSnapshot = {
  resourceKey: string;
  capacity: number;
  activeCount: number;
  queueDepth: number;
  oldestWaitMs: number;
  active: ActiveTaskSnapshot[];
  queued: QueuedTaskSnapshot[];
};

export type SchedulerClock = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type EndpointSchedulerOptions = {
  defaultCapacity?: number;
  capacityForResource?: (resourceKey: string) => number;
  agingThresholdMs?: number;
  maxOvertakes?: number;
  deadlineUrgencyMs?: number;
  getDispatchContext?: GetDispatchContext;
  onAudit?: (metrics: Readonly<EndpointExecutionMetrics>) => void;
  clock?: SchedulerClock;
};

export type EndpointSchedulerErrorCode =
  | "TASK_ALREADY_ACTIVE"
  | "TASK_CANCELLED"
  | "TASK_DEADLINE_EXCEEDED"
  | "TASK_EXECUTION_FAILED";

export class EndpointSchedulerError extends Error {
  readonly code: EndpointSchedulerErrorCode;
  readonly metrics: EndpointExecutionMetrics | null;
  override readonly cause: unknown;

  constructor(
    code: EndpointSchedulerErrorCode,
    message: string,
    metrics: EndpointExecutionMetrics | null = null,
    cause?: unknown,
  ) {
    super(message);
    this.name = "EndpointSchedulerError";
    this.code = code;
    this.metrics = metrics;
    this.cause = cause;
  }
}

type QueueItemState = "queued" | "running" | "settled";
type AbortKind = "cancelled" | "deadline-exceeded";

type QueueItem<T> = {
  metadata: SchedulerTaskMetadata;
  sequence: number;
  execute: (signal: AbortSignal) => Promise<T> | T;
  resolve: (result: ScheduledResult<T>) => void;
  reject: (error: EndpointSchedulerError) => void;
  state: QueueItemState;
  controller: AbortController;
  externalSignal?: AbortSignal;
  externalAbortListener?: () => void;
  deadlineTimer?: unknown;
  dispatchReason: DispatchReason | null;
  dispatchedAt: number | null;
  queueDepthAtEnqueue: number;
  queueDepthAtDispatch: number | null;
  oldestWaitMsAtDispatch: number | null;
  overtakenCount: number;
  abortKind: AbortKind | null;
};

type AnyQueueItem = QueueItem<unknown>;

type ResourceQueue = {
  resourceKey: string;
  capacity: number;
  active: Set<AnyQueueItem>;
  queue: AnyQueueItem[];
  pumping: boolean;
};

const MAX_TIMER_DELAY_MS = 2_147_483_647;

const systemClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function finiteNonNegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite, non-negative number.`);
  }
  return value;
}

function positiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer.`);
  }
  return value;
}

function canonicalEndpoint(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new TypeError("Endpoint resource keys must contain a valid HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Endpoint resource keys only support HTTP(S) URLs.");
  }
  if (url.username || url.password) {
    throw new TypeError("Endpoint resource keys must not contain credentials.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}

/**
 * Produces a stable physical-resource identity. The model and logical Agent are
 * intentionally excluded so Agents sharing one endpoint share one queue.
 */
export function canonicalResourceKey(endpoint: string, namespace = "ollama") {
  const normalizedNamespace = namespace.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(normalizedNamespace)) {
    throw new TypeError("Resource key namespaces must be lowercase alphanumeric tokens.");
  }
  return `${normalizedNamespace}:${canonicalEndpoint(endpoint)}`;
}

function normalizeResourceKey(resourceKey: string) {
  const trimmed = resourceKey.trim();
  if (!trimmed) throw new TypeError("resourceKey must not be empty.");
  if (/^https?:\/\//i.test(trimmed)) return canonicalResourceKey(trimmed, "endpoint");
  const namespacedEndpoint = /^([a-z][a-z0-9-]*):(https?:\/\/.*)$/i.exec(trimmed);
  if (namespacedEndpoint) {
    return canonicalResourceKey(namespacedEndpoint[2], namespacedEndpoint[1]);
  }
  return trimmed;
}

function safeMessage(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.message) return reason.message;
  return typeof reason === "string" && reason.trim() ? reason : fallback;
}

export class EndpointScheduler {
  private readonly resources = new Map<string, ResourceQueue>();
  private readonly tasks = new Map<string, AnyQueueItem>();
  private readonly defaultCapacity: number;
  private readonly capacityForResource?: (resourceKey: string) => number;
  private readonly agingThresholdMs: number;
  private readonly maxOvertakes: number;
  private readonly deadlineUrgencyMs: number;
  private readonly getDispatchContext?: GetDispatchContext;
  private readonly onAudit?: (metrics: Readonly<EndpointExecutionMetrics>) => void;
  private readonly clock: SchedulerClock;
  private sequence = 0;

  constructor(options: EndpointSchedulerOptions = {}) {
    this.defaultCapacity = positiveInteger(options.defaultCapacity ?? 1, "defaultCapacity");
    this.capacityForResource = options.capacityForResource;
    this.agingThresholdMs = finiteNonNegative(
      options.agingThresholdMs ?? 30_000,
      "agingThresholdMs",
    );
    this.maxOvertakes = positiveInteger(options.maxOvertakes ?? 2, "maxOvertakes");
    this.deadlineUrgencyMs = finiteNonNegative(
      options.deadlineUrgencyMs ?? 5_000,
      "deadlineUrgencyMs",
    );
    this.getDispatchContext = options.getDispatchContext;
    this.onAudit = options.onAudit;
    this.clock = options.clock ?? systemClock;
  }

  enqueue<T>(input: EnqueueEndpointTask<T>): Promise<ScheduledResult<T>> {
    const resourceKey = normalizeResourceKey(input.resourceKey);
    const now = this.clock.now();
    finiteNonNegative(now, "clock.now()");
    finiteNonNegative(input.deadlineAt, "deadlineAt");
    const attempt = positiveInteger(input.attempt ?? 1, "attempt");
    if (!input.requestId.trim() || !input.taskId.trim()) {
      throw new TypeError("requestId and taskId must not be empty.");
    }
    if (this.tasks.has(input.taskId)) {
      return Promise.reject(new EndpointSchedulerError(
        "TASK_ALREADY_ACTIVE",
        `Task ${input.taskId} is already queued or running.`,
      ));
    }

    const resource = this.resource(resourceKey);
    let resolvePromise!: (result: ScheduledResult<T>) => void;
    let rejectPromise!: (error: EndpointSchedulerError) => void;
    const promise = new Promise<ScheduledResult<T>>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const metadata: SchedulerTaskMetadata = {
      requestId: input.requestId,
      taskId: input.taskId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      taskKind: input.taskKind,
      stage: input.stage,
      resourceKey,
      attempt,
      enqueuedAt: now,
      deadlineAt: input.deadlineAt,
    };
    const item: QueueItem<T> = {
      metadata,
      sequence: this.sequence += 1,
      execute: input.execute,
      resolve: resolvePromise,
      reject: rejectPromise,
      state: "queued",
      controller: new AbortController(),
      externalSignal: input.signal,
      dispatchReason: null,
      dispatchedAt: null,
      queueDepthAtEnqueue: resource.queue.length + 1,
      queueDepthAtDispatch: null,
      oldestWaitMsAtDispatch: null,
      overtakenCount: 0,
      abortKind: null,
    };
    resource.queue.push(item as AnyQueueItem);
    this.tasks.set(input.taskId, item as AnyQueueItem);

    if (input.signal) {
      const abort = () => this.cancelItem(
        item as AnyQueueItem,
        safeMessage(input.signal?.reason, "Task cancelled by caller."),
      );
      item.externalAbortListener = abort;
      if (input.signal.aborted) abort();
      else input.signal.addEventListener("abort", abort, { once: true });
    }

    if (item.state === "queued") this.armDeadline(item as AnyQueueItem);
    this.pump(resource);
    return promise;
  }

  cancelTask(taskId: string, reason = "Task cancelled.") {
    const item = this.tasks.get(taskId);
    if (!item) return false;
    this.cancelItem(item, reason);
    return true;
  }

  cancelRequest(requestId: string, reason = "Request cancelled.") {
    const matching = [...this.tasks.values()].filter(
      (item) => item.metadata.requestId === requestId,
    );
    for (const item of matching) this.cancelItem(item, reason);
    return matching.length;
  }

  /** Re-evaluates Coordinator readiness, including queues on other resources. */
  refresh(resourceKey?: string) {
    if (resourceKey) {
      const resource = this.resources.get(normalizeResourceKey(resourceKey));
      if (resource) this.pump(resource);
      return;
    }
    for (const resource of this.resources.values()) this.pump(resource);
  }

  snapshot(resourceKey?: string): EndpointQueueSnapshot[] {
    const now = this.clock.now();
    finiteNonNegative(now, "clock.now()");
    const resources = resourceKey
      ? [this.resources.get(normalizeResourceKey(resourceKey))].filter(
          (item): item is ResourceQueue => Boolean(item),
        )
      : [...this.resources.values()].sort((left, right) =>
          left.resourceKey.localeCompare(right.resourceKey)
        );
    return resources.map((resource) => {
      const queued = resource.queue
        .filter((item) => item.state === "queued")
        .map((item): QueuedTaskSnapshot => ({
          ...item.metadata,
          sequence: item.sequence,
          waitMs: Math.max(0, now - item.metadata.enqueuedAt),
          overtakenCount: item.overtakenCount,
        }));
      const active = [...resource.active]
        .sort((left, right) => left.sequence - right.sequence)
        .map((item): ActiveTaskSnapshot => ({
          ...item.metadata,
          sequence: item.sequence,
          dispatchedAt: item.dispatchedAt ?? now,
          dispatchReason: item.dispatchReason ?? "fifo",
          queueWaitMs: Math.max(0, (item.dispatchedAt ?? now) - item.metadata.enqueuedAt),
        }));
      return {
        resourceKey: resource.resourceKey,
        capacity: resource.capacity,
        activeCount: active.length,
        queueDepth: queued.length,
        oldestWaitMs: queued.length ? Math.max(...queued.map((item) => item.waitMs)) : 0,
        active,
        queued,
      };
    });
  }

  private resource(resourceKey: string) {
    const existing = this.resources.get(resourceKey);
    if (existing) return existing;
    const configured = this.capacityForResource?.(resourceKey) ?? this.defaultCapacity;
    const resource: ResourceQueue = {
      resourceKey,
      capacity: positiveInteger(configured, `capacity for ${resourceKey}`),
      active: new Set(),
      queue: [],
      pumping: false,
    };
    this.resources.set(resourceKey, resource);
    return resource;
  }

  private armDeadline(item: AnyQueueItem) {
    if (item.state === "settled") return;
    if (item.deadlineTimer !== undefined) this.clock.clearTimeout(item.deadlineTimer);
    const remaining = item.metadata.deadlineAt - this.clock.now();
    if (remaining <= 0) {
      this.deadlineItem(item);
      return;
    }
    item.deadlineTimer = this.clock.setTimeout(() => {
      item.deadlineTimer = undefined;
      if (this.clock.now() < item.metadata.deadlineAt) {
        this.armDeadline(item);
      } else {
        this.deadlineItem(item);
      }
    }, Math.min(remaining, MAX_TIMER_DELAY_MS));
  }

  private deadlineItem(item: AnyQueueItem) {
    if (item.state === "settled") return;
    item.abortKind ??= "deadline-exceeded";
    if (item.state === "queued") {
      this.settleQueued(item, "deadline-exceeded", "Task deadline exceeded before dispatch.");
      return;
    }
    item.controller.abort(new DOMException("Task deadline exceeded during execution.", "TimeoutError"));
  }

  private cancelItem(item: AnyQueueItem, reason: string) {
    if (item.state === "settled") return;
    item.abortKind ??= "cancelled";
    if (item.state === "queued") {
      this.settleQueued(item, "cancelled", reason);
      return;
    }
    item.controller.abort(new DOMException(reason, "AbortError"));
  }

  private settleQueued(
    item: AnyQueueItem,
    outcome: Exclude<EndpointExecutionOutcome, "succeeded" | "failed">,
    message: string,
  ) {
    if (item.state !== "queued") return;
    const resource = this.resources.get(item.metadata.resourceKey);
    if (resource) {
      const index = resource.queue.indexOf(item);
      if (index >= 0) resource.queue.splice(index, 1);
    }
    const completedAt = this.clock.now();
    item.state = "settled";
    const metrics = this.metrics(item, outcome, completedAt);
    this.cleanupItem(item);
    item.reject(new EndpointSchedulerError(
      outcome === "cancelled" ? "TASK_CANCELLED" : "TASK_DEADLINE_EXCEEDED",
      message,
      metrics,
    ));
    this.audit(metrics);
    if (resource) {
      this.pump(resource);
      this.deleteIdleResource(resource);
    }
  }

  private pump(resource: ResourceQueue) {
    if (resource.pumping) return;
    resource.pumping = true;
    try {
      this.pruneExpired(resource);
      this.pruneCoordinatorTerminal(resource);
      while (resource.active.size < resource.capacity && resource.queue.length) {
        const selection = this.selectNext(resource);
        if (!selection) break;
        const queueDepth = resource.queue.length;
        const now = this.clock.now();
        const oldestWait = Math.max(
          0,
          ...resource.queue.map((item) => now - item.metadata.enqueuedAt),
        );
        if (selection.index > 0) {
          for (let index = 0; index < selection.index; index += 1) {
            resource.queue[index].overtakenCount += 1;
          }
        }
        const [item] = resource.queue.splice(selection.index, 1);
        item.state = "running";
        item.dispatchReason = selection.reason;
        item.dispatchedAt = now;
        item.queueDepthAtDispatch = queueDepth;
        item.oldestWaitMsAtDispatch = oldestWait;
        resource.active.add(item);
        void this.runItem(resource, item);
      }
    } finally {
      resource.pumping = false;
      this.deleteIdleResource(resource);
    }
  }

  private pruneExpired(resource: ResourceQueue) {
    const now = this.clock.now();
    for (const item of [...resource.queue]) {
      if (item.metadata.deadlineAt <= now) {
        item.abortKind ??= "deadline-exceeded";
        this.settleQueued(item, "deadline-exceeded", "Task deadline exceeded before dispatch.");
      }
    }
  }

  private pruneCoordinatorTerminal(resource: ResourceQueue) {
    if (!this.getDispatchContext) return;
    for (const item of [...resource.queue]) {
      const context = this.readDispatchContext(item);
      if (!this.isTerminalDispatchContext(context)) continue;
      item.abortKind ??= "cancelled";
      this.settleQueued(item, "cancelled", "Coordinator task is no longer dispatchable.");
    }
  }

  private selectNext(resource: ResourceQueue): { index: number; reason: DispatchReason } | null {
    const queue = resource.queue;
    if (!queue.length) return null;
    const candidates = queue
      .map((item, index) => ({ item, index, context: this.readDispatchContext(item) }))
      .filter(({ context }) => this.isDispatchableContext(context));
    if (!candidates.length) return null;
    if (candidates.length === 1) return { index: candidates[0].index, reason: "fifo" };
    const now = this.clock.now();
    const head = candidates[0].item;
    const headWait = Math.max(0, now - head.metadata.enqueuedAt);
    if (headWait >= this.agingThresholdMs || head.overtakenCount >= this.maxOvertakes) {
      return { index: candidates[0].index, reason: "aging" };
    }

    let deadlineCandidate: typeof candidates[number] | null = null;
    for (const candidate of candidates) {
      const remaining = candidate.item.metadata.deadlineAt - now;
      if (remaining > this.deadlineUrgencyMs) continue;
      if (
        !deadlineCandidate ||
        candidate.item.metadata.deadlineAt < deadlineCandidate.item.metadata.deadlineAt ||
        (
          candidate.item.metadata.deadlineAt === deadlineCandidate.item.metadata.deadlineAt &&
          candidate.item.sequence < deadlineCandidate.item.sequence
        )
      ) {
        deadlineCandidate = candidate;
      }
    }
    if (deadlineCandidate) return { index: deadlineCandidate.index, reason: "deadline" };

    if (this.getDispatchContext) {
      for (const candidate of candidates) {
        const first = candidate.context;
        if (!this.isLastTaskContext(first)) continue;
        // The second synchronous read is the dispatch-time stale-state guard.
        const fresh = this.readDispatchContext(candidate.item);
        if (this.isDispatchableContext(fresh) && this.isLastTaskContext(fresh)) {
          return { index: candidate.index, reason: "last-task" };
        }
      }
    }
    return { index: candidates[0].index, reason: "fifo" };
  }

  private readDispatchContext(item: AnyQueueItem) {
    try {
      return this.getDispatchContext?.(Object.freeze({ ...item.metadata }));
    } catch {
      // Coordinator observation failure must degrade safely to FIFO.
      return null;
    }
  }

  private isLastTaskContext(context: DispatchContext | null | undefined) {
    const remainingCount = context?.remainingCount ?? context?.remainingTasks;
    const terminalStatus = context?.taskStatus === "succeeded" ||
      context?.taskStatus === "failed" ||
      context?.taskStatus === "cancelled" ||
      context?.taskStatus === "skipped";
    return Boolean(
      context &&
      remainingCount === 1 &&
      context.lastTask !== false &&
      context.ready !== false &&
      context.requestStatus !== "cancelled" &&
      !context.cancelled &&
      !context.taskTerminal &&
      !terminalStatus,
    );
  }

  private isTerminalDispatchContext(context: DispatchContext | null | undefined) {
    return Boolean(
      context && (
        context.cancelled ||
        context.taskTerminal ||
        context.requestStatus === "completed" ||
        context.requestStatus === "partial_failed" ||
        context.requestStatus === "failed" ||
        context.requestStatus === "cancelled" ||
        context.taskStatus === "succeeded" ||
        context.taskStatus === "failed" ||
        context.taskStatus === "cancelled" ||
        context.taskStatus === "skipped"
      )
    );
  }

  private isDispatchableContext(context: DispatchContext | null | undefined) {
    if (!context) return true;
    if (this.isTerminalDispatchContext(context) || context.ready === false) return false;
    return context.taskStatus === undefined || context.taskStatus === "queued";
  }

  private async runItem(resource: ResourceQueue, item: AnyQueueItem) {
    let execution: Promise<unknown> | null = null;
    let drainAfterAbort: Promise<void> | null = null;
    const abortPromise = new Promise<never>((_, reject) => {
      const abort = () => reject(
        item.controller.signal.reason ?? new DOMException("Task aborted.", "AbortError"),
      );
      if (item.controller.signal.aborted) abort();
      else item.controller.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      try {
        execution = Promise.resolve(item.execute(item.controller.signal));
      } catch (error) {
        execution = Promise.reject(error);
      }
      const value = await Promise.race([execution, abortPromise]);
      const completedAt = this.clock.now();
      const metrics = this.metrics(item, "succeeded", completedAt);
      item.state = "settled";
      this.cleanupItem(item);
      item.resolve({ value, metrics });
      this.audit(metrics);
    } catch (cause) {
      const completedAt = this.clock.now();
      const outcome: EndpointExecutionOutcome = item.abortKind ?? "failed";
      const metrics = this.metrics(item, outcome, completedAt);
      item.state = "settled";
      this.cleanupItem(item);
      const code = outcome === "cancelled"
        ? "TASK_CANCELLED"
        : outcome === "deadline-exceeded"
          ? "TASK_DEADLINE_EXCEEDED"
          : "TASK_EXECUTION_FAILED";
      item.reject(new EndpointSchedulerError(
        code,
        outcome === "cancelled"
          ? safeMessage(cause, "Task cancelled during execution.")
          : outcome === "deadline-exceeded"
            ? "Task deadline exceeded during execution."
            : safeMessage(cause, "Endpoint task execution failed."),
        metrics,
        cause,
      ));
      this.audit(metrics);
      if (item.abortKind && execution) {
        // Reject the caller at the deadline/cancellation boundary, but keep the
        // physical resource occupied until the underlying operation actually
        // settles. This prevents an abort-cleanup race from exceeding capacity.
        drainAfterAbort = execution.then(
          () => undefined,
          () => undefined,
        );
      }
    } finally {
      if (drainAfterAbort) await drainAfterAbort;
      resource.active.delete(item);
      this.pump(resource);
      this.deleteIdleResource(resource);
    }
  }

  private metrics(
    item: AnyQueueItem,
    outcome: EndpointExecutionOutcome,
    completedAt: number,
  ): EndpointExecutionMetrics {
    const dispatchedAt = item.dispatchedAt;
    return {
      requestId: item.metadata.requestId,
      taskId: item.metadata.taskId,
      ...(item.metadata.agentId ? { agentId: item.metadata.agentId } : {}),
      taskKind: item.metadata.taskKind,
      stage: item.metadata.stage,
      resourceKey: item.metadata.resourceKey,
      attempt: item.metadata.attempt,
      deadlineAt: item.metadata.deadlineAt,
      dispatchReason: item.dispatchReason,
      outcome,
      aborted: outcome === "cancelled" || outcome === "deadline-exceeded",
      enqueuedAt: item.metadata.enqueuedAt,
      dispatchedAt,
      completedAt,
      queueWaitMs: Math.max(
        0,
        (dispatchedAt ?? completedAt) - item.metadata.enqueuedAt,
      ),
      inferenceMs: dispatchedAt === null ? 0 : Math.max(0, completedAt - dispatchedAt),
      endToEndMs: Math.max(0, completedAt - item.metadata.enqueuedAt),
      queueDepthAtEnqueue: item.queueDepthAtEnqueue,
      queueDepthAtDispatch: item.queueDepthAtDispatch,
      oldestWaitMsAtDispatch: item.oldestWaitMsAtDispatch,
      overtakenCount: item.overtakenCount,
    };
  }

  private cleanupItem(item: AnyQueueItem) {
    if (item.deadlineTimer !== undefined) {
      this.clock.clearTimeout(item.deadlineTimer);
      item.deadlineTimer = undefined;
    }
    if (item.externalSignal && item.externalAbortListener) {
      item.externalSignal.removeEventListener("abort", item.externalAbortListener);
    }
    this.tasks.delete(item.metadata.taskId);
  }

  private audit(metrics: EndpointExecutionMetrics) {
    try {
      this.onAudit?.(Object.freeze({ ...metrics }));
    } catch {
      // Audit consumers cannot interfere with slot release or queue progress.
    }
  }

  private deleteIdleResource(resource: ResourceQueue) {
    if (!resource.pumping && !resource.active.size && !resource.queue.length) {
      this.resources.delete(resource.resourceKey);
    }
  }
}
