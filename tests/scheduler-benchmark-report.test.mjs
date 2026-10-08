import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const reportUrl = new URL("../reports/scheduler-benchmark-v1.json", import.meta.url);

test("scheduler benchmark enforces completion, throughput, and fairness gates", async () => {
  const report = JSON.parse(await readFile(reportUrl, "utf8"));
  assert.equal(report.reportVersion, "scheduler-benchmark-v1");
  assert.deepEqual(report.configuration.bursts, [10, 50]);
  assert.deepEqual(report.configuration.agentCounts, [1, 3, 8]);
  assert.equal(report.configuration.endpointCapacity, 1);
  assert.equal(report.acceptance.throughputLossWithinFivePercent, true);
  assert.equal(report.acceptance.completionReadyP50Improved, true);
  assert.equal(report.acceptance.noStarvation, true);
  assert.equal(report.acceptance.maxOvertakesRespected, true);
  assert.equal(report.acceptance.feasibleStrictWaitBoundsPassed, true);

  for (const comparison of report.comparisons) {
    assert.ok(comparison.throughputChangePercent >= -5);
    assert.ok(comparison.completionReadyP50ImprovementPercent > 0);
  }
  for (const scenario of report.scenarios.filter((item) => item.policy === "priority")) {
    assert.equal(scenario.starvationCount, 0);
    assert.ok(scenario.maxOvertakenCount <= report.configuration.maxOvertakes);
    const bound = scenario.strictGlobalWaitBound;
    if (bound.feasibleUnderBurst) {
      assert.equal(bound.status, "passed");
      assert.ok(bound.observedMaxQueueWaitMs <= bound.targetMs);
    } else {
      assert.equal(bound.status, "not-applicable-overloaded-burst");
      assert.ok(bound.offeredLoadLowerBoundMs > bound.targetMs);
      assert.match(bound.rationale, /no capacity-1 non-preemptive scheduler/i);
    }
  }
});
