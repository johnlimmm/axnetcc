import type { AgentId } from "./agent-registry";
import {
  EndpointScheduler,
  canonicalResourceKey,
  type EndpointExecutionMetrics,
  type EndpointQueueSnapshot,
  type ScheduledResult,
  type SchedulerTaskKind,
} from "./endpoint-scheduler";
import { resolveAgentRuntime } from "./local-llm";
import { remoteAgentEnabled } from "./edge-replicas";
import { requestCoordinator } from "./request-coordinator";

const DEFAULT_TASK_DEADLINE_MS = 95_000;
const DEFAULT_EDGE_DEADLINE_MS = 31_000;
const MAX_RECORDED_TASKS = 2_000;

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function configuredEdgeBaseUrl(agentId: AgentId) {
  return (
    process.env[`EDGE_AGENT_${agentId.toUpperCase()}_BASE_URL`] ??
    process.env.EDGE_AGENT_BASE_URL ??
    ""
  ).replace(/\/+$/, "");
}

function edgeAgentEndpointForResource(baseUrl: string) {
  if (!baseUrl) return baseUrl;
  try {
    const url = new URL(baseUrl);
    if (!url.pathname.endsWith("/api/edge/agent")) {
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/edge/agent`;
    }
    return url.toString();
  } catch {
    return baseUrl;
  }
}

function safeEndpointResourceKey(
  endpoint: string,
  namespace: string,
  fallback: string,
) {
  if (!endpoint) return fallback;
  try {
    return canonicalResourceKey(endpoint, namespace);
  } catch {
    // Keep malformed endpoint values out of observable scheduler metadata. The
    // execution layer will still validate and fail the actual request.
    return fallback;
  }
}

export function resolveAgentExecutionResource(agentId: AgentId) {
  const edgeMode = (process.env.EDGE_AGENT_MODE ?? "auto").trim().toLowerCase();
  const edgeBaseUrl = configuredEdgeBaseUrl(agentId);
  if (edgeMode === "remote" || (edgeMode === "auto" && edgeBaseUrl)) {
    return safeEndpointResourceKey(
      edgeAgentEndpointForResource(edgeBaseUrl),
      "edge",
      `edge-unconfigured:${agentId}`,
    );
  }
  const runtime = resolveAgentRuntime(agentId);
  return safeEndpointResourceKey(
    runtime.baseUrl,
    "ollama",
    `deterministic:agent:${agentId}`,
  );
}

export function resolveLocalLlmExecutionResource(agentId: AgentId) {
  const runtime = resolveAgentRuntime(agentId);
  return safeEndpointResourceKey(
    runtime.baseUrl,
    "ollama",
    `deterministic:local-llm:${agentId}`,
  );
}

export function resolveCommercialJudgeExecutionResource() {
  const baseUrl = process.env.COMMERCIAL_JUDGE_BASE_URL?.replace(/\/+$/, "") ?? "";
  let endpoint = baseUrl;
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (!url.pathname.endsWith("/chat/completions")) {
        url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
      }
      endpoint = url.toString();
    } catch {
      endpoint = baseUrl;
    }
  }
  return safeEndpointResourceKey(
    endpoint,
    "commercial-judge",
    "deterministic:commercial-judge",
  );
}

export function localLlmTaskDeadlineMs() {
  const localTimeout = boundedInteger(
    process.env.LOCAL_LLM_TIMEOUT_MS,
    90_000,
    1,
    3_600_000,
  );
  return Math.max(DEFAULT_TASK_DEADLINE_MS, localTimeout + 1_000);
}

export function edgeTaskDeadlineMs() {
  const edgeTimeout = boundedInteger(
    process.env.EDGE_AGENT_TIMEOUT_MS,
    30_000,
    100,
    3_600_000,
  );
  return Math.max(DEFAULT_EDGE_DEADLINE_MS, edgeTimeout + 1_000);
}

export function commercialJudgeTaskDeadlineMs() {
  const judgeTimeout = boundedInteger(
    process.env.COMMERCIAL_JUDGE_TIMEOUT_MS,
    30_000,
    100,
    3_600_000,
  );
  return Math.max(DEFAULT_EDGE_DEADLINE_MS, judgeTimeout + 1_000);
}

function agentTaskDeadlineMs(agentId: AgentId) {
  const edgeMode = (process.env.EDGE_AGENT_MODE ?? "auto").trim().toLowerCase();
  const edgeBaseUrl = configuredEdgeBaseUrl(agentId);
  return edgeMode === "remote" || (edgeMode === "auto" && edgeBaseUrl)
    ? edgeTaskDeadlineMs()
    : localLlmTaskDeadlineMs();
}

const remoteParents = new Map<string, { taskId: string; deadlineAt: number }>();
const physicalParents = new Map<string, { taskId: string | null; current: boolean }>();
export function remoteAgentBudget(requestId: string, agentId: AgentId) {
  return remoteParents.get(`${requestId}:${agentId}`)?.deadlineAt;
}
export async function scheduleEdgeAttempt<T>(input: {
  requestId: string; agentId: AgentId; attemptId: string; endpoint: string; nodeId?: string;
  deadlineAt: number; attempt: number; signal?: AbortSignal;
  execute: (signal: AbortSignal) => Promise<T>;
}) {
  const parent = remoteParents.get(`${input.requestId}:${input.agentId}`);
  const mapping = { taskId: parent?.taskId ?? null, current: true };
  physicalParents.set(input.attemptId, mapping);
  try {
    return await executionScheduler.enqueue({
      requestId: input.requestId, taskId: input.attemptId, agentId: input.agentId,
      taskKind: "edge-attempt", stage: "edge-attempt", attempt: input.attempt,
      resourceKey: input.nodeId && input.nodeId !== "unconfigured" ? `edge-node:${input.nodeId}` : canonicalResourceKey(input.endpoint, "edge"),
      deadlineAt: Math.min(input.deadlineAt, parent?.deadlineAt ?? Infinity), signal: input.signal,
      execute(signal) {
        if (mapping.taskId) {
          const task = requestCoordinator.getTask(mapping.taskId);
          if (task?.status === "queued") requestCoordinator.claimTask(mapping.taskId);
          else if (task?.status !== "running") throw new Error("Logical Agent is not active");
        }
        return input.execute(signal);
      },
    });
  } finally {
    mapping.current = false;
    physicalParents.delete(input.attemptId);
  }
}

const taskMetrics = new Map<string, EndpointExecutionMetrics>();

function rememberMetrics(metrics: Readonly<EndpointExecutionMetrics>) {
  taskMetrics.delete(metrics.taskId);
  taskMetrics.set(metrics.taskId, { ...metrics });
  while (taskMetrics.size > MAX_RECORDED_TASKS) {
    const oldestTaskId = taskMetrics.keys().next().value as string | undefined;
    if (!oldestTaskId) break;
    taskMetrics.delete(oldestTaskId);
  }
}

function auditCoordinatedExecution(metrics: Readonly<EndpointExecutionMetrics>) {
  rememberMetrics(metrics);
  if (metrics.taskKind === "edge-attempt") return;
  const task = requestCoordinator.getTask(metrics.taskId);
  if (!task || task.status !== "running") return;

  // EndpointScheduler invokes this audit hook synchronously before it releases
  // the physical slot and chooses the next item. Keeping the Coordinator in
  // sync here makes the next last-task decision observe the just-finished task
  // as terminal instead of one event-loop turn late.
  if (metrics.outcome === "succeeded") {
    // A successful judge transport may still return a domain-level error. Its
    // caller maps that result to succeeded/failed before returning the API.
    if (metrics.taskKind !== "commercial-judge") {
      requestCoordinator.transitionTask(metrics.taskId, "succeeded", metrics.completedAt);
      executionScheduler.refresh();
    }
    return;
  }
  if (metrics.outcome === "failed" || metrics.outcome === "deadline-exceeded") {
    requestCoordinator.transitionTask(metrics.taskId, "failed", metrics.completedAt);
    executionScheduler.refresh();
  }
}

/**
 * One process-local scheduling authority. It stores only opaque task metadata;
 * query text, prompts, evidence and generated answers remain in execute closures.
 */
export const executionScheduler = new EndpointScheduler({
  defaultCapacity: 1,
  agingThresholdMs: boundedInteger(
    process.env.ENDPOINT_SCHEDULER_AGING_MS,
    30_000,
    0,
    3_600_000,
  ),
  maxOvertakes: boundedInteger(
    process.env.ENDPOINT_SCHEDULER_MAX_OVERTAKES,
    2,
    1,
    100,
  ),
  deadlineUrgencyMs: boundedInteger(
    process.env.ENDPOINT_SCHEDULER_DEADLINE_URGENCY_MS,
    5_000,
    0,
    120_000,
  ),
  getDispatchContext(metadata) {
    if (metadata.taskKind === "edge-attempt") {
      const mapping = physicalParents.get(metadata.taskId);
      if (!mapping?.current) return { cancelled: true };
      if (!mapping.taskId) return { ready: true };
      try {
        const context = requestCoordinator.getDispatchContext(metadata.requestId, mapping.taskId);
        return { ...context, ready: context.ready || context.taskStatus === "running",
          taskStatus: context.taskStatus === "running" ? "queued" : context.taskStatus };
      } catch { return { cancelled: true }; }
    }
    return requestCoordinator.getDispatchContext(
      metadata.requestId,
      metadata.taskId,
    );
  },
  onAudit: auditCoordinatedExecution,
});

export type ScheduleCoordinatedTaskInput<T> = {
  requestId: string;
  taskId: string;
  agentId?: AgentId;
  taskKind: SchedulerTaskKind;
  stage: string;
  resourceKey: string;
  deadlineMs: number;
  attempt?: number;
  signal?: AbortSignal;
  execute: (signal: AbortSignal) => Promise<T> | T;
};

export function scheduleCoordinatedTask<T>(
  input: ScheduleCoordinatedTaskInput<T>,
): Promise<ScheduledResult<T>> {
  const deadlineMs = Math.max(1, Math.floor(input.deadlineMs));
  return executionScheduler.enqueue({
    requestId: input.requestId,
    taskId: input.taskId,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    taskKind: input.taskKind,
    stage: input.stage,
    resourceKey: input.resourceKey,
    attempt: input.attempt ?? 1,
    deadlineAt: Date.now() + deadlineMs,
    ...(input.signal ? { signal: input.signal } : {}),
    execute(scheduledSignal) {
      // Claim only after the physical endpoint worker has selected this item.
      // There is no await between the final dispatch-context read and claim.
      requestCoordinator.claimTask(input.taskId);
      return input.execute(scheduledSignal);
    },
  });
}

export async function scheduleAgentTask<T>(input: Omit<
  ScheduleCoordinatedTaskInput<T>,
  "taskKind" | "resourceKey" | "deadlineMs"
> & { agentId: AgentId }) {
  if (remoteAgentEnabled(input.agentId)) {
    const key = `${input.requestId}:${input.agentId}`;
    if (remoteParents.has(key)) throw new Error("Logical Agent already active");
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener("abort", abort, { once: true });
    const budget = boundedInteger(process.env.EDGE_AGENT_BUDGET_MS, 90_000, 100, 3_600_000);
    remoteParents.set(key, { taskId: input.taskId, deadlineAt: Date.now() + budget });
    const timer = setTimeout(() => controller.abort(new DOMException("Agent budget exceeded", "TimeoutError")), budget);
    try {
      controller.signal.throwIfAborted();
      const value = await input.execute(controller.signal);
      controller.signal.throwIfAborted();
      requestCoordinator.transitionTask(input.taskId, "succeeded");
      return { value };
    } catch (error) {
      const task = requestCoordinator.getTask(input.taskId);
      if (task && (task.status === "queued" || task.status === "running")) {
        if (task.status === "queued" && !input.signal?.aborted) requestCoordinator.claimTask(input.taskId);
        requestCoordinator.transitionTask(input.taskId, input.signal?.aborted ? "cancelled" : "failed");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      remoteParents.delete(key);
      executionScheduler.refresh();
    }
  }
  return scheduleCoordinatedTask({
    ...input,
    taskKind: "agent",
    resourceKey: resolveAgentExecutionResource(input.agentId),
    deadlineMs: agentTaskDeadlineMs(input.agentId),
  });
}

export function scheduleLocalLlmTask<T>(input: Omit<
  ScheduleCoordinatedTaskInput<T>,
  "resourceKey" | "deadlineMs"
> & { agentId: AgentId }) {
  return scheduleCoordinatedTask({
    ...input,
    resourceKey: resolveLocalLlmExecutionResource(input.agentId),
    deadlineMs: localLlmTaskDeadlineMs(),
  });
}

export function scheduleCommercialJudgeTask<T>(input: Omit<
  ScheduleCoordinatedTaskInput<T>,
  "taskKind" | "resourceKey" | "deadlineMs"
>) {
  return scheduleCoordinatedTask({
    ...input,
    taskKind: "commercial-judge",
    resourceKey: resolveCommercialJudgeExecutionResource(),
    deadlineMs: commercialJudgeTaskDeadlineMs(),
  });
}

export function executionMetricsForRequest(requestId: string) {
  return [...taskMetrics.values()]
    .filter((metrics) => metrics.requestId === requestId)
    .sort((left, right) => left.enqueuedAt - right.enqueuedAt ||
      left.taskId.localeCompare(right.taskId))
    .map((metrics) => ({ ...metrics }));
}

export function executionSchedulerSnapshot(resourceKey?: string): EndpointQueueSnapshot[] {
  return executionScheduler.snapshot(resourceKey);
}
