import test from "node:test";
import assert from "node:assert/strict";
import { RunRegistry, RunRegistryError } from "../lib/run-registry.ts";
import { requestCoordinator } from "../lib/request-coordinator.ts";

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function progress(requestId, sequence, stage, execution) {
  return {
    runId: requestId,
    mode: "proposed",
    stage,
    message: stage === "agents.selected" ? "Agent selection completed" : "Processing",
    timestamp: Date.now(),
    sequence,
    selectedAgents: stage === "agents.selected" ? ["tech"] : undefined,
    execution,
  };
}

test("start returns immediately, exposes central task state, and finalizes once", async () => {
  const gate = deferred();
  const lifetime = [];
  const registry = new RunRegistry({
    idFactory: () => "RUN-ASYNC-1",
    executor: async (input, report) => {
      const plan = requestCoordinator.planRequest({
        requestId: input.requestId,
        mode: "proposed",
        selectedAgents: ["tech"],
      });
      report(progress(input.requestId, 1, "agents.selected", {
        executionStatus: plan.request.status,
        totalCount: plan.request.progress.total,
        terminalCount: 0,
        remainingCount: plan.request.progress.remaining,
        version: plan.request.version,
      }));
      await gate.promise;
      requestCoordinator.claimTask(`${input.requestId}_tech`);
      requestCoordinator.transitionTask(`${input.requestId}_tech`, "succeeded");
      requestCoordinator.claimTask(`${input.requestId}_central-integration`);
      requestCoordinator.transitionTask(`${input.requestId}_central-integration`, "succeeded");
      report(progress(input.requestId, 2, "request.completed", {
        executionStatus: "completed",
        totalCount: 2,
        terminalCount: 2,
        remainingCount: 0,
        version: 5,
      }));
      return { query: input.query, conclusion: "Safe final answer", executionStatus: "completed" };
    },
  });

  const started = await registry.start({
    query: "public service architecture review",
    mode: "proposed",
    commercialJudge: false,
  }, (execution) => lifetime.push(execution));
  assert.deepEqual(started, { requestId: "RUN-ASYNC-1", reused: false });
  assert.equal(lifetime.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  const active = registry.get(started.requestId);
  assert.equal(active.status, "queued");
  assert.equal(active.progress.remainingCount, 2);
  assert.equal(active.tasks.length, 2);
  assert.equal(active.tasks.find((task) => task.assignee === "tech").queuePosition, 1);

  gate.resolve();
  await lifetime[0];
  const completed = registry.get(started.requestId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.progress.remainingCount, 0);
  assert.equal(completed.result.query, undefined);
  assert.equal(completed.result.conclusion, "Safe final answer");
  assert.equal(completed.tasks.every((task) => task.status === "succeeded"), true);
});

test("idempotency reuses identical work and rejects a changed payload", async () => {
  let executions = 0;
  const registry = new RunRegistry({
    idFactory: () => "RUN-IDEMPOTENT",
    executor: async () => {
      executions += 1;
      return { executionStatus: "completed" };
    },
  });
  const base = {
    query: "same sufficiently long request",
    mode: "proposed",
    commercialJudge: false,
    idempotencyKey: "client-request-001",
  };
  const first = await registry.start(base);
  const second = await registry.start(base);
  assert.equal(first.requestId, second.requestId);
  assert.equal(second.reused, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executions, 1);
  await assert.rejects(
    registry.start({ ...base, query: "different sufficiently long request" }),
    (error) => error instanceof RunRegistryError && error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("SSE backlog resumes after an event id without query, evidence, or PII", async () => {
  const gate = deferred();
  const registry = new RunRegistry({
    idFactory: () => "RUN-RESUME-1",
    executor: async (input, report) => {
      report(progress(input.requestId, 1, "request.received"));
      report({
        ...progress(input.requestId, 2, "router.decided"),
        routerDecision: {
          version: "2",
          strategy: "boundary-constrained",
          securityLevel: "personal",
          purpose: "advice",
          primaryAgent: "security",
          candidateAgents: ["security"],
          required: ["security"],
          selected: ["security"],
          supportingAgents: [],
          requiredConcepts: [],
          predictedCoverage: 1,
          objectiveCost: 1,
          adaptiveAdditions: [],
          humanReviewRequired: false,
          rationale: ["input 010-1234-5678"],
          primarySelection: {
            algorithm: "test",
            hardGate: { applied: true, reasons: ["resident-id"] },
            rankedCandidates: [{
              agentId: "security",
              rank: 1,
              totalScore: 1,
              components: {},
              matchedTerms: ["900101-1234567"],
              matchedEntities: ["010-1234-5678"],
              matchedConceptIds: [],
            }],
            confidence: 1,
            top1Top2Margin: 1,
            decisionThreshold: 0,
            fallbackUsed: false,
            reviewReasons: [],
          },
        },
      });
      await gate.promise;
      return {
        query: "900101-1234567",
        conclusion: "call 010-1234-5678",
        executionStatus: "completed",
      };
    },
  });
  await registry.start({
    query: "please process 900101-1234567 and 010-1234-5678",
    mode: "proposed",
    commercialJudge: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const first = registry.subscribe("RUN-RESUME-1", 0, () => {});
  assert.equal(first.backlog.length, 2);
  const resumed = registry.subscribe("RUN-RESUME-1", 1, () => {});
  assert.deepEqual(resumed.backlog.map((event) => event.id), [2]);
  const serializedEvents = JSON.stringify(first.backlog);
  assert.equal(serializedEvents.includes("900101-1234567"), false);
  assert.equal(serializedEvents.includes("010-1234-5678"), false);
  assert.equal(serializedEvents.includes("matchedTerms"), false);
  assert.equal(serializedEvents.includes("matchedEntities"), false);
  first.unsubscribe();
  resumed.unsubscribe();

  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  const snapshot = registry.get("RUN-RESUME-1");
  const serializedSnapshot = JSON.stringify(snapshot);
  assert.equal(serializedSnapshot.includes("900101-1234567"), false);
  assert.equal(serializedSnapshot.includes("010-1234-5678"), false);
  assert.match(snapshot.result.conclusion, /제거/);
});

test("cancellation aborts execution and publishes exactly one terminal event", async () => {
  const registry = new RunRegistry({
    idFactory: () => "RUN-CANCEL-1",
    executor: async (_input, report, signal) => {
      report(progress("RUN-CANCEL-1", 1, "request.received"));
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { executionStatus: "completed" };
    },
  });
  await registry.start({
    query: "cancel this sufficiently long request",
    mode: "proposed",
    commercialJudge: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const terminal = [];
  const subscription = registry.subscribe("RUN-CANCEL-1", 0, (event) => {
    if (event.type !== "progress") terminal.push(event.type);
  });
  registry.cancel("RUN-CANCEL-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.get("RUN-CANCEL-1").status, "cancelled");
  assert.deepEqual(terminal, ["cancelled"]);
  subscription.unsubscribe();
});

test("service resilience is degraded when synthesis falls back despite successful Agent attempts", async () => {
  const { recordInferenceStage } = await import("../lib/distributed-metrics.ts");
  const registry = new RunRegistry({
    idFactory: () => "RUN-SYNTHESIS-FALLBACK",
    executor: async input => {
      recordInferenceStage(input.requestId, "synthesis", { backend: "deterministic", model: "unavailable", promptTokens: null, completionTokens: null });
      return { executionStatus: "completed", conclusion: "Fallback" };
    },
  });
  await registry.start({ query: "Public synthesis fallback verification", mode: "proposed", commercialJudge: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registry.get("RUN-SYNTHESIS-FALLBACK").result.resilience.degraded, true);
});

test("ordinary completed deterministic integration is not degraded when successful Edge inference intentionally needs no synthesis", async () => {
  const { recordEdgeAttempt, getDistributedRun } = await import("../lib/distributed-metrics.ts");
  const requestId = "RUN-SKIPPED-SYNTHESIS";
  const registry = new RunRegistry({ idFactory: () => requestId, executor: async () => {
    recordEdgeAttempt(requestId, { attemptId: "edge-one", requestId, agentId: "tech", nodeId: "primary", replicaId: "one", role: "primary",
      startedAt: 1, completedAt: 2, elapsedMs: 1, queueWaitMs: 0, requestBytesPrepared: 10, responseBytesReceived: 20,
      status: "succeeded", reasonCode: null, backend: "ollama", model: "test", promptTokens: 7, completionTokens: 3, usageStatus: "measured", adopted: true });
    return { executionStatus: "completed", integration: { backend: "deterministic", model: null }, conclusion: "Insufficient public evidence" };
  } });
  await registry.start({ query: "Public evidence insufficiency verification", mode: "proposed", commercialJudge: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registry.get(requestId).result.resilience.degraded, false);
  assert.equal(registry.get(requestId).executionSettled, true);
  assert.deepEqual(getDistributedRun(requestId).stages, []);
  assert.equal(getDistributedRun(requestId).totals.promptTokens, 7);
});
