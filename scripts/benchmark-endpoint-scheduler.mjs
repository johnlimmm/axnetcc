import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { EndpointScheduler } from "../lib/endpoint-scheduler.ts";

const REPORT_VERSION = "scheduler-benchmark-v1";
const SEED = 20260807;
const AGING_THRESHOLD_MS = 160;
const MAX_OVERTAKES = 3;
const ENDPOINT_COUNT = 2;
const BURSTS = [10, 50];

class FakeClock {
  constructor(start = 0) {
    this.value = start;
    this.nextTimerId = 1;
    this.timers = new Map();
  }

  now = () => this.value;

  setTimeout = (callback, delayMs) => {
    const id = this.nextTimerId++;
    this.timers.set(id, { id, at: this.value + Math.max(0, delayMs), callback });
    return id;
  };

  clearTimeout = (id) => this.timers.delete(id);

  advance(ms) {
    const target = this.value + ms;
    while (true) {
      const due = [...this.timers.values()]
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!due) break;
      this.value = due.at;
      this.timers.delete(due.id);
      due.callback();
    }
    this.value = target;
  }
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function workload(burst, seed) {
  const random = seeded(seed + burst);
  const agentMix = [1, 3, 8];
  const requests = Array.from({ length: burst }, (_, index) => {
    const agentCount = agentMix[index % agentMix.length];
    return {
      requestId: `B${burst}-R${String(index + 1).padStart(3, "0")}`,
      agentCount,
      remaining: agentCount,
      createdAt: 0,
      completedAt: null,
    };
  });
  const tasks = [];
  // Group each incoming request's tasks to reproduce the FIFO head-of-line
  // blocking that completion-aware dispatch is intended to reduce.
  for (let requestIndex = 0; requestIndex < requests.length; requestIndex += 1) {
    const request = requests[requestIndex];
    for (let round = 0; round < request.agentCount; round += 1) {
      const jitter = Math.floor(random() * 4);
      tasks.push({
        requestId: request.requestId,
        taskId: `${request.requestId}-A${round + 1}`,
        agentId: `agent-${round + 1}`,
        endpoint: `http://127.0.0.1:${11434 + ((requestIndex + round) % ENDPOINT_COUNT)}`,
        durationMs: 6 + (round % 3) + jitter,
      });
    }
  }
  return { requests, tasks };
}

async function flush(turns = 10) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

async function runScenario({ burst, policy }) {
  const clock = new FakeClock();
  const { requests, tasks } = workload(burst, SEED);
  const requestById = new Map(requests.map((request) => [request.requestId, request]));
  const taskStatus = new Map(tasks.map((task) => [task.taskId, "queued"]));
  const audit = [];
  const scheduler = new EndpointScheduler({
    clock,
    agingThresholdMs: policy === "priority" ? AGING_THRESHOLD_MS : 1_000_000,
    maxOvertakes: policy === "priority" ? MAX_OVERTAKES : Number.MAX_SAFE_INTEGER,
    deadlineUrgencyMs: 0,
    ...(policy === "priority" ? {
      getDispatchContext: (task) => {
        const request = requestById.get(task.requestId);
        const status = taskStatus.get(task.taskId);
        return request && status ? {
          remainingCount: request.remaining,
          remainingTasks: request.remaining,
          lastTask: request.remaining === 1,
          ready: status === "queued",
          taskStatus: status,
          requestStatus: request.completedAt === null ? "running" : "completed",
        } : null;
      },
    } : {}),
    onAudit: (metrics) => audit.push(metrics),
  });

  let finished = 0;
  const pending = tasks.map((task) => scheduler.enqueue({
    requestId: task.requestId,
    taskId: task.taskId,
    agentId: task.agentId,
    taskKind: "agent",
    stage: "mock-inference",
    resourceKey: task.endpoint,
    deadlineAt: 100_000,
    execute: () => {
      taskStatus.set(task.taskId, "running");
      return new Promise((resolveTask) => {
        clock.setTimeout(() => {
          taskStatus.set(task.taskId, "succeeded");
          const request = requestById.get(task.requestId);
          request.remaining -= 1;
          if (request.remaining === 0) request.completedAt = clock.now();
          finished += 1;
          resolveTask(task.taskId);
        }, task.durationMs);
      });
    },
  }));

  let guard = 0;
  while (finished < tasks.length) {
    clock.advance(1);
    await flush();
    guard += 1;
    if (guard > 100_000) throw new Error(`Scheduler benchmark stalled: ${burst}/${policy}`);
  }
  await Promise.all(pending);
  const makespanMs = Math.max(...requests.map((request) => request.completedAt ?? 0));
  const requestCompletion = requests.map((request) => request.completedAt - request.createdAt);
  const completionReady = requests
    .filter((request) => request.agentCount === 1)
    .map((request) => request.completedAt - request.createdAt);
  const queueWait = audit.map((item) => item.queueWaitMs);
  const e2e = audit.map((item) => item.endToEndMs);
  const maximumServiceMs = Math.max(...tasks.map((task) => task.durationMs));
  const endpointDemandMs = Object.values(tasks.reduce((totals, task) => ({
    ...totals,
    [task.endpoint]: (totals[task.endpoint] ?? 0) + task.durationMs,
  }), {}));
  const offeredLoadLowerBoundMs = Math.max(...endpointDemandMs);
  const strictWaitTargetMs = AGING_THRESHOLD_MS + maximumServiceMs;
  const strictWaitFeasible = offeredLoadLowerBoundMs <= strictWaitTargetMs;
  const observedMaximumQueueWaitMs = Math.max(...queueWait);
  return {
    reportVersion: REPORT_VERSION,
    policy,
    burst,
    requestCount: requests.length,
    taskCount: tasks.length,
    agentMix: Object.fromEntries([1, 3, 8].map((count) => [count, requests.filter((item) => item.agentCount === count).length])),
    requestCompletionMs: {
      p50: percentile(requestCompletion, 0.5),
      p95: percentile(requestCompletion, 0.95),
      max: Math.max(...requestCompletion),
    },
    completionReadyRequestMs: {
      p50: percentile(completionReady, 0.5),
      p95: percentile(completionReady, 0.95),
      max: Math.max(...completionReady),
    },
    queueWaitMs: {
      p50: percentile(queueWait, 0.5),
      p95: percentile(queueWait, 0.95),
      max: Math.max(...queueWait),
    },
    taskE2eMs: {
      p50: percentile(e2e, 0.5),
      p95: percentile(e2e, 0.95),
    },
    makespanMs,
    throughputRequestsPerSecond: Number((requests.length / (makespanMs / 1_000)).toFixed(2)),
    lastTaskPromotions: audit.filter((item) => item.dispatchReason === "last-task").length,
    agingPromotions: audit.filter((item) => item.dispatchReason === "aging").length,
    maxOvertakenCount: Math.max(...audit.map((item) => item.overtakenCount)),
    starvationCount: requests.filter((request) => request.completedAt === null).length,
    strictGlobalWaitBound: {
      targetMs: strictWaitTargetMs,
      observedMaxQueueWaitMs: observedMaximumQueueWaitMs,
      offeredLoadLowerBoundMs,
      feasibleUnderBurst: strictWaitFeasible,
      status: strictWaitFeasible
        ? observedMaximumQueueWaitMs <= strictWaitTargetMs ? "passed" : "failed"
        : "not-applicable-overloaded-burst",
      rationale: strictWaitFeasible
        ? "The offered service demand fits within the aging threshold plus one maximum service time."
        : "All tasks arrive at once and serial service demand exceeds the proposed bound; no capacity-1 non-preemptive scheduler can globally satisfy it.",
    },
  };
}

const scenarios = [];
for (const burst of BURSTS) {
  scenarios.push(await runScenario({ burst, policy: "fifo" }));
  scenarios.push(await runScenario({ burst, policy: "priority" }));
}

const comparisons = BURSTS.map((burst) => {
  const fifo = scenarios.find((item) => item.burst === burst && item.policy === "fifo");
  const priority = scenarios.find((item) => item.burst === burst && item.policy === "priority");
  return {
    burst,
    requestP50ImprovementPercent: Number(((fifo.requestCompletionMs.p50 - priority.requestCompletionMs.p50) / fifo.requestCompletionMs.p50 * 100).toFixed(2)),
    requestP95ImprovementPercent: Number(((fifo.requestCompletionMs.p95 - priority.requestCompletionMs.p95) / fifo.requestCompletionMs.p95 * 100).toFixed(2)),
    completionReadyP50ImprovementPercent: Number(((fifo.completionReadyRequestMs.p50 - priority.completionReadyRequestMs.p50) / fifo.completionReadyRequestMs.p50 * 100).toFixed(2)),
    completionReadyP95ImprovementPercent: Number(((fifo.completionReadyRequestMs.p95 - priority.completionReadyRequestMs.p95) / fifo.completionReadyRequestMs.p95 * 100).toFixed(2)),
    throughputChangePercent: Number(((priority.throughputRequestsPerSecond - fifo.throughputRequestsPerSecond) / fifo.throughputRequestsPerSecond * 100).toFixed(2)),
  };
});

const priorityScenarios = scenarios.filter((scenario) => scenario.policy === "priority");
const acceptance = {
  throughputLossWithinFivePercent: comparisons.every((row) => row.throughputChangePercent >= -5),
  completionReadyP50Improved: comparisons.every((row) => row.completionReadyP50ImprovementPercent > 0),
  noStarvation: priorityScenarios.every((row) => row.starvationCount === 0),
  maxOvertakesRespected: priorityScenarios.every((row) => row.maxOvertakenCount <= MAX_OVERTAKES),
  feasibleStrictWaitBoundsPassed: priorityScenarios
    .filter((row) => row.strictGlobalWaitBound.feasibleUnderBurst)
    .every((row) => row.strictGlobalWaitBound.status === "passed"),
  overloadedStrictWaitBounds: priorityScenarios
    .filter((row) => !row.strictGlobalWaitBound.feasibleUnderBurst)
    .map((row) => ({ burst: row.burst, ...row.strictGlobalWaitBound })),
};

for (const [gate, passed] of Object.entries(acceptance)) {
  if (typeof passed === "boolean" && !passed) {
    throw new Error(`Scheduler benchmark acceptance gate failed: ${gate}`);
  }
}

const report = {
  reportVersion: REPORT_VERSION,
  generatedAt: new Date().toISOString(),
  provenance: "deterministic-mock-workload",
  configuration: {
    model: "mock-ollama-deterministic-timer",
    corpus: "not-applicable-scheduler-only",
    endpointCount: ENDPOINT_COUNT,
    endpointCapacity: 1,
    seed: SEED,
    bursts: BURSTS,
    agentCounts: [1, 3, 8],
    agingThresholdMs: AGING_THRESHOLD_MS,
    maxOvertakes: MAX_OVERTAKES,
    schedulerImplementation: "lib/endpoint-scheduler.ts",
    node: process.version,
  },
  scenarios,
  comparisons,
  acceptance,
};

const output = resolve("reports", `${REPORT_VERSION}.json`);
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, comparisons, acceptance }, null, 2));
