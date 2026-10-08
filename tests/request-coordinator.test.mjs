import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCoordinatorDeploymentSupported,
  CoordinatorError,
  RequestCoordinator,
} from "../lib/request-coordinator.ts";

test("process-local coordinator rejects declared multi-worker deployments", () => {
  const previousReplicaCount = process.env.REQUEST_COORDINATOR_REPLICA_COUNT;
  const previousConcurrency = process.env.WEB_CONCURRENCY;
  try {
    process.env.REQUEST_COORDINATOR_REPLICA_COUNT = "2";
    assert.throws(
      () => assertCoordinatorDeploymentSupported(),
      (error) => error instanceof CoordinatorError && error.code === "UNSUPPORTED_DEPLOYMENT",
    );
    process.env.REQUEST_COORDINATOR_REPLICA_COUNT = "1";
    process.env.WEB_CONCURRENCY = "1";
    assert.doesNotThrow(() => assertCoordinatorDeploymentSupported());
  } finally {
    if (previousReplicaCount === undefined) delete process.env.REQUEST_COORDINATOR_REPLICA_COUNT;
    else process.env.REQUEST_COORDINATOR_REPLICA_COUNT = previousReplicaCount;
    if (previousConcurrency === undefined) delete process.env.WEB_CONCURRENCY;
    else process.env.WEB_CONCURRENCY = previousConcurrency;
  }
});

function coordinator(start = 1_000) {
  let now = start;
  return {
    instance: new RequestCoordinator({
      clock: () => now,
      idFactory: () => "REQ-GENERATED",
    }),
    setNow(value) {
      now = value;
    },
  };
}

function runAndFinish(instance, taskId, status, startedAt, finishedAt) {
  instance.transitionTask(taskId, "running", startedAt);
  return instance.transitionTask(taskId, status, finishedAt);
}

test("plans a managed request without retaining query, evidence, or arbitrary fields", () => {
  const { instance } = coordinator();
  const plan = instance.planRequest({
    requestId: "REQ-PRIVACY-1",
    mode: "managed",
    selectedAgents: ["security", "legal"],
    createdAt: 1_000,
    query: "resident-number 900101-1234567",
    evidence: [{ rawText: "confidential evidence" }],
    sensitiveInformation: "010-1234-5678",
  });

  assert.equal(plan.created, true);
  assert.equal(plan.request.status, "queued");
  assert.equal(plan.tasks.length, 3);
  const supervisor = plan.tasks.find((task) => task.kind === "managed-supervisor");
  assert.deepEqual(
    supervisor?.dependencyTaskIds,
    ["REQ-PRIVACY-1_security", "REQ-PRIVACY-1_legal"],
  );
  const serialized = JSON.stringify(instance.snapshot(1_000));
  assert.doesNotMatch(serialized, /900101|confidential evidence|010-1234|query|evidence|sensitiveInformation/i);
});

test("plans the full managed, optional Agent, and judge graph before execution", () => {
  const { instance } = coordinator();
  const plan = instance.planRequest({
    requestId: "REQ-FULL-PLAN",
    mode: "managed",
    selectedAgents: ["tech", "security"],
    optionalAgents: ["data", "tech"],
    useCommercialJudge: true,
  });
  assert.deepEqual(plan.tasks.map((task) => task.kind), [
    "agent",
    "agent",
    "agent",
    "managed-supervisor",
    "commercial-judge",
  ]);
  assert.deepEqual(plan.tasks.map((task) => task.required), [true, true, false, true, true]);
  assert.deepEqual(plan.request.selectedAgents, ["tech", "security"]);
  assert.deepEqual(plan.request.optionalAgents, ["data"]);
  const integration = plan.tasks.find((task) => task.kind === "managed-supervisor");
  const judge = plan.tasks.find((task) => task.kind === "commercial-judge");
  assert.deepEqual(integration?.dependencyTaskIds, [
    "REQ-FULL-PLAN_tech",
    "REQ-FULL-PLAN_security",
    "REQ-FULL-PLAN_data",
  ]);
  assert.deepEqual(judge?.dependencyTaskIds, [integration?.taskId]);
  assert.equal(instance.claimNext("managed-supervisor", 1_100), null);
  assert.equal(instance.claimNext("commercial-judge", 1_100), null);
});

test("task transitions are idempotent and drive the request lifecycle", () => {
  const { instance } = coordinator();
  const plan = instance.planRequest({
    requestId: "REQ-LIFECYCLE-1",
    mode: "parallel",
    selectedAgents: ["tech"],
  });
  const taskId = plan.tasks[0].taskId;

  const running = instance.transitionTask(taskId, "running", 1_100);
  assert.equal(running.changed, true);
  assert.equal(running.request.status, "running");
  assert.equal(running.task.version, 2);

  const repeated = instance.transitionTask(taskId, "running", 1_200);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.task.version, 2);
  assert.equal(repeated.task.updatedAt, 1_100);

  const succeeded = instance.transitionTask(taskId, "succeeded", 1_300);
  assert.equal(succeeded.request.status, "completed");
  assert.equal(succeeded.request.version, 3);
  assert.equal(succeeded.request.progress.succeeded, 1);
  assert.equal(succeeded.request.progress.remaining, 0);

  assert.throws(
    () => instance.transitionTask(taskId, "running", 1_400),
    (error) => error instanceof CoordinatorError && error.code === "INVALID_TASK_TRANSITION",
  );
});

test("managed supervisor accepts terminal partial Agent results and produces partial_failed", () => {
  const { instance } = coordinator();
  const plan = instance.planManagedRequest({
    requestId: "REQ-MANAGED-PARTIAL",
    selectedAgents: ["tech", "data"],
    createdAt: 1_000,
  });
  const tech = plan.tasks.find((task) => task.assignee === "tech");
  const data = plan.tasks.find((task) => task.assignee === "data");
  assert.ok(tech && data);

  runAndFinish(instance, tech.taskId, "failed", 1_100, 1_200);
  const afterFailure = instance.getRequest("REQ-MANAGED-PARTIAL");
  assert.equal(afterFailure?.status, "running");
  assert.equal(afterFailure?.progress.failed, 1);
  assert.equal(afterFailure?.progress.cancelled, 0);
  assert.equal(instance.getTask(data.taskId)?.status, "queued");
  assert.equal(instance.claimNext("managed-supervisor", 1_250), null);

  runAndFinish(instance, data.taskId, "succeeded", 1_300, 1_400);
  assert.equal(instance.getRequest("REQ-MANAGED-PARTIAL")?.status, "integrating");

  const supervisor = instance.claimNext("managed-supervisor", 1_500);
  assert.equal(supervisor?.kind, "managed-supervisor");
  const final = instance.transitionTask(supervisor.taskId, "succeeded", 1_600);
  assert.equal(final.request.status, "partial_failed");
  assert.equal(final.request.progress.succeeded, 2);
  assert.equal(final.request.progress.failed, 1);
  assert.equal(final.request.progress.remaining, 0);
});

test("request remains active after one failure and becomes failed only with no successes", () => {
  const { instance } = coordinator();
  const plan = instance.planRequest({
    requestId: "REQ-ALL-FAILED",
    mode: "parallel",
    selectedAgents: ["security", "legal"],
  });
  const security = plan.tasks.find((task) => task.assignee === "security");
  const legal = plan.tasks.find((task) => task.assignee === "legal");
  assert.ok(security && legal);

  const first = runAndFinish(instance, security.taskId, "failed", 1_100, 1_200);
  assert.equal(first.request.status, "running");
  assert.equal(first.request.progress.failed, 1);
  assert.equal(first.request.progress.queued, 1);
  assert.equal(first.request.progress.cancelled, 0);

  const final = runAndFinish(instance, legal.taskId, "failed", 1_300, 1_400);
  assert.equal(final.request.status, "failed");
  assert.equal(final.request.progress.failed, 2);
  assert.equal(final.request.progress.remaining, 0);
  const repeated = instance.transitionTask(legal.taskId, "failed", 1_500);
  assert.equal(repeated.changed, false);
});

test("succeeded and skipped terminal tasks produce a completed request", () => {
  const { instance } = coordinator();
  const plan = instance.planRequest({
    requestId: "REQ-SKIPPED",
    mode: "parallel",
    selectedAgents: ["tech"],
    optionalAgents: ["data"],
  });
  runAndFinish(instance, plan.tasks[0].taskId, "succeeded", 1_100, 1_200);
  const final = instance.transitionTask(plan.tasks[1].taskId, "skipped", 1_300);
  assert.equal(final.request.status, "completed");
  assert.equal(final.request.progress.succeeded, 1);
  assert.equal(final.request.progress.skipped, 1);
  assert.equal(final.task.required, false);
});

test("only an explicit cancellation produces a cancelled request", () => {
  const { instance } = coordinator();
  const plan = instance.planManagedRequest({
    requestId: "REQ-CANCELLED",
    selectedAgents: ["tech", "data"],
  });
  instance.transitionTask(plan.tasks[0].taskId, "running", 1_100);
  const cancelled = instance.cancelRequest("REQ-CANCELLED", 1_200);
  assert.equal(cancelled.changed, true);
  assert.equal(cancelled.request.status, "cancelled");
  assert.equal(cancelled.request.cancelRequested, true);
  assert.equal(cancelled.request.progress.cancelled, 3);
  assert.equal(cancelled.request.progress.remaining, 0);
  assert.equal(instance.cancelRequest("REQ-CANCELLED", 1_300).changed, false);
});

test("a queued task cancellation does not cascade to sibling work", () => {
  const { instance } = coordinator();
  const plan = instance.planRequest({
    requestId: "REQ-TASK-CANCEL",
    mode: "parallel",
    selectedAgents: ["tech", "data"],
  });
  const cancelled = instance.transitionTask(plan.tasks[0].taskId, "cancelled", 1_100);
  assert.equal(cancelled.request.status, "running");
  assert.equal(cancelled.request.cancelRequested, false);
  assert.equal(cancelled.request.progress.cancelled, 1);
  assert.equal(cancelled.request.progress.queued, 1);

  runAndFinish(instance, plan.tasks[1].taskId, "succeeded", 1_200, 1_300);
  assert.equal(instance.getRequest("REQ-TASK-CANCEL")?.status, "partial_failed");
});

test("coordinator exposes dispatch context while its compatibility claim remains FIFO", () => {
  const { instance } = coordinator();
  const older = instance.planRequest({
    requestId: "REQ-OLDER",
    mode: "parallel",
    selectedAgents: ["tech", "data"],
    createdAt: 1_000,
  });
  const lastTaskRequest = instance.planRequest({
    requestId: "REQ-LAST-TASK",
    mode: "parallel",
    selectedAgents: ["tech"],
    createdAt: 1_100,
  });

  const queue = instance.getAssigneeQueue("tech", 2_000);
  assert.deepEqual(queue.queue.map((task) => task.requestId), ["REQ-OLDER", "REQ-LAST-TASK"]);
  const olderContext = instance.getDispatchContext("REQ-OLDER", older.tasks[0].taskId, 2_000);
  const lastContext = instance.getDispatchContext("REQ-LAST-TASK", lastTaskRequest.tasks[0].taskId, 2_000);
  assert.equal(olderContext.remainingTasks, 2);
  assert.equal(olderContext.lastTask, false);
  assert.equal(lastContext.remainingTasks, 1);
  assert.equal(lastContext.lastTask, true);
  assert.equal(lastContext.waitingMs, 900);
  assert.equal(instance.claimNext("tech", 2_000)?.requestId, "REQ-OLDER");
});

test("snapshots expose exact aggregate counts", () => {
  const { instance } = coordinator();
  instance.planRequest({
    requestId: "REQ-FIRST",
    mode: "parallel",
    selectedAgents: ["tech", "data"],
  });
  instance.planRequest({
    requestId: "REQ-SECOND",
    mode: "parallel",
    selectedAgents: ["security"],
  });
  instance.claimNext("tech", 1_100);
  const snapshot = instance.snapshot(1_200);
  assert.equal(snapshot.counts.requests.total, 2);
  assert.equal(snapshot.counts.requests.running, 1);
  assert.equal(snapshot.counts.requests.queued, 1);
  assert.equal(snapshot.counts.requests.partial_failed, 0);
  assert.equal(snapshot.counts.tasks.total, 3);
  assert.equal(snapshot.counts.tasks.running, 1);
  assert.equal(snapshot.counts.tasks.queued, 2);
  assert.equal(snapshot.counts.tasks.succeeded, 0);
  assert.equal(snapshot.counts.tasks.skipped, 0);
});

test("planning is idempotent and returned snapshots cannot mutate internal state", () => {
  const { instance } = coordinator();
  const first = instance.planRequest({
    requestId: "REQ-IDEMPOTENT",
    mode: "proposed",
    selectedAgents: ["tech", "security"],
    useCommercialJudge: true,
  });
  const repeated = instance.planRequest({
    requestId: "REQ-IDEMPOTENT",
    mode: "proposed",
    selectedAgents: ["tech", "security", "tech"],
    useCommercialJudge: true,
  });
  assert.equal(first.created, true);
  assert.equal(repeated.created, false);
  assert.equal(instance.snapshot().counts.requests.total, 1);

  repeated.request.selectedAgents.splice(0);
  repeated.tasks[0].dependencyTaskIds.push("MUTATED");
  assert.deepEqual(instance.getRequest("REQ-IDEMPOTENT")?.selectedAgents, ["tech", "security"]);
  assert.doesNotMatch(JSON.stringify(instance.snapshot()), /MUTATED/);

  assert.throws(
    () => instance.planRequest({
      requestId: "REQ-IDEMPOTENT",
      mode: "proposed",
      selectedAgents: ["tech", "security"],
      useCommercialJudge: false,
    }),
    (error) => error instanceof CoordinatorError && error.code === "REQUEST_CONFLICT",
  );
});
