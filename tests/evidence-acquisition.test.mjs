import assert from "node:assert/strict";
import { fork } from "node:child_process";
import test from "node:test";
import { allowed, coverage, transform } from "../emulation/runtime.mjs";
import { planEvidence } from "../lib/evidence-acquisition.ts";
import securityManifest from "../data/security-evidence-manifest.json" with { type: "json" };

async function applicationWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("evidence-test", `${process.pid}-${Date.now()}`);
  return (await import(workerUrl.href)).default;
}

test("hard policy blocks personal raw crossing and permits confidential owner-local raw", () => {
  assert.equal(allowed("personal", "raw", "security", "legal", "core"), false);
  assert.equal(allowed("confidential", "raw", "security", "security", "security"), true);
  assert.equal(allowed("internal", "raw", "security", "security", "security"), true);
});

test("transformations redact sensitive fields, keep evidence handles, and omit metadata content", () => {
  const base = { id: "E-1", canonicalId: "C-1", title: "Access control", section: "RBAC", ownerDepartment: "security", securityLevel: "personal", effectiveDate: "2026-08-06", text: "Call 010-1234-5678 about access control.", requiredConcepts: ["access control"] };
  const sanitized = transform(base, "sanitized");
  assert.doesNotMatch(sanitized.evidence.content, /010-1234-5678/);
  assert.ok(sanitized.removedSensitiveFieldCount > 0);
  const summary = transform(base, "local-summary");
  assert.match(summary.evidence.content, /\[evidence:E-1\]/);
  assert.ok(coverage(base.requiredConcepts, summary.evidence) > 0);
  const metadata = transform(base, "metadata-only");
  assert.equal("content" in metadata.evidence, false);
});

test("fixed gateway and proxy use actual HTTP with reproducible injected delay", { timeout: 15000 }, async () => {
  const supervisor = fork(new URL("../emulation/emulation-supervisor.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("startup timeout")), 8000); supervisor.on("message", (message) => { if (message?.type === "ready") { clearTimeout(timer); resolve(); } }); });
  try {
    const request = { ownerDepartment: "security", documentId: "E-HTTP", derivedDocument: { id: "E-HTTP", canonicalId: "C-HTTP", title: "Access", section: "Policy", ownerDepartment: "security", securityLevel: "personal", effectiveDate: "2026-08-06", text: "access 010-1234-5678", verifiedConcepts: ["access"] }, mode: "sanitized", securityLevel: "personal", requesterRole: "security", requesterZone: "core", requiredConcepts: ["access"], networkScenario: "low-bandwidth", seed: 42 };
    const first = await fetch("http://127.0.0.1:4400/proxy/fetch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) }).then((response) => response.json());
    const second = await fetch("http://127.0.0.1:4400/proxy/fetch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) }).then((response) => response.json());
    assert.equal(first.selectedMode, "sanitized");
    assert.equal(first.policyStatus, "allowed");
    assert.equal(first.labelBasedCoverage, 1);
    assert.ok(first.emulatedNetworkDelayMs > 45);
    assert.equal(first.seededBaseDelayMs, second.seededBaseDelayMs);
    const metadata = await fetch("http://127.0.0.1:4400/proxy/fetch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, mode: "metadata-only" }) }).then((response) => response.json());
    assert.equal(metadata.labelBasedCoverage, 1);
    assert.equal(metadata.runtimeProxyCoverage, 0);
    assert.equal("content" in metadata.evidence, false);
  } finally { supervisor.kill("SIGTERM"); }
});

test("evidence planning API escalates when no mode satisfies coverage", async () => {
  const runtime = await applicationWorker();
  const response = await runtime.fetch(new Request("http://localhost/api/evidence/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "Assess the evidence boundary for this request", selectedRoles: ["security"], requiredConcepts: ["concept-that-does-not-exist"], evidenceStrategy: "axnetcc-saea", networkScenario: "normal" }),
  }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  const plan = await response.json();
  assert.equal(plan.infeasible, true);
  assert.equal(plan.humanReviewRequired, true);
  assert.deepEqual(plan.decisions, []);
  assert.deepEqual(plan.infeasibleRoles, ["security"]);
  assert.ok(plan.policyTrace.length > 0);
  assert.ok(plan.coverageTrace.every((item) => item.accepted === false));
});

test("planner applies role-specific coverage thresholds", () => {
  const scenario = { name: "normal", latencyMs: 8, jitterMs: 0, bandwidthBytesPerSecond: 10_000_000, lossRate: 0, timeoutMs: 3000, ownerProcessingMultiplier: 1 };
  const candidate = { id: "ROLE-COVERAGE", canonicalId: "ROLE-COVERAGE", title: "alpha beta gamma", section: "evidence", ownerDepartment: "legal", securityLevel: "public", effectiveDate: "2026-08-06", text: "alpha beta gamma", requiredConcepts: ["alpha", "beta", "gamma", "delta"] };
  const legal = planEvidence({ query: "coverage", selectedRoles: ["legal"], candidateEvidenceByRole: { legal: [candidate] }, strategy: "axnetcc-saea", networkScenario: scenario, requesterZone: "core" });
  assert.equal(legal.infeasible, true, "legal requires 0.80, so 0.75 coverage must be rejected");
  const techCandidate = { ...candidate, ownerDepartment: "tech" };
  const tech = planEvidence({ query: "coverage", selectedRoles: ["tech"], candidateEvidenceByRole: { tech: [techCandidate] }, strategy: "axnetcc-saea", networkScenario: scenario, requesterZone: "core" });
  assert.equal(tech.infeasible, false, "tech requires 0.70, so 0.75 coverage is feasible");
});

test("synthetic security profile seeds are distinct and keep direct identifiers personal", () => {
  const profiles = securityManifest.syntheticSecurityProfiles;
  assert.notDeepEqual(profiles["17"], profiles["29"]);
  assert.notDeepEqual(profiles["29"], profiles["43"]);
  for (const seed of ["17", "29", "43"]) {
    assert.equal(profiles[seed].Q005.security, "personal");
    assert.equal(profiles[seed].Q005.legal, "personal");
  }
});
