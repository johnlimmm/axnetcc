import assert from "node:assert/strict";
import test from "node:test";

import {
  EndpointScheduler,
  EndpointSchedulerError,
  canonicalResourceKey,
} from "../lib/endpoint-scheduler.ts";

class FakeClock {
  constructor(start = 0) {
    this.value = start;
    this.nextTimerId = 1;
    this.timers = new Map();
  }

  now() {
    return this.value;
  }

  setTimeout(callback, delayMs) {
    const id = this.nextTimerId++;
    this.timers.set(id, {
      id,
      at: this.value + Math.max(0, delayMs),
      callback,
    });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush(turns = 8) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

function scheduler(clock, options = {}) {
  return new EndpointScheduler({
    clock,
    agingThresholdMs: 10_000,
    maxOvertakes: 3,
    deadlineUrgencyMs: 0,
    ...options,
  });
}

function enqueue(instance, clock, input) {
  return instance.enqueue({
    requestId: input.requestId ?? `REQ-${input.taskId}`,
    taskId: input.taskId,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    taskKind: input.taskKind ?? "agent",
    stage: input.stage ?? "agent-inference",
    resourceKey: input.resourceKey ?? "ollama:http://localhost:11434/",
    attempt: input.attempt ?? 1,
    deadlineAt: input.deadlineAt ?? clock.now() + 10_000,
    ...(input.signal ? { signal: input.signal } : {}),
    execute: input.execute,
  });
}

test("canonicalResourceKey normalizes case, default ports, trailing slashes, query, and hash", () => {
  assert.equal(
    canonicalResourceKey("HTTP://LOCALHOST:80/api/chat/?ignored=1#fragment"),
    "ollama:http://localhost/api/chat",
  );
  assert.equal(
    canonicalResourceKey("https://Example.COM:443/", "EDGE"),
    "edge:https://example.com",
  );
});

test("one resource keeps enqueue FIFO when no priority condition applies", async () => {
  const clock = new FakeClock();
  const instance = scheduler(clock);
  const running = deferred();
  const order = [];
  const first = enqueue(instance, clock, {
    taskId: "X",
    execute: () => {
      order.push("X");
      return running.promise;
    },
  });
  clock.advance(1);
  const second = enqueue(instance, clock, {
    taskId: "A",
    execute: () => {
      order.push("A");
      return "A";
    },
  });
  clock.advance(1);
  const third = enqueue(instance, clock, {
    taskId: "B",
    execute: () => {
      order.push("B");
      return "B";
    },
  });

  assert.deepEqual(order, ["X"]);
  clock.advance(8);
  running.resolve("X");
  const [, a, b] = await Promise.all([first, second, third]);
  assert.deepEqual(order, ["X", "A", "B"]);
  assert.equal(a.metrics.dispatchReason, "fifo");
  assert.equal(b.metrics.dispatchReason, "fifo");
});

test("different resource keys execute concurrently", async () => {
  const clock = new FakeClock();
  const instance = scheduler(clock);
  const leftGate = deferred();
  const rightGate = deferred();
  const started = [];
  const left = enqueue(instance, clock, {
    taskId: "left",
    resourceKey: "ollama:http://localhost:11441",
    execute: () => {
      started.push("left");
      return leftGate.promise;
    },
  });
  const right = enqueue(instance, clock, {
    taskId: "right",
    resourceKey: "ollama:http://localhost:11442",
    execute: () => {
      started.push("right");
      return rightGate.promise;
    },
  });

  assert.deepEqual(started, ["left", "right"]);
  assert.equal(instance.snapshot().length, 2);
  assert.ok(instance.snapshot().every((item) => item.activeCount === 1));
  leftGate.resolve("left");
  rightGate.resolve("right");
  await Promise.all([left, right]);
});

test("logical Agents sharing a canonical URL share capacity one", async () => {
  const clock = new FakeClock();
  const instance = scheduler(clock);
  const gate = deferred();
  const started = [];
  const tech = enqueue(instance, clock, {
    taskId: "tech-task",
    agentId: "tech",
    resourceKey: "ollama:HTTP://LOCALHOST:11434/",
    execute: () => {
      started.push("tech");
      return gate.promise;
    },
  });
  const legal = enqueue(instance, clock, {
    taskId: "legal-task",
    agentId: "legal",
    resourceKey: "ollama:http://localhost:11434",
    execute: () => {
      started.push("legal");
      return "legal";
    },
  });

  assert.deepEqual(started, ["tech"]);
  assert.equal(instance.snapshot()[0].queueDepth, 1);
  gate.resolve("tech");
  await Promise.all([tech, legal]);
  assert.deepEqual(started, ["tech", "legal"]);
});

test("snapshot reports active count, queue depth, per-item wait, and oldest wait", () => {
  const clock = new FakeClock();
  const instance = scheduler(clock);
  const gate = deferred();
  void enqueue(instance, clock, { taskId: "X", execute: () => gate.promise });
  clock.advance(2);
  void enqueue(instance, clock, { taskId: "A", execute: () => "A" });
  clock.advance(3);
  void enqueue(instance, clock, { taskId: "B", execute: () => "B" });
  clock.advance(5);

  const [snapshot] = instance.snapshot("ollama:http://localhost:11434/");
  assert.equal(snapshot.activeCount, 1);
  assert.equal(snapshot.queueDepth, 2);
  assert.equal(snapshot.oldestWaitMs, 8);
  assert.deepEqual(snapshot.queued.map((item) => item.waitMs), [8, 5]);
  assert.deepEqual(snapshot.queued.map((item) => item.taskId), ["A", "B"]);
  gate.resolve("X");
});

test("a cancelled queued task is removed and never reaches execute", async () => {
  const clock = new FakeClock();
  const instance = scheduler(clock);
  const gate = deferred();
  const controller = new AbortController();
  let called = false;
  const running = enqueue(instance, clock, { taskId: "X", execute: () => gate.promise });
  const queued = enqueue(instance, clock, {
    taskId: "A",
    signal: controller.signal,
    execute: () => {
      called = true;
      return "A";
    },
  });
  const rejected = assert.rejects(
    queued,
    (error) => error instanceof EndpointSchedulerError &&
      error.code === "TASK_CANCELLED" &&
      error.metrics?.dispatchReason === null,
  );
  clock.advance(4);
  controller.abort("caller left");
  await rejected;
  assert.equal(called, false);
  assert.equal(instance.snapshot()[0].queueDepth, 0);
  gate.resolve("X");
  await running;
});

test("a queued task that reaches its absolute deadline is never dispatched", async () => {
  const clock = new FakeClock();
  const instance = scheduler(clock);
  const gate = deferred();
  let called = false;
  const running = enqueue(instance, clock, { taskId: "X", execute: () => gate.promise });
  const queued = enqueue(instance, clock, {
    taskId: "A",
    deadlineAt: 5,
    execute: () => {
      called = true;
      return "A";
    },
  });
  const rejected = assert.rejects(
    queued,
    (error) => error instanceof EndpointSchedulerError &&
      error.code === "TASK_DEADLINE_EXCEEDED" &&
      error.metrics?.queueWaitMs === 5 &&
      error.metrics?.deadlineAt === 5 &&
      error.metrics?.aborted === true,
  );
  clock.advance(5);
  await rejected;
  assert.equal(called, false);
  gate.resolve("X");
  await running;
});

test("cancelling a running task aborts it and returns the slot", async () => {
  const clock = new FakeClock();
  const instance = scheduler(clock);
  const order = [];
  const running = enqueue(instance, clock, {
    taskId: "X",
    execute: (signal) => new Promise((resolve, reject) => {
      order.push("X");
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  const next = enqueue(instance, clock, {
    taskId: "A",
    execute: () => {
      order.push("A");
      return "A";
    },
  });
  const rejected = assert.rejects(
    running,
    (error) => error instanceof EndpointSchedulerError && error.code === "TASK_CANCELLED",
  );
  assert.equal(instance.cancelTask("X", "user cancelled"), true);
  await rejected;
  await next;
  assert.deepEqual(order, ["X", "A"]);
});

test("an aborted caller cannot release the physical slot before execution drains", async () => {
  const clock = new FakeClock();
  const instance = scheduler(clock);
  const gate = deferred();
  const order = [];
  const running = enqueue(instance, clock, {
    taskId: "X",
    execute: () => {
      order.push("X");
      return gate.promise;
    },
  });
  const next = enqueue(instance, clock, {
    taskId: "A",
    execute: () => {
      order.push("A");
      return "A";
    },
  });
  const rejected = assert.rejects(
    running,
    (error) => error instanceof EndpointSchedulerError && error.code === "TASK_CANCELLED",
  );

  instance.cancelTask("X", "user cancelled");
  await rejected;
  await flush();
  assert.deepEqual(order, ["X"]);
  assert.equal(instance.snapshot()[0].activeCount, 1);
  assert.equal(instance.snapshot()[0].queueDepth, 1);

  gate.resolve("late completion");
  await next;
  assert.deepEqual(order, ["X", "A"]);
});

test("execution failure releases the slot and the next task proceeds", async () => {
  const clock = new FakeClock();
  const instance = scheduler(clock);
  const order = [];
  const failed = enqueue(instance, clock, {
    taskId: "X",
    execute: () => {
      order.push("X");
      throw new Error("mock failure");
    },
  });
  const next = enqueue(instance, clock, {
    taskId: "A",
    execute: () => {
      order.push("A");
      return "A";
    },
  });

  await assert.rejects(
    failed,
    (error) => error instanceof EndpointSchedulerError &&
      error.code === "TASK_EXECUTION_FAILED" &&
      error.cause?.message === "mock failure",
  );
  await next;
  assert.deepEqual(order, ["X", "A"]);
});

test("a running deadline aborts execution and returns the slot", async () => {
  const clock = new FakeClock();
  const instance = scheduler(clock);
  const order = [];
  const timedOut = enqueue(instance, clock, {
    taskId: "X",
    deadlineAt: 5,
    execute: (signal) => new Promise((resolve, reject) => {
      order.push("X");
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  const next = enqueue(instance, clock, {
    taskId: "A",
    deadlineAt: 100,
    execute: () => {
      order.push("A");
      return "A";
    },
  });
  const rejected = assert.rejects(
    timedOut,
    (error) => error instanceof EndpointSchedulerError &&
      error.code === "TASK_DEADLINE_EXCEEDED" &&
      error.metrics?.inferenceMs === 5,
  );
  clock.advance(5);
  await rejected;
  await next;
  assert.deepEqual(order, ["X", "A"]);
});

test("metrics separate queue wait, inference, and scheduler end-to-end time", async () => {
  const clock = new FakeClock();
  const instance = scheduler(clock);
  const firstGate = deferred();
  const secondGate = deferred();
  const first = enqueue(instance, clock, { taskId: "X", execute: () => firstGate.promise });
  clock.advance(2);
  const second = enqueue(instance, clock, { taskId: "A", execute: () => secondGate.promise });
  clock.advance(8);
  firstGate.resolve("X");
  await flush();
  clock.advance(5);
  secondGate.resolve("A");
  const [, result] = await Promise.all([first, second]);

  assert.equal(result.metrics.queueWaitMs, 8);
  assert.equal(result.metrics.inferenceMs, 5);
  assert.equal(result.metrics.endToEndMs, 13);
  assert.equal(result.metrics.aborted, false);
  assert.equal(
    result.metrics.endToEndMs,
    result.metrics.queueWaitMs + result.metrics.inferenceMs,
  );
});

test("last-task context reorders X, A, B into X, B, A and records the reason", async () => {
  const clock = new FakeClock();
  const reads = new Map();
  const instance = scheduler(clock, {
    getDispatchContext(metadata) {
      reads.set(metadata.taskId, (reads.get(metadata.taskId) ?? 0) + 1);
      return { remainingCount: metadata.requestId === "REQ-LAST" ? 1 : 2 };
    },
  });
  const gate = deferred();
  const order = [];
  const x = enqueue(instance, clock, {
    taskId: "X",
    execute: () => {
      order.push("X");
      return gate.promise;
    },
  });
  const a = enqueue(instance, clock, {
    requestId: "REQ-A",
    taskId: "A",
    execute: () => {
      order.push("A");
      return "A";
    },
  });
  const b = enqueue(instance, clock, {
    requestId: "REQ-LAST",
    taskId: "B",
    execute: () => {
      order.push("B");
      return "B";
    },
  });
  gate.resolve("X");
  const [, , resultB] = await Promise.all([x, a, b]);

  assert.deepEqual(order, ["X", "B", "A"]);
  assert.equal(resultB.metrics.dispatchReason, "last-task");
  assert.ok(reads.get("B") >= 2, "last-task was not rechecked immediately before dispatch");
});

test("audit completion is visible to last-task selection before slot release", async () => {
  const clock = new FakeClock();
  let requestBRemaining = 2;
  const instance = scheduler(clock, {
    getDispatchContext(metadata) {
      return {
        remainingCount: metadata.requestId === "REQ-B" ? requestBRemaining : 2,
      };
    },
    onAudit(metrics) {
      if (metrics.taskId === "B1" && metrics.outcome === "succeeded") {
        requestBRemaining = 1;
      }
    },
  });
  const gate = deferred();
  const order = [];
  const b1 = enqueue(instance, clock, {
    requestId: "REQ-B",
    taskId: "B1",
    execute: () => {
      order.push("B1");
      return gate.promise;
    },
  });
  const a1 = enqueue(instance, clock, {
    requestId: "REQ-A",
    taskId: "A1",
    execute: () => {
      order.push("A1");
      return "A1";
    },
  });
  const b2 = enqueue(instance, clock, {
    requestId: "REQ-B",
    taskId: "B2",
    execute: () => {
      order.push("B2");
      return "B2";
    },
  });

  gate.resolve("B1");
  const [, , b2Result] = await Promise.all([b1, a1, b2]);
  assert.deepEqual(order, ["B1", "B2", "A1"]);
  assert.equal(b2Result.metrics.dispatchReason, "last-task");
});

test("multiple last-task candidates preserve candidate FIFO", async () => {
  const clock = new FakeClock();
  const instance = scheduler(clock, {
    getDispatchContext: (metadata) => ({
      remainingCount: metadata.requestId.startsWith("REQ-LAST") ? 1 : 2,
    }),
  });
  const gate = deferred();
  const order = [];
  const promises = [enqueue(instance, clock, {
    taskId: "X",
    execute: () => {
      order.push("X");
      return gate.promise;
    },
  })];
  for (const [taskId, requestId] of [
    ["A", "REQ-A"],
    ["B", "REQ-LAST-1"],
    ["C", "REQ-LAST-2"],
  ]) {
    promises.push(enqueue(instance, clock, {
      taskId,
      requestId,
      execute: () => {
        order.push(taskId);
        return taskId;
      },
    }));
  }
  gate.resolve("X");
  await Promise.all(promises);
  assert.deepEqual(order, ["X", "B", "C", "A"]);
});

test("a stale last-task snapshot is rejected by the dispatch-time recheck", async () => {
  const clock = new FakeClock();
  let bReads = 0;
  const instance = scheduler(clock, {
    getDispatchContext(metadata) {
      if (metadata.taskId !== "B") return { remainingCount: 2 };
      bReads += 1;
      return { remainingCount: bReads === 1 ? 1 : 2, requestVersion: bReads };
    },
  });
  const gate = deferred();
  const order = [];
  const x = enqueue(instance, clock, {
    taskId: "X",
    execute: () => {
      order.push("X");
      return gate.promise;
    },
  });
  const a = enqueue(instance, clock, {
    taskId: "A",
    execute: () => {
      order.push("A");
      return "A";
    },
  });
  const b = enqueue(instance, clock, {
    taskId: "B",
    execute: () => {
      order.push("B");
      return "B";
    },
  });
  gate.resolve("X");
  const [, resultA] = await Promise.all([x, a, b]);
  assert.deepEqual(order, ["X", "A", "B"]);
  assert.equal(resultA.metrics.dispatchReason, "fifo");
  assert.ok(bReads >= 2);
});

test("FIFO skips a dependency-pending task until Coordinator marks it ready", async () => {
  const clock = new FakeClock();
  let aReady = false;
  const instance = scheduler(clock, {
    getDispatchContext(metadata) {
      return {
        ready: metadata.taskId === "A" ? aReady : true,
        requestStatus: "running",
        taskStatus: "queued",
        remainingTasks: 2,
      };
    },
  });
  const gate = deferred();
  const order = [];
  const x = enqueue(instance, clock, {
    taskId: "X",
    execute: () => {
      order.push("X");
      return gate.promise;
    },
  });
  const a = enqueue(instance, clock, {
    taskId: "A",
    execute: () => {
      order.push("A");
      return "A";
    },
  });
  const b = enqueue(instance, clock, {
    taskId: "B",
    execute: () => {
      order.push("B");
      aReady = true;
      return "B";
    },
  });

  gate.resolve("X");
  await Promise.all([x, a, b]);
  assert.deepEqual(order, ["X", "B", "A"]);
});

test("refresh dispatches a task whose dependency completed on another resource", async () => {
  const clock = new FakeClock();
  let dependentReady = false;
  let instance;
  instance = scheduler(clock, {
    getDispatchContext(metadata) {
      return {
        ready: metadata.taskId === "A" ? dependentReady : true,
        requestStatus: "running",
        taskStatus: "queued",
      };
    },
    onAudit(metrics) {
      if (metrics.taskId === "X" && metrics.outcome === "succeeded") {
        dependentReady = true;
        instance.refresh();
      }
    },
  });
  const gate = deferred();
  const order = [];
  const x = enqueue(instance, clock, {
    taskId: "X",
    resourceKey: "ollama:http://localhost:11434",
    execute: () => {
      order.push("X");
      return gate.promise;
    },
  });
  const a = enqueue(instance, clock, {
    taskId: "A",
    resourceKey: "edge:http://localhost:3001/api/edge/agent",
    execute: () => {
      order.push("A");
      return "A";
    },
  });
  await flush();
  assert.deepEqual(order, ["X"]);

  gate.resolve("X");
  await Promise.all([x, a]);
  assert.deepEqual(order, ["X", "A"]);
});

test("terminal Coordinator tasks are removed before FIFO dispatch", async () => {
  const clock = new FakeClock();
  const instance = scheduler(clock, {
    getDispatchContext(metadata) {
      return metadata.taskId === "A"
        ? { ready: false, requestStatus: "cancelled", taskStatus: "cancelled" }
        : { ready: true, requestStatus: "running", taskStatus: "queued" };
    },
  });
  const gate = deferred();
  const order = [];
  const x = enqueue(instance, clock, {
    taskId: "X",
    execute: () => {
      order.push("X");
      return gate.promise;
    },
  });
  const a = enqueue(instance, clock, {
    taskId: "A",
    execute: () => {
      order.push("A");
      return "A";
    },
  });
  const b = enqueue(instance, clock, {
    taskId: "B",
    execute: () => {
      order.push("B");
      return "B";
    },
  });
  const aRejected = assert.rejects(
    a,
    (error) => error instanceof EndpointSchedulerError && error.code === "TASK_CANCELLED",
  );

  gate.resolve("X");
  await Promise.all([x, aRejected, b]);
  assert.deepEqual(order, ["X", "B"]);
});

test("aging makes an old FIFO head win over a last-task candidate", async () => {
  const clock = new FakeClock();
  const instance = scheduler(clock, {
    agingThresholdMs: 10,
    getDispatchContext: (metadata) => ({ remainingCount: metadata.taskId === "B" ? 1 : 2 }),
  });
  const gate = deferred();
  const order = [];
  const x = enqueue(instance, clock, {
    taskId: "X",
    execute: () => {
      order.push("X");
      return gate.promise;
    },
  });
  const a = enqueue(instance, clock, {
    taskId: "A",
    execute: () => {
      order.push("A");
      return "A";
    },
  });
  clock.advance(5);
  const b = enqueue(instance, clock, {
    taskId: "B",
    execute: () => {
      order.push("B");
      return "B";
    },
  });
  clock.advance(5);
  gate.resolve("X");
  const [, resultA] = await Promise.all([x, a, b]);
  assert.deepEqual(order, ["X", "A", "B"]);
  assert.equal(resultA.metrics.dispatchReason, "aging");
});

test("maximum overtakes guarantees that the original FIFO head runs next", async () => {
  const clock = new FakeClock();
  const instance = scheduler(clock, {
    maxOvertakes: 1,
    getDispatchContext: (metadata) => ({
      remainingCount: metadata.taskId === "B" || metadata.taskId === "C" ? 1 : 2,
    }),
  });
  const xGate = deferred();
  const bGate = deferred();
  const order = [];
  const x = enqueue(instance, clock, {
    taskId: "X",
    execute: () => {
      order.push("X");
      return xGate.promise;
    },
  });
  const a = enqueue(instance, clock, {
    taskId: "A",
    execute: () => {
      order.push("A");
      return "A";
    },
  });
  const b = enqueue(instance, clock, {
    taskId: "B",
    execute: () => {
      order.push("B");
      return bGate.promise;
    },
  });
  xGate.resolve("X");
  await flush();
  assert.deepEqual(order, ["X", "B"]);
  const c = enqueue(instance, clock, {
    taskId: "C",
    execute: () => {
      order.push("C");
      return "C";
    },
  });
  bGate.resolve("B");
  const [, resultA] = await Promise.all([x, a, b, c]);
  assert.deepEqual(order, ["X", "B", "A", "C"]);
  assert.equal(resultA.metrics.dispatchReason, "aging");
});

test("a near-deadline task is dispatched before last-task and FIFO candidates", async () => {
  const clock = new FakeClock();
  const instance = scheduler(clock, {
    deadlineUrgencyMs: 15,
    getDispatchContext: (metadata) => ({ remainingCount: metadata.taskId === "C" ? 1 : 2 }),
  });
  const gate = deferred();
  const order = [];
  const x = enqueue(instance, clock, {
    taskId: "X",
    deadlineAt: 1_000,
    execute: () => {
      order.push("X");
      return gate.promise;
    },
  });
  const a = enqueue(instance, clock, {
    taskId: "A",
    deadlineAt: 100,
    execute: () => {
      order.push("A");
      return "A";
    },
  });
  const b = enqueue(instance, clock, {
    taskId: "B",
    deadlineAt: 20,
    execute: () => {
      order.push("B");
      return "B";
    },
  });
  const c = enqueue(instance, clock, {
    taskId: "C",
    deadlineAt: 100,
    execute: () => {
      order.push("C");
      return "C";
    },
  });
  clock.advance(10);
  gate.resolve("X");
  const [, , resultB] = await Promise.all([x, a, b, c]);
  assert.deepEqual(order, ["X", "B", "C", "A"]);
  assert.equal(resultB.metrics.dispatchReason, "deadline");
});

test("Managed Supervisor metadata participates in last-task selection", async () => {
  const clock = new FakeClock();
  const instance = scheduler(clock, {
    getDispatchContext: (metadata) => {
      const remainingTasks = metadata.taskKind === "managed-supervisor" ? 1 : 2;
      return {
        remainingTasks,
        lastTask: remainingTasks === 1,
        ready: true,
        requestStatus: "running",
        taskStatus: "queued",
      };
    },
  });
  const gate = deferred();
  const order = [];
  const x = enqueue(instance, clock, {
    taskId: "X",
    execute: () => {
      order.push("X");
      return gate.promise;
    },
  });
  const agent = enqueue(instance, clock, {
    taskId: "A",
    execute: () => {
      order.push("A");
      return "A";
    },
  });
  const supervisor = enqueue(instance, clock, {
    requestId: "REQ-MANAGED",
    taskId: "SUPERVISOR",
    taskKind: "managed-supervisor",
    stage: "central-integration",
    execute: () => {
      order.push("SUPERVISOR");
      return "integrated";
    },
  });
  gate.resolve("X");
  const [, , result] = await Promise.all([x, agent, supervisor]);
  assert.deepEqual(order, ["X", "SUPERVISOR", "A"]);
  assert.equal(result.metrics.dispatchReason, "last-task");
  assert.equal(result.metrics.taskKind, "managed-supervisor");
});

test("audit callbacks receive reason and wait metadata but cannot block slot release", async () => {
  const clock = new FakeClock();
  const audits = [];
  const instance = scheduler(clock, {
    onAudit(metrics) {
      audits.push(metrics);
      throw new Error("audit sink unavailable");
    },
  });
  const order = [];
  const first = enqueue(instance, clock, {
    taskId: "X",
    execute: () => {
      order.push("X");
      return "X";
    },
  });
  const second = enqueue(instance, clock, {
    taskId: "A",
    execute: () => {
      order.push("A");
      return "A";
    },
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["X", "A"]);
  assert.equal(audits.length, 2);
  assert.deepEqual(
    Object.keys(audits[0]).filter((key) => /query|evidence|prompt|output/i.test(key)),
    [],
  );
  assert.equal(audits[0].dispatchReason, "fifo");
  assert.equal(typeof audits[0].queueWaitMs, "number");
});
