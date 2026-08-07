import assert from "node:assert/strict";
import test from "node:test";

async function worker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("mnc16-test", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

const environment = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const context = { waitUntil() {}, passThroughOnException() {} };

async function orchestrate(query) {
  const runtime = await worker();
  const response = await runtime.fetch(
    new Request("http://localhost/api/orchestrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, mode: "proposed" }),
    }),
    environment,
    context,
  );
  if (response.status !== 200) {
    throw new Error(`orchestrate HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function orchestrateStream(query) {
  const runtime = await worker();
  const response = await runtime.fetch(
    new Request("http://localhost/api/orchestrate/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, mode: "proposed" }),
    }),
    environment,
    context,
  );
  assert.equal(response.status, 200);
  return (await response.text()).split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

test("MNC-16 exposes exactly one primary and skips support for a single-domain request", async () => {
  const result = await orchestrate("3년 예산과 총소유비용을 산정해 주세요.");
  assert.equal(result.routerDecision.version, "2");
  assert.equal(result.routerDecision.primaryAgent, "finance");
  assert.deepEqual(result.routerDecision.selected, ["finance"]);
  assert.deepEqual(result.routerDecision.supportingAgents, []);
  assert.deepEqual(result.routerDecision.adaptiveAdditions, []);
  assert.ok(result.routerDecision.requiredConcepts.length > 0);
  assert.equal(result.agents.filter((agent) => agent.executionRole === "primary").length, 1);
  assert.equal(result.agents.find((agent) => agent.id === "finance").executionRole, "primary");
  assert.equal(typeof result.routerDecision.predictedCoverage, "number");
  assert.equal(typeof result.routerDecision.objectiveCost, "number");
  assert.ok(result.routerDecision.rationale.length > 0);
  const selection = result.routerDecision.primarySelection;
  assert.equal(selection.algorithm, "hybrid-profile-v1");
  assert.equal(selection.rankedCandidates.length, 8);
  assert.equal(selection.hardGate.applied, false);
  assert.equal(selection.rankedCandidates[0].agentId, "finance");
  assert.equal(selection.rankedCandidates[0].rank, 1);
  assert.ok(selection.confidence >= 0 && selection.confidence <= 1);
  assert.ok(selection.top1Top2Margin >= 0 && selection.top1Top2Margin <= 1);
  for (const [index, candidate] of selection.rankedCandidates.entries()) {
    assert.equal(candidate.rank, index + 1);
    if (index) assert.ok(selection.rankedCandidates[index - 1].totalScore >= candidate.totalScore);
    for (const value of Object.values(candidate.components)) {
      assert.ok(value >= 0 && value <= 1);
    }
    assert.ok(Array.isArray(candidate.matchedTerms));
    assert.ok(Array.isArray(candidate.matchedEntities));
    assert.ok(Array.isArray(candidate.matchedConceptIds));
  }
});

test("personal data and procurement couplings force the mandatory reviewer roles", async () => {
  const personal = await orchestrate(
    "주민등록번호 900101-1234567과 010-1234-5678이 포함된 민원 기록의 처리 책임을 검토해 주세요.",
  );
  assert.equal(personal.routerDecision.securityLevel, "personal");
  assert.equal(personal.routerDecision.primaryAgent, "security");
  assert.equal(personal.routerDecision.primarySelection.hardGate.applied, true);
  assert.equal(personal.routerDecision.primarySelection.hardGate.forcedAgent, "security");
  assert.ok(personal.routerDecision.primarySelection.hardGate.reasons.includes("personal-data-security-owner"));
  assert.ok(personal.routerDecision.required.includes("security"));
  assert.ok(personal.routerDecision.required.includes("legal"));
  assert.ok(personal.agents.find((agent) => agent.id === "legal").selected);
  assert.doesNotMatch(JSON.stringify(personal), /900101-1234567|010-1234-5678/);

  const procurement = await orchestrate("AI 본사업 조달 입찰과 3년 예산을 함께 검토해 주세요.");
  assert.equal(procurement.routerDecision.primaryAgent, "procurement");
  assert.equal(procurement.routerDecision.primarySelection.hardGate.applied, true);
  assert.equal(procurement.routerDecision.primarySelection.hardGate.forcedAgent, "procurement");
  assert.ok(procurement.routerDecision.required.includes("procurement"));
  assert.ok(procurement.routerDecision.required.includes("finance"));
  assert.ok(procurement.agents.find((agent) => agent.id === "finance").selected);
});

test("low-signal routing exposes deterministic fallback and review reasons", async () => {
  const result = await orchestrate("관련 사항을 검토해 주세요.");
  const selection = result.routerDecision.primarySelection;
  assert.equal(selection.hardGate.applied, false);
  assert.equal(selection.fallbackUsed, true);
  assert.equal(selection.fallbackReason, "hybrid-score-below-threshold");
  assert.ok(selection.reviewReasons.some((reason) => reason.startsWith("hybrid-score-below-")));
  assert.ok(selection.reviewReasons.includes("no-domain-keyword-or-entity-signal"));
  assert.equal(result.routerDecision.humanReviewRequired, true);
});

test("negated privacy wording does not add security or legal reviewers", async () => {
  const result = await orchestrate(
    "개인정보가 없는 공개정보 질의응답 AI를 빠르게 구축할 최소 구성을 제시해 주세요.",
  );
  assert.equal(result.routerDecision.primaryAgent, "tech");
  assert.deepEqual(result.routerDecision.selected, ["tech"]);
  assert.equal(result.routerDecision.primarySelection.hardGate.applied, false);
  assert.equal(result.agents.find((agent) => agent.id === "security").selected, false);
  assert.equal(result.agents.find((agent) => agent.id === "legal").selected, false);
});

test("adaptive support starts only after the primary Edge result and reports the concept gate", async () => {
  const packets = await orchestrateStream(
    "공공 AI 시범사업의 PoC 성능 기준과 운영 전환 조건을 정해 주세요.",
  );
  const events = packets.filter((packet) => packet.type === "progress").map((packet) => packet.event);
  const result = packets.at(-1).result;
  assert.equal(result.routerDecision.primaryAgent, "tech");
  assert.ok(result.routerDecision.adaptiveAdditions.includes("operations"));
  assert.ok(result.routerDecision.supportingAgents.includes("operations"));
  const primaryComplete = events.findIndex((event) =>
    event.stage === "agent.completed" && event.agentId === result.routerDecision.primaryAgent
  );
  const adapted = events.findIndex((event) => event.stage === "agents.adapted");
  const supportStart = events.findIndex((event) =>
    event.stage === "agent.retrieving" && event.agentId === "operations"
  );
  assert.ok(primaryComplete >= 0 && primaryComplete < adapted);
  assert.ok(adapted < supportStart);
  assert.ok(events.findIndex((event) => event.stage === "router.decided") <
    events.findIndex((event) => event.stage === "agents.selected"));
  const routerEvent = events.find((event) => event.stage === "router.decided");
  assert.equal(routerEvent.routerDecision.primarySelection.algorithm, "hybrid-profile-v1");
  assert.equal(routerEvent.routerDecision.primarySelection.rankedCandidates.length, 8);
  assert.ok(events.some((event) => event.stage === "evidence.plan.ready"));
  assert.ok(result.evidencePlan);
  assert.equal(result.evidencePlan.coverage === null, false);
  assert.equal(
    result.evidencePlan.humanReviewRequired,
    result.evidencePlan.missingConceptIds.length > 0,
  );
});

test("Edge evidence metadata never uses raw mode and empty concepts stay unknown", async () => {
  process.env.EDGE_AGENT_ID = "security";
  process.env.EDGE_AGENT_SECURITY_TOKEN = "mnc16-edge-test-token";
  const runtime = await worker();
  try {
    const response = await runtime.fetch(
      new Request("https://edge.example/api/edge/agent", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-proto": "https",
          "x-edge-agent-id": "security",
          authorization: "Bearer mnc16-edge-test-token",
        },
        body: JSON.stringify({
          version: "1",
          requestId: "MNC16-EMPTY-CONCEPT",
          traceId: "MNC16-EMPTY-CONCEPT-TRACE",
          agentId: "security",
          purpose: "orchestration",
          minimalQuery: "공개 보안 지침을 검토해 주세요.",
          evidenceRequirements: { executionRole: "primary", requiredConceptIds: [] },
          limits: { topK: 3, deadlineMs: 5_000 },
        }),
      }),
      environment,
      context,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.evidencePlan.status, "unknown");
    assert.equal(body.evidencePlan.coverage, null);
    assert.equal(body.evidencePlan.humanReviewRequired, true);
    assert.ok(body.evidencePlan.decisions.every((decision) =>
      decision.mode === "sanitized" || decision.mode === "metadata-only"
    ));
    assert.ok(body.evidencePlan.decisions.every((decision) => decision.mode !== "raw"));
  } finally {
    delete process.env.EDGE_AGENT_ID;
    delete process.env.EDGE_AGENT_SECURITY_TOKEN;
  }
});

test("an authoritative Edge deny cannot be bypassed through another Agent", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "edge-deny.example") {
      const edgeRequest = JSON.parse(String(init?.body ?? "{}"));
      const requiredConceptIds = edgeRequest.evidenceRequirements?.requiredConceptIds ?? [];
      const payload = {
        version: "1",
        requestId: edgeRequest.requestId,
        agentId: edgeRequest.agentId,
        status: "denied",
        answer: {
          text: "Edge 정책이 이 요청의 처리를 거부했습니다.",
          classification: "public",
          citations: [],
        },
        evidence: [],
        evidencePlan: {
          strategy: "edge-policy-and-coverage",
          status: "denied",
          requiredConceptIds,
          coveredConceptIds: [],
          missingConceptIds: requiredConceptIds,
          coverage: requiredConceptIds.length ? 0 : null,
          minimumCoverage: 0.8,
          humanReviewRequired: true,
          decisions: [],
        },
        policy: {
          decisionId: "POL-AUTHORITATIVE-DENY",
          outcome: "deny",
          effectiveClasses: ["public", "internal", "confidential"],
          highestEvidenceClassification: null,
          redactionCount: 0,
          blockedCount: 1,
        },
        metrics: {
          backend: "deterministic",
          model: "edge-policy-deny",
          evidenceCount: 0,
          sourceBytesProcessed: 0,
          egressBytes: 0,
          latencyMs: 1,
          ttftMs: null,
          tpotMs: null,
          corpusChunks: 0,
        },
        boundary: {
          transport: "http",
          rawCorpusTransferred: false,
          returnedBytes: 0,
          evidencePayloadBytes: 2,
          restrictedEvidenceCount: 0,
        },
        audit: {
          eventId: "AUD-AUTHORITATIVE-DENY",
          recordedAt: new Date().toISOString(),
          policyVersion: "edge-rag-v1",
        },
      };
      for (let index = 0; index < 8; index += 1) {
        const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
        payload.metrics.egressBytes = bytes;
        payload.boundary.returnedBytes = bytes;
      }
      return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    }
    return originalFetch(input, init);
  };
  process.env.EDGE_AGENT_MODE = "remote";
  process.env.EDGE_AGENT_BASE_URL = "https://edge-deny.example";
  process.env.EDGE_AGENT_SECURITY_TOKEN = "authoritative-deny-token";
  try {
    const packets = await orchestrateStream("주민등록번호 900101-1234567이 포함된 민원 기록의 법적 책임을 검토해 주세요.");
    const finalPacket = packets.at(-1);
    assert.equal(finalPacket.type, "result", finalPacket.error);
    const result = finalPacket.result;
    assert.equal(result.status, "review");
    assert.equal(result.routerDecision.primaryAgent, "security");
    assert.deepEqual(result.routerDecision.selected, ["security"]);
    assert.ok(result.routerDecision.rationale.some((item) => item.includes("우회하지 않고")));
    assert.equal(result.agents.find((agent) => agent.id === "legal").selected, false);
    assert.equal(result.evidencePlan.humanReviewRequired, true);
  } finally {
    delete process.env.EDGE_AGENT_MODE;
    delete process.env.EDGE_AGENT_BASE_URL;
    delete process.env.EDGE_AGENT_SECURITY_TOKEN;
    globalThis.fetch = originalFetch;
  }
});
