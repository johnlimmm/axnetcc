import type { AgentId } from "./agent-registry";

/**
 * Single-process execution ledger for MNC-7.
 *
 * This module deliberately accepts and stores only routing metadata. Query text,
 * prompts, evidence, model output, and free-form error messages are outside the
 * coordinator boundary and must remain in the execution layer.
 */

export const coordinatorModes = [
  "proposed",
  "parallel",
  "centralized",
  "managed",
  "masrouter",
  "remoterag",
] as const;

export type CoordinatorMode = (typeof coordinatorModes)[number];

export const requestStatuses = [
  "queued",
  "running",
  "integrating",
  "completed",
  "partial_failed",
  "failed",
  "cancelled",
] as const;

export type RequestStatus = (typeof requestStatuses)[number];

export const taskStatuses = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
] as const;

export type TaskStatus = (typeof taskStatuses)[number];
export type CoordinatorTaskKind =
  | "agent"
  | "central-integration"
  | "managed-supervisor"
  | "commercial-judge";
export type CoordinatorAssignee =
  | AgentId
  | "central-integration"
  | "managed-supervisor"
  | "commercial-judge";

export type CoordinatorErrorCode =
  | "INVALID_IDENTIFIER"
  | "INVALID_TIMESTAMP"
  | "INVALID_MODE"
  | "INVALID_AGENT"
  | "EMPTY_AGENT_PLAN"
  | "REQUEST_NOT_FOUND"
  | "TASK_NOT_FOUND"
  | "REQUEST_CONFLICT"
  | "UNSUPPORTED_DEPLOYMENT"
  | "INVALID_TASK_TRANSITION"
  | "TASK_DEPENDENCY_PENDING";

export class CoordinatorError extends Error {
  readonly code: CoordinatorErrorCode;

  constructor(code: CoordinatorErrorCode, message: string) {
    super(message);
    this.name = "CoordinatorError";
    this.code = code;
  }
}

export type RequestPlanInput = {
  requestId?: string;
  mode: CoordinatorMode;
  selectedAgents: readonly AgentId[];
  optionalAgents?: readonly AgentId[];
  useCommercialJudge?: boolean;
  createdAt?: number;
};

export type RequestProgressCounts = Record<TaskStatus, number> & {
  total: number;
  remaining: number;
};

export type RequestSnapshot = {
  requestId: string;
  mode: CoordinatorMode;
  status: RequestStatus;
  selectedAgents: AgentId[];
  optionalAgents: AgentId[];
  useCommercialJudge: boolean;
  cancelRequested: boolean;
  taskIds: string[];
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  version: number;
  progress: RequestProgressCounts;
};

export type TaskSnapshot = {
  taskId: string;
  requestId: string;
  kind: CoordinatorTaskKind;
  assignee: CoordinatorAssignee;
  required: boolean;
  status: TaskStatus;
  dependencyTaskIds: string[];
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  version: number;
};

export type RequestPlanSnapshot = {
  created: boolean;
  request: RequestSnapshot;
  tasks: TaskSnapshot[];
};

export type TransitionSnapshot = {
  changed: boolean;
  request: RequestSnapshot;
  task: TaskSnapshot;
};

export type QueueTaskSnapshot = TaskSnapshot & {
  position: number;
  requestStatus: RequestStatus;
  waitingMs: number;
  remainingTasks: number;
  lastTask: boolean;
};

export type DispatchContextSnapshot = {
  requestId: string;
  taskId: string;
  assignee: CoordinatorAssignee;
  requestStatus: RequestStatus;
  taskStatus: TaskStatus;
  ready: boolean;
  requestCreatedAt: number;
  taskCreatedAt: number;
  waitingMs: number;
  remainingTasks: number;
  lastTask: boolean;
};

export type AssigneeQueueSnapshot = {
  assignee: CoordinatorAssignee;
  capturedAt: number;
  counts: Record<TaskStatus, number> & { total: number };
  queue: QueueTaskSnapshot[];
};

export type CoordinatorSnapshot = {
  capturedAt: number;
  counts: {
    requests: Record<RequestStatus, number> & { total: number };
    tasks: Record<TaskStatus, number> & { total: number };
  };
  requests: RequestSnapshot[];
  tasks: TaskSnapshot[];
};

type StoredRequest = Omit<RequestSnapshot, "selectedAgents" | "optionalAgents" | "taskIds" | "progress"> & {
  selectedAgents: AgentId[];
  optionalAgents: AgentId[];
  taskIds: string[];
  sequence: number;
};

type StoredTask = Omit<TaskSnapshot, "dependencyTaskIds"> & {
  dependencyTaskIds: string[];
  sequence: number;
};

export type CoordinatorOptions = {
  clock?: () => number;
  idFactory?: () => string;
};

const agentIds = [
  "tech",
  "data",
  "security",
  "legal",
  "policy",
  "finance",
  "procurement",
  "operations",
] as const satisfies readonly AgentId[];

const agentIdSet = new Set<string>(agentIds);
const modeSet = new Set<string>(coordinatorModes);
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const terminalTaskStatuses = new Set<TaskStatus>(["succeeded", "failed", "cancelled", "skipped"]);
const terminalRequestStatuses = new Set<RequestStatus>([
  "completed",
  "partial_failed",
  "failed",
  "cancelled",
]);

const taskTransitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  queued: new Set(["running", "cancelled", "skipped"]),
  running: new Set(["succeeded", "failed", "cancelled", "skipped"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  skipped: new Set(),
};

/**
 * The in-memory coordinator is deliberately single-authority. Deployment
 * manifests must declare one replica; known multi-worker configurations fail
 * before any request graph is created instead of silently splitting queues.
 */
export function assertCoordinatorDeploymentSupported() {
  const scope = (process.env.REQUEST_COORDINATOR_SCOPE ?? "single-process").trim();
  const declaredCounts = [
    process.env.REQUEST_COORDINATOR_REPLICA_COUNT,
    process.env.WEB_CONCURRENCY,
  ].filter((value): value is string => Boolean(value?.trim()));
  const invalidCount = declaredCounts.find((value) =>
    !/^\d+$/.test(value.trim()) || Number(value) < 1
  );
  const replicaCount = declaredCounts.reduce(
    (maximum, value) => Math.max(maximum, Number(value)),
    1,
  );
  if (scope !== "single-process" || invalidCount || replicaCount !== 1) {
    throw new CoordinatorError(
      "UNSUPPORTED_DEPLOYMENT",
      "The in-memory RequestCoordinator supports exactly one application replica. Configure a shared coordinator before enabling multiple workers.",
    );
  }
}

function emptyTaskCounts(): Record<TaskStatus, number> {
  return { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, skipped: 0 };
}

function emptyRequestCounts(): Record<RequestStatus, number> {
  return {
    queued: 0,
    running: 0,
    integrating: 0,
    completed: 0,
    partial_failed: 0,
    failed: 0,
    cancelled: 0,
  };
}

function assertTimestamp(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    throw new CoordinatorError("INVALID_TIMESTAMP", "Coordinator timestamps must be finite, non-negative numbers.");
  }
}

function assertOpaqueId(value: string) {
  if (!opaqueIdPattern.test(value)) {
    throw new CoordinatorError(
      "INVALID_IDENTIFIER",
      "Coordinator identifiers must be opaque ASCII tokens of at most 64 characters.",
    );
  }
}

function isSamePlan(
  request: StoredRequest,
  mode: CoordinatorMode,
  selectedAgents: readonly AgentId[],
  optionalAgents: readonly AgentId[],
  useCommercialJudge: boolean,
) {
  return request.mode === mode &&
    request.useCommercialJudge === useCommercialJudge &&
    request.selectedAgents.length === selectedAgents.length &&
    request.selectedAgents.every((agentId, index) => agentId === selectedAgents[index]) &&
    request.optionalAgents.length === optionalAgents.length &&
    request.optionalAgents.every((agentId, index) => agentId === optionalAgents[index]);
}

/**
 * In-memory coordinator intended for one application process. Every mutating
 * operation is synchronous, so planning, claiming and transitions are atomic
 * with respect to the JavaScript event loop. State is not persisted or shared
 * between replicas.
 */
export class RequestCoordinator {
  private readonly requests = new Map<string, StoredRequest>();
  private readonly tasks = new Map<string, StoredTask>();
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private sequence = 0;

  constructor(options: CoordinatorOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => `REQ-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`);
  }

  planRequest(input: RequestPlanInput): RequestPlanSnapshot {
    if (!modeSet.has(input.mode)) {
      throw new CoordinatorError("INVALID_MODE", `Unsupported coordinator mode: ${String(input.mode)}`);
    }

    const selectedAgents = [...new Set(input.selectedAgents)];
    const selectedAgentSet = new Set<AgentId>(selectedAgents);
    const optionalAgents = [...new Set(input.optionalAgents ?? [])]
      .filter((agentId) => !selectedAgentSet.has(agentId));
    if (!selectedAgents.length) {
      throw new CoordinatorError("EMPTY_AGENT_PLAN", "At least one Agent is required for a request plan.");
    }
    for (const agentId of [...selectedAgents, ...optionalAgents]) {
      if (!agentIdSet.has(agentId)) {
        throw new CoordinatorError("INVALID_AGENT", `Unsupported Agent identifier: ${String(agentId)}`);
      }
    }

    const requestId = input.requestId ?? this.idFactory();
    assertOpaqueId(requestId);
    const useCommercialJudge = input.useCommercialJudge === true;

    const existing = this.requests.get(requestId);
    if (existing) {
      if (!isSamePlan(existing, input.mode, selectedAgents, optionalAgents, useCommercialJudge)) {
        throw new CoordinatorError("REQUEST_CONFLICT", `Request ${requestId} already has a different plan.`);
      }
      return this.planSnapshot(existing, false);
    }

    const createdAt = input.createdAt ?? this.clock();
    assertTimestamp(createdAt);
    const requestSequence = this.sequence += 1;
    const agentTasks = [...selectedAgents, ...optionalAgents].map((agentId) => {
      const task: StoredTask = {
        taskId: `${requestId}_${agentId}`,
        requestId,
        kind: "agent",
        assignee: agentId,
        required: selectedAgentSet.has(agentId),
        status: "queued",
        dependencyTaskIds: [],
        createdAt,
        updatedAt: createdAt,
        startedAt: null,
        completedAt: null,
        version: 1,
        sequence: this.sequence += 1,
      };
      this.tasks.set(task.taskId, task);
      return task;
    });

    const createDependentTask = (
      kind: Exclude<CoordinatorTaskKind, "agent">,
      dependencyTaskIds: string[],
    ): StoredTask => {
      const task: StoredTask = {
        taskId: `${requestId}_${kind}`,
        requestId,
        kind,
        assignee: kind,
        required: true,
        status: "queued",
        dependencyTaskIds: [...dependencyTaskIds],
        createdAt,
        updatedAt: createdAt,
        startedAt: null,
        completedAt: null,
        version: 1,
        sequence: this.sequence += 1,
      };
      this.tasks.set(task.taskId, task);
      return task;
    };
    const agentTaskIds = agentTasks.map((task) => task.taskId);
    const integrationTask = input.mode === "managed"
      ? createDependentTask("managed-supervisor", agentTaskIds)
      : input.mode === "proposed" || input.mode === "centralized" || input.mode === "remoterag"
        ? createDependentTask("central-integration", agentTaskIds)
        : null;
    const judgeTask = useCommercialJudge
      ? createDependentTask(
          "commercial-judge",
          integrationTask ? [integrationTask.taskId] : agentTaskIds,
        )
      : null;

    const taskIds = [
      ...agentTaskIds,
      ...(integrationTask ? [integrationTask.taskId] : []),
      ...(judgeTask ? [judgeTask.taskId] : []),
    ];
    const request: StoredRequest = {
      requestId,
      mode: input.mode,
      status: "queued",
      selectedAgents,
      optionalAgents,
      useCommercialJudge,
      cancelRequested: false,
      taskIds,
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
      version: 1,
      sequence: requestSequence,
    };
    this.requests.set(requestId, request);
    return this.planSnapshot(request, true);
  }

  planManagedRequest(input: Omit<RequestPlanInput, "mode">): RequestPlanSnapshot {
    return this.planRequest({ ...input, mode: "managed" });
  }

  getRequest(requestId: string): RequestSnapshot | null {
    const request = this.requests.get(requestId);
    return request ? this.requestSnapshot(request) : null;
  }

  getTask(taskId: string): TaskSnapshot | null {
    const task = this.tasks.get(taskId);
    return task ? this.taskSnapshot(task) : null;
  }

  transitionTask(taskId: string, status: TaskStatus, at = this.clock()): TransitionSnapshot {
    const task = this.tasks.get(taskId);
    if (!task) throw new CoordinatorError("TASK_NOT_FOUND", `Task ${taskId} was not found.`);
    const request = this.requests.get(task.requestId);
    if (!request) throw new CoordinatorError("REQUEST_NOT_FOUND", `Request ${task.requestId} was not found.`);
    assertTimestamp(at);

    if (task.status === status) {
      return { changed: false, request: this.requestSnapshot(request), task: this.taskSnapshot(task) };
    }
    if (!taskTransitions[task.status].has(status)) {
      throw new CoordinatorError(
        "INVALID_TASK_TRANSITION",
        `Task ${taskId} cannot transition from ${task.status} to ${status}.`,
      );
    }
    if (status === "running" && !this.dependenciesTerminal(task)) {
      throw new CoordinatorError(
        "TASK_DEPENDENCY_PENDING",
        `Task ${taskId} has incomplete dependencies.`,
      );
    }

    this.applyTaskStatus(task, status, at);
    this.syncRequestLifecycle(request, at);
    return { changed: true, request: this.requestSnapshot(request), task: this.taskSnapshot(task) };
  }

  cancelRequest(requestId: string, at = this.clock()): { changed: boolean; request: RequestSnapshot } {
    const request = this.requests.get(requestId);
    if (!request) throw new CoordinatorError("REQUEST_NOT_FOUND", `Request ${requestId} was not found.`);
    assertTimestamp(at);
    if (request.status === "cancelled") return { changed: false, request: this.requestSnapshot(request) };
    if (terminalRequestStatuses.has(request.status)) {
      throw new CoordinatorError(
        "INVALID_TASK_TRANSITION",
        `Terminal request ${requestId} cannot transition from ${request.status} to cancelled.`,
      );
    }
    request.cancelRequested = true;
    for (const task of this.tasksFor(request)) {
      if (!terminalTaskStatuses.has(task.status)) this.applyTaskStatus(task, "cancelled", at);
    }
    this.syncRequestLifecycle(request, at);
    return { changed: true, request: this.requestSnapshot(request) };
  }

  getAssigneeQueue(assignee: CoordinatorAssignee, at = this.clock()): AssigneeQueueSnapshot {
    this.assertAssignee(assignee);
    assertTimestamp(at);
    const assigned = [...this.tasks.values()]
      .filter((task) => task.assignee === assignee);
    const counts = emptyTaskCounts();
    for (const task of assigned) counts[task.status] += 1;

    const queue = assigned
      .filter((task) => task.status === "queued" && this.dependenciesTerminal(task))
      .map((task) => {
        const request = this.requests.get(task.requestId);
        if (!request) throw new CoordinatorError("REQUEST_NOT_FOUND", `Request ${task.requestId} was not found.`);
        const remainingTasks = this.remainingTasks(request);
        return { task, request, remainingTasks, lastTask: remainingTasks === 1 };
      })
      // EndpointScheduler owns last-task and aging priority. The coordinator
      // exposes the context but keeps its compatibility queue strictly FIFO.
      .sort((left, right) => left.task.sequence - right.task.sequence)
      .map(({ task, request, remainingTasks, lastTask }, index): QueueTaskSnapshot => ({
        ...this.taskSnapshot(task),
        position: index + 1,
        requestStatus: request.status,
        waitingMs: Math.max(0, at - task.createdAt),
        remainingTasks,
        lastTask,
      }));

    return {
      assignee,
      capturedAt: at,
      counts: { ...counts, total: assigned.length },
      queue,
    };
  }

  claimNext(assignee: CoordinatorAssignee, at = this.clock()): TaskSnapshot | null {
    const candidate = this.getAssigneeQueue(assignee, at).queue[0];
    if (!candidate) return null;
    return this.transitionTask(candidate.taskId, "running", at).task;
  }

  claimTask(taskId: string, at = this.clock()): TaskSnapshot {
    return this.transitionTask(taskId, "running", at).task;
  }

  getDispatchContext(requestId: string, taskId: string, at = this.clock()): DispatchContextSnapshot {
    assertTimestamp(at);
    const request = this.requests.get(requestId);
    if (!request) throw new CoordinatorError("REQUEST_NOT_FOUND", `Request ${requestId} was not found.`);
    const task = this.tasks.get(taskId);
    if (!task || task.requestId !== requestId) {
      throw new CoordinatorError("TASK_NOT_FOUND", `Task ${taskId} was not found in request ${requestId}.`);
    }
    const remainingTasks = this.remainingTasks(request);
    return {
      requestId,
      taskId,
      assignee: task.assignee,
      requestStatus: request.status,
      taskStatus: task.status,
      ready: task.status === "queued" && this.dependenciesTerminal(task),
      requestCreatedAt: request.createdAt,
      taskCreatedAt: task.createdAt,
      waitingMs: Math.max(0, at - task.createdAt),
      remainingTasks,
      lastTask: !terminalTaskStatuses.has(task.status) && remainingTasks === 1,
    };
  }

  snapshot(at = this.clock()): CoordinatorSnapshot {
    assertTimestamp(at);
    const requests = [...this.requests.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map((request) => this.requestSnapshot(request));
    const tasks = [...this.tasks.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map((task) => this.taskSnapshot(task));
    const requestCounts = emptyRequestCounts();
    const taskCounts = emptyTaskCounts();
    for (const request of requests) requestCounts[request.status] += 1;
    for (const task of tasks) taskCounts[task.status] += 1;
    return {
      capturedAt: at,
      counts: {
        requests: { ...requestCounts, total: requests.length },
        tasks: { ...taskCounts, total: tasks.length },
      },
      requests,
      tasks,
    };
  }

  private assertAssignee(assignee: CoordinatorAssignee) {
    if (
      assignee !== "managed-supervisor" &&
      assignee !== "central-integration" &&
      assignee !== "commercial-judge" &&
      !agentIdSet.has(assignee)
    ) {
      throw new CoordinatorError("INVALID_AGENT", `Unsupported assignee: ${String(assignee)}`);
    }
  }

  private planSnapshot(request: StoredRequest, created: boolean): RequestPlanSnapshot {
    return {
      created,
      request: this.requestSnapshot(request),
      tasks: this.tasksFor(request).map((task) => this.taskSnapshot(task)),
    };
  }

  private tasksFor(request: StoredRequest) {
    return request.taskIds.map((taskId) => {
      const task = this.tasks.get(taskId);
      if (!task) throw new CoordinatorError("TASK_NOT_FOUND", `Task ${taskId} was not found.`);
      return task;
    });
  }

  private requestSnapshot(request: StoredRequest): RequestSnapshot {
    const progress = emptyTaskCounts();
    for (const task of this.tasksFor(request)) progress[task.status] += 1;
    const total = request.taskIds.length;
    return {
      requestId: request.requestId,
      mode: request.mode,
      status: request.status,
      selectedAgents: [...request.selectedAgents],
      optionalAgents: [...request.optionalAgents],
      useCommercialJudge: request.useCommercialJudge,
      cancelRequested: request.cancelRequested,
      taskIds: [...request.taskIds],
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      completedAt: request.completedAt,
      version: request.version,
      progress: {
        ...progress,
        total,
        remaining: total - progress.succeeded - progress.failed - progress.cancelled - progress.skipped,
      },
    };
  }

  private taskSnapshot(task: StoredTask): TaskSnapshot {
    return {
      taskId: task.taskId,
      requestId: task.requestId,
      kind: task.kind,
      assignee: task.assignee,
      required: task.required,
      status: task.status,
      dependencyTaskIds: [...task.dependencyTaskIds],
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      version: task.version,
    };
  }

  private dependenciesTerminal(task: StoredTask) {
    return task.dependencyTaskIds.every((taskId) => {
      const dependency = this.tasks.get(taskId);
      return dependency ? terminalTaskStatuses.has(dependency.status) : false;
    });
  }

  private remainingTasks(request: StoredRequest) {
    return this.tasksFor(request).filter((task) => !terminalTaskStatuses.has(task.status)).length;
  }

  private applyTaskStatus(task: StoredTask, status: TaskStatus, at: number) {
    const timestamp = Math.max(task.updatedAt, at);
    task.status = status;
    task.updatedAt = timestamp;
    task.version += 1;
    if (status === "running" && task.startedAt === null) task.startedAt = timestamp;
    if (terminalTaskStatuses.has(status)) task.completedAt = timestamp;
  }

  private syncRequestLifecycle(request: StoredRequest, at: number) {
    const tasks = this.tasksFor(request);
    let status: RequestStatus;
    if (tasks.every((task) => terminalTaskStatuses.has(task.status))) {
      const succeeded = tasks.filter((task) => task.status === "succeeded").length;
      const failed = tasks.filter((task) => task.status === "failed").length;
      const cancelled = tasks.filter((task) => task.status === "cancelled").length;
      if (request.cancelRequested) {
        status = "cancelled";
      } else if (failed > 0 || cancelled > 0) {
        status = succeeded > 0 ? "partial_failed" : "failed";
      } else {
        // Any mix consisting only of succeeded/skipped tasks is complete.
        status = "completed";
      }
    } else {
      const agentTasks = tasks.filter((task) => task.kind === "agent");
      const integrationTasks = tasks.filter((task) => task.kind !== "agent");
      status = integrationTasks.length > 0 &&
          agentTasks.every((task) => terminalTaskStatuses.has(task.status))
        ? "integrating"
        : tasks.some((task) => task.status !== "queued")
          ? "running"
          : "queued";
    }
    // Even when the aggregate status stays the same, task counts changed. Touch
    // the request revision so polling clients can detect the new snapshot.
    this.setRequestStatus(request, status, at, true);
  }

  private setRequestStatus(request: StoredRequest, status: RequestStatus, at: number, touch = false) {
    if (request.status === status && !touch) return;
    const timestamp = Math.max(request.updatedAt, at);
    request.status = status;
    request.updatedAt = timestamp;
    request.version += 1;
    if (terminalRequestStatuses.has(status)) request.completedAt ??= timestamp;
    else request.completedAt = null;
  }
}

/** Process-local default instance for API/orchestrator integration. */
export const requestCoordinator = new RequestCoordinator();
