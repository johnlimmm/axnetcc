import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

async function worker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  return (await import(workerUrl.href)).default;
}

const environment = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const context = { waitUntil() {}, passThroughOnException() {} };

async function orchestrateWithRuntime(runtime, query, mode = "proposed", commercialJudge = false) {
  const response = await runtime.fetch(
    new Request("http://localhost/api/orchestrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, mode, commercialJudge }),
    }),
    environment,
    context,
  );
  assert.equal(
    response.status,
    200,
    response.status === 200 ? undefined : await response.clone().text(),
  );
  return response.json();
}

async function orchestrate(query, mode = "proposed", commercialJudge = false) {
  return orchestrateWithRuntime(await worker(), query, mode, commercialJudge);
}

function ollamaEvidenceId(payload) {
  return payload.messages?.[1]?.content?.match(/\[([^\]]+)\]/)?.[1] ?? "UNKNOWN";
}

function sendOllamaNdjson(response, text) {
  response.writeHead(200, { "content-type": "application/x-ndjson" });
  response.end(`${JSON.stringify({
    message: { content: text },
    done: true,
    prompt_eval_count: 12,
    eval_count: text ? 8 : 0,
    eval_duration: text ? 80_000_000 : 0,
  })}\n`);
}

async function orchestrateStream(query, mode = "proposed") {
  const runtime = await worker();
  const response = await runtime.fetch(
    new Request("http://localhost/api/orchestrate/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, mode }),
    }),
    environment,
    context,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/x-ndjson/);
  return (await response.text())
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);
}

test("serves the finished Korean governance workspace", async () => {
  const runtime = await worker();
  const response = await runtime.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    environment,
    context,
  );
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /MNC FLOW/);
  assert.match(html, /AXNetCC/);
  assert.match(html, /Security-Aware Evidence Acquisition/);
  assert.match(html, /요청 처리 시작/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview/);
});

test("returns sanitized public previews while restricted evidence stays reference-only", async () => {
  const result = await orchestrate(
    "공공기관 생성형 AI 도입의 기술, 개인정보 보안, 계약 책임, 조달 예산을 검토해 주세요.",
    "parallel",
  );
  assert.equal(result.metrics.ragChunks, 3027);
  for (const agent of result.agents) {
    assert.ok(agent.evidence.length >= 1, `${agent.id} has no evidence`);
    for (const item of agent.evidence) {
      if (item.classification === "public") {
        assert.equal(item.disclosure, "sanitized-preview");
        assert.ok(item.title.length > 0);
        assert.ok(item.excerpt.length > 0);
      } else {
        assert.equal(item.disclosure, "reference-only");
        assert.equal(Object.hasOwn(item, "sourceUrl"), false);
      }
    }
    assert.ok(agent.evidence.every((item) => item.retrievalScore > 0));
    assert.ok(agent.report);
    assert.ok(agent.report.citationIds.every((id) => agent.evidence.some((item) => item.id === id)));
  }
  assert.ok(result.report);
  assert.deepEqual(new Set(result.report.participatingAgentIds), new Set(result.agents.map((agent) => agent.id)));
});

test("report components render integrated and Agent report documents", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /data-testid="integrated-report"/);
  assert.match(source, /data-testid="agent-report"/);
  assert.match(source, /report\.sections\.map/);
  assert.match(source, /report\.findings\.map/);
  assert.match(source, /report\.recommendations\.map/);
  assert.match(source, /data-evidence-id/);
});

test("result page owns the Agent processing path and reports but no evaluation metrics", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const pathStart = source.indexOf("function AgentProcessingPath");
  const panelStart = source.indexOf("function FocusedResultPanel", pathStart);
  const panelEnd = source.indexOf("export default function Home", panelStart);
  assert.ok(pathStart >= 0 && panelStart > pathStart && panelEnd > panelStart);

  const processingPath = source.slice(pathStart, panelStart);
  const panel = source.slice(panelStart, panelEnd);
  assert.match(processingPath, /data-testid="agent-processing-path"/);
  assert.match(processingPath, /<RouterDecisionCard/);
  assert.match(processingPath, /executionRole === "required-reviewer"/);
  assert.match(processingPath, /agent\.evidence\.length/);
  assert.match(processingPath, /integrationLabel/);

  assert.match(panel, /<AgentProcessingPath/);
  assert.match(panel, /<IntegratedReportDocument/);
  assert.match(panel, /<AgentReportDocument/);
  assert.match(panel, /data-testid="result-agent-evidence"/);
  assert.match(panel, /source\.excerpt/);
  assert.match(panel, /\/evaluation\?run=/);

  for (const forbidden of [
    /privacyRiskPanel/,
    /result\.metrics/,
    /metricProvenance/,
    /<ProvenanceBadge/,
    /compactDiagnostics/,
    /diagnosticChecks/,
    /compactTimeline/,
    /result\.checks/,
    /result\.timeline/,
    /privacyRiskScore/,
    /latencyBreakdown/,
    /boundaryBytes/,
    /traceability/,
    /tokens/,
  ]) {
    assert.doesNotMatch(panel, forbidden);
  }
});

test("masks direct identifiers before retrieval and output", async () => {
  const query = "주민등록번호 900101-1234567과 010-1234-5678 민원 기록을 분석해 주세요.";
  const result = await orchestrate(query);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /900101-1234567|010-1234-5678/);
  assert.equal(result.metrics.privacyRiskVersion, "v2");
  assert.equal(result.metrics.privacyRisk.sensitiveDetectedCount, 2);
  assert.equal(result.metrics.privacyRisk.sensitiveTransmittedCount, 0);
  assert.equal(result.metrics.privacyRisk.sensitiveTransmissionRatio, 0);
  assert.equal(result.metrics.privacyRisk.originalDisclosureRatio, 0);
  assert.equal(result.metrics.privacyRisk.outputLeak, false);
  assert.equal(result.metrics.privacyRisk.privacyPass, true);
  assert.equal(result.metrics.privacyRiskScore, Math.round(
    100 * 0.3 * result.metrics.privacyRisk.agentSelectionRatio,
  ));
  assert.equal(result.metrics.provenance.version, "v2");
  assert.equal(result.metrics.provenance.fields.tokens.kind, "unavailable");
  assert.equal(result.metrics.tokens, null);
  assert.equal(result.metrics.provenance.fields.latencyMs.kind, "measured");
  assert.equal(result.boundary.egressLedger.totalPayloadBytes, result.metrics.boundaryBytes);
  assert.equal(
    result.boundary.egressLedger.envelopes.reduce((sum, envelope) => sum + envelope.payloadBytes, 0),
    result.metrics.boundaryBytes,
  );
  assert.equal(result.metrics.exposedFields, Math.ceil(result.metrics.privacyRisk.sensitiveTransmittedCount));
  assert.equal(result.metrics.rawDataLeavesEdge, result.metrics.privacyRisk.rawDataLeavesEdge);
  for (const agent of result.agents.filter((item) => item.selected && item.evidencePlan)) {
    assert.ok(agent.evidencePlan.decisions.every((decision) => decision.plannedMode === decision.appliedMode));
    assert.ok(agent.evidencePlan.decisions.every((decision) => decision.egressBytes > 0));
    assert.equal(agent.audit.policyDecisionId, agent.policy.decisionId);
  }
  const filteredFields = new Set(result.agents.flatMap((agent) => agent.filteredFields));
  assert.ok(filteredFields.has("주민등록번호"));
  assert.ok(filteredFields.has("휴대전화"));
});

test("enforces confidential evidence policy and the raw-free Core boundary", async () => {
  const result = await orchestrate(
    "권한경계 기밀 대응 절차를 보안과 운영 관점에서 검토해 주세요.",
  );
  const security = result.agents.find((agent) => agent.id === "security");
  const operations = result.agents.find((agent) => agent.id === "operations");
  assert.ok(security?.selected, "security Agent was not selected");
  assert.ok(operations?.selected, "operations Agent was not selected");

  const confidentialEvidence = security.evidence.find((item) =>
    item.id.includes("SEC-BOUNDARY-DEMO") && item.classification === "confidential"
  );
  assert.ok(confidentialEvidence, "security Agent did not receive the confidential fixture");
  assert.ok(security.policy.allowedClasses.includes("confidential"));
  assert.ok(security.policy.returnedClasses.includes("confidential"));
  assert.equal(security.policy.rawContentReturned, false);

  assert.ok(!operations.policy.allowedClasses.includes("confidential"));
  assert.ok(!operations.policy.returnedClasses.includes("confidential"));
  assert.ok(operations.policy.blockedCount >= 1);
  assert.ok(!operations.evidence.some((item) => item.id.includes("SEC-BOUNDARY-DEMO")));
  for (const agent of result.agents.filter((item) => item.id !== "security")) {
    assert.ok(
      !agent.evidence.some((item) => item.classification === "confidential"),
      `${agent.id} received confidential evidence`,
    );
  }

  assert.deepEqual(result.boundary.corePayloadFields, ["summary", "evidenceRefs", "metrics", "policy", "audit"]);
  assert.equal(result.boundary.transport, "local");
  assert.equal(result.boundary.rawContentReturned, false);
  assert.equal(result.boundary.policyVersion, "edge-rag-v1");
  assert.ok(result.boundary.blockedDocuments >= 1);

  const forbiddenEvidenceFields = ["text", "rawText", "content", "chunk", "document"];
  for (const agent of result.agents) {
    assert.ok(agent.policy.decisionId);
    assert.equal(agent.policy.rawContentReturned, false);
    for (const item of agent.evidence) {
      assert.ok(agent.policy.allowedClasses.includes(item.classification));
      if (item.classification === "public") {
        assert.equal(item.disclosure, "sanitized-preview");
        assert.ok(item.title.length > 0);
        assert.ok(item.excerpt.length > 0);
      } else {
        assert.equal(item.disclosure, "reference-only");
        assert.equal(Object.hasOwn(item, "sourceUrl"), false);
      }
      for (const field of forbiddenEvidenceFields) {
        assert.equal(Object.hasOwn(item, field), false, `${item.id} exposed ${field}`);
      }
    }
  }

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /BLUE-731|010-9123-4567/);
});

test("applies PII and classification policy before the commercial judge boundary", async () => {
  let capturedJudgeRequest = "";
  const server = createServer((request, response) => {
    assert.equal(request.url, "/chat/completions");
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      capturedJudgeRequest += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              correctness: 90,
              groundedness: 90,
              completeness: 90,
              overall: 90,
              rationale: "정책 적용 후 전달된 최소 근거를 평가했습니다.",
            }),
          },
        }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.COMMERCIAL_JUDGE_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.COMMERCIAL_JUDGE_API_KEY = "mnc6-test-key";
  process.env.COMMERCIAL_JUDGE_MODEL = "mnc6-judge-test";
  try {
    const result = await orchestrate(
      "권한경계 기밀 대응 절차를 보안과 운영 관점에서 검토해 주세요.",
      "proposed",
      true,
    );
    assert.equal(result.commercialJudge.enabled, true);
    assert.ok(capturedJudgeRequest, "commercial judge request was not captured");
    assert.doesNotMatch(capturedJudgeRequest, /BLUE-731|010-9123-4567/);
    assert.doesNotMatch(JSON.stringify(result), /BLUE-731|010-9123-4567/);
  } finally {
    delete process.env.COMMERCIAL_JUDGE_BASE_URL;
    delete process.env.COMMERCIAL_JUDGE_API_KEY;
    delete process.env.COMMERCIAL_JUDGE_MODEL;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("binds the remote Edge endpoint to one Agent and returns fixed safe errors", async () => {
  process.env.EDGE_AGENT_ID = "security";
  process.env.EDGE_AGENT_SECURITY_TOKEN = "security-edge-test-token";
  const runtime = await worker();
  const requestBody = {
    version: "1",
    requestId: "EDGE-ROUTE-TEST",
    traceId: "EDGE-ROUTE-TRACE",
    agentId: "security",
    purpose: "orchestration",
    minimalQuery: "권한경계 기밀 대응 절차",
    limits: { topK: 3, deadlineMs: 5_000 },
  };
  const headers = {
    "content-type": "application/json",
    "x-forwarded-proto": "https",
    "x-edge-agent-id": "security",
    authorization: "Bearer security-edge-test-token",
  };
  try {
    const mismatched = await runtime.fetch(
      new Request("https://edge.example/api/edge/agent", {
        method: "POST",
        headers: { ...headers, "x-edge-agent-id": "operations" },
        body: JSON.stringify({ ...requestBody, agentId: "operations" }),
      }),
      environment,
      context,
    );
    assert.equal(mismatched.status, 403);
    assert.deepEqual(await mismatched.json(), { error: "EDGE_AGENT_ID_MISMATCH" });

    const malformed = await runtime.fetch(
      new Request("https://edge.example/api/edge/agent", {
        method: "POST",
        headers,
        body: '{"BLUE-731":',
      }),
      environment,
      context,
    );
    assert.equal(malformed.status, 400);
    const malformedText = await malformed.text();
    assert.equal(malformedText.includes("EDGE_REQUEST_INVALID"), true);
    assert.doesNotMatch(malformedText, /BLUE-731/);

    const accepted = await runtime.fetch(
      new Request("https://edge.example/api/edge/agent", {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
      }),
      environment,
      context,
    );
    assert.equal(accepted.status, 200);
    const body = await accepted.json();
    assert.equal(body.agentId, "security");
    assert.equal(body.boundary.transport, "http");
    assert.equal(body.boundary.rawCorpusTransferred, false);
    assert.ok(body.summary);
    assert.ok(Array.isArray(body.evidenceRefs));
    assert.equal(Object.hasOwn(body, "answer"), false);
    assert.equal(Object.hasOwn(body, "evidence"), false);
    for (const item of body.evidenceRefs) {
      if (item.classification === "public") {
        assert.equal(item.disclosure, "sanitized-preview");
        assert.ok(item.title);
        assert.ok(item.excerpt);
      } else {
        assert.equal(item.disclosure, "reference-only");
        assert.ok(!["title", "section", "excerpt", "sourceUrl"].some((key) => Object.hasOwn(item, key)));
      }
    }
    assert.doesNotMatch(JSON.stringify(body), /BLUE-731|010-9123-4567/);
  } finally {
    delete process.env.EDGE_AGENT_ID;
    delete process.env.EDGE_AGENT_SECURITY_TOKEN;
  }
});

test("golden-set queries return the expected specialist agents", async () => {
  const lines = (await readFile(new URL("../data/evaluation/golden-set.jsonl", import.meta.url), "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);
  for (const item of lines) {
    const result = await orchestrate(item.query);
    const selected = new Set(result.agents.filter((agent) => agent.selected).map((agent) => agent.id));
    for (const expected of item.expected_agents) {
      assert.ok(selected.has(expected), `${item.id}: missing ${expected}`);
    }
  }
});

test("selects only relevant agents in proposed mode", async () => {
  const result = await orchestrate("3년 예산과 총소유비용을 산정해 주세요.");
  const selected = result.agents.filter((agent) => agent.selected).map((agent) => agent.id);
  assert.deepEqual(selected, ["finance"]);
  assert.equal(result.agents.length, 8);
  assert.ok(result.agents.find((agent) => agent.id === "security")?.selectionReason.includes("발견되지 않았"));
});

test("streams real orchestration stages and a final result", async () => {
  const packets = await orchestrateStream("개인정보 보안과 법적 책임을 검토해 주세요");
  const events = packets.filter((packet) => packet.type === "progress").map((packet) => packet.event);
  const stages = events.map((event) => event.stage);
  assert.equal(stages[0], "request.received");
  assert.ok(stages.includes("agents.selected"));
  assert.ok(events.some((event) => event.stage === "agent.retrieving" && event.agentId === "security"));
  assert.ok(events.some((event) =>
    event.agentId === "legal" && ["agent.generating", "agent.skipped"].includes(event.stage)
  ));
  assert.ok(stages.includes("central.integrating"));
  assert.equal(stages.at(-1), "request.completed");
  for (const agentId of new Set(events.filter((event) => event.stage === "agent.completed").map((event) => event.agentId))) {
    const agentStages = events.filter((event) => event.agentId === agentId).map((event) => event.stage);
    assert.ok(agentStages.indexOf("agent.retrieving") < agentStages.indexOf("agent.retrieved"));
    assert.ok(agentStages.indexOf("agent.retrieved") < agentStages.indexOf("agent.generating"));
    assert.ok(agentStages.indexOf("agent.generating") < agentStages.indexOf("agent.completed"));
  }
  assert.ok(stages.indexOf("central.completed") < stages.indexOf("request.completed"));
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  const firstAgentEvent = events.find((event) => event.stage === "agent.retrieving");
  assert.ok(firstAgentEvent?.execution, "execution graph was not registered before the first Agent task");
  assert.ok(firstAgentEvent.execution.totalCount >= 2);
  assert.equal(firstAgentEvent.execution.executionStatus, "running");
  const finalPacket = packets.at(-1);
  assert.equal(finalPacket.type, "result");
  assert.equal(finalPacket.result.runId, events[0].runId);
  assert.equal(finalPacket.result.requestId, events[0].runId);
  assert.ok(["completed", "partial_failed"].includes(finalPacket.result.executionStatus));
  assert.equal(finalPacket.result.execution.remainingCount, 0);
  assert.equal(finalPacket.result.execution.terminalCount, finalPacket.result.execution.totalCount);
  assert.doesNotMatch(JSON.stringify(finalPacket.result.execution), /query|evidence|summary|900101|010-1234/i);
});

test("uses an Ollama-compatible local model and records TTFT/TPOT", async () => {
  let latestOllamaResponseCompleted = false;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/chat");
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      latestOllamaResponseCompleted = false;
      const payload = JSON.parse(body);
      const systemPrompt = payload.messages?.[0]?.content ?? "";
      const userPrompt = payload.messages?.[1]?.content ?? "";
      const evidenceId = userPrompt.match(/\[([^\]]+)\]/)?.[1] ?? "UNKNOWN";
      const invalidOnly = userPrompt.includes("인용 보정 검증");
      const generatedText = systemPrompt.includes("Managed Platform Supervisor")
        ? `판단: Managed Supervisor 실제 통합 응답입니다. 근거: [${evidenceId}]`
        : invalidOnly
          ? "판단: 인용 보정 검증 응답입니다. 근거: [FAKE-ID]"
          : `판단: Ollama 실제 생성 응답입니다. 근거: [${evidenceId}] [FAKE-ID]`;
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      setTimeout(() => {
        response.write(`${JSON.stringify({ message: { content: generatedText.slice(0, 12) }, done: false })}\n`);
        setTimeout(() => {
          response.end(`${JSON.stringify({
            message: { content: generatedText.slice(12) },
            done: true,
            prompt_eval_count: 42,
            eval_count: 12,
            eval_duration: 600_000_000,
          })}\n`, () => {
            latestOllamaResponseCompleted = true;
          });
        }, 15);
      }, 10);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.LOCAL_LLM_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.LOCAL_LLM_MODEL = "qwen3:4b-test";
  try {
    const result = await orchestrate("3년 예산과 총소유비용을 산정해 주세요.");
    assert.equal(result.metrics.llmBackend, "ollama");
    assert.equal(result.metrics.model, "qwen3:4b-test");
    assert.ok(result.metrics.ttftMs >= 0);
    assert.ok(result.metrics.tpotMs > 0);
    const financeSummary = result.agents.find((agent) => agent.id === "finance").summary;
    assert.match(financeSummary, /^판단:/);
    assert.match(financeSummary, /Ollama 실제 생성 응답/);
    assert.doesNotMatch(financeSummary, /FAKE-ID/);
    assert.match(financeSummary, /\[.+\]/);
    const correctedCitation = await orchestrate("인용 보정 검증 예산 요청");
    const correctedFinance = correctedCitation.agents.find((agent) => agent.id === "finance");
    assert.doesNotMatch(correctedFinance.summary, /FAKE-ID/);
    assert.ok(correctedFinance.evidence.some((evidence) => correctedFinance.summary.includes(`[${evidence.id}]`)));
    const streamRuntime = await worker();
    latestOllamaResponseCompleted = false;
    const streamResponse = await streamRuntime.fetch(
      new Request("http://localhost/api/orchestrate/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "3년 운영 예산 검토", mode: "proposed" }),
      }),
      environment,
      context,
    );
    const streamReader = streamResponse.body.getReader();
    const firstChunk = await streamReader.read();
    assert.equal(firstChunk.done, false);
    assert.equal(latestOllamaResponseCompleted, false, "first progress event arrived after Ollama finished");
    const streamDecoder = new TextDecoder();
    let streamed = streamDecoder.decode(firstChunk.value, { stream: true });
    while (true) {
      const chunk = await streamReader.read();
      if (chunk.done) break;
      streamed += streamDecoder.decode(chunk.value, { stream: true });
    }
    streamed += streamDecoder.decode();
    const streamedPackets = streamed.split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.equal(streamedPackets[0].event.stage, "request.received");
    assert.equal(streamedPackets.at(-1).type, "result");
    const centralized = await orchestrate("예산과 보안 검토", "centralized");
    assert.equal(centralized.metrics.calls, 1);
    assert.equal(centralized.metrics.llmBackend, "ollama");
    assert.ok(centralized.metrics.ttftMs >= 0);
    assert.ok(centralized.metrics.tpotMs > 0);
    assert.equal(centralized.metrics.rawDataLeavesEdge, false);
    assert.match(centralized.conclusion, /Ollama 실제 생성 응답/);
    assert.ok(centralized.agents.every((agent) => agent.inference.role === "evidence-projection"));
    assert.ok(centralized.agents.every((agent) => agent.inference.backend === "deterministic"));
    assert.equal(result.metrics.rawDataLeavesEdge, false);
    assert.ok(result.metrics.boundaryBytes < centralized.metrics.boundaryBytes);
    assert.ok(result.metrics.privacyRiskScore < centralized.metrics.privacyRiskScore);
    assert.ok(result.metrics.qualityScore >= 0 && result.metrics.qualityScore <= 100);
    assert.ok(result.metrics.groundedness >= 0 && result.metrics.groundedness <= 100);
    const managed = await orchestrate("예산 검토", "managed");
    assert.equal(managed.metrics.calls, 2);
    assert.equal(managed.metrics.rawDataLeavesEdge, false);
    assert.equal(result.metrics.privacyRiskVersion, "v2");
    assert.equal(managed.metrics.privacyRiskVersion, "v2");
    assert.equal(managed.metrics.privacyRiskScore, result.metrics.privacyRiskScore);
    assert.match(managed.conclusion, /Managed Supervisor 실제 통합 응답/);
    assert.equal(managed.integration.actor, "managed-supervisor");
    assert.equal(managed.integration.backend, "ollama");
    const masrouter = await orchestrate("개인정보 보안 법무 예산 검토", "masrouter");
    assert.equal(masrouter.mode, "masrouter");
    assert.equal(masrouter.metrics.rawDataLeavesEdge, false);
    assert.ok(masrouter.agents.filter((agent) => agent.selected).length >= 2);
    const remoterag = await orchestrate("agency internal privacy security legal budget review", "remoterag");
    assert.equal(remoterag.mode, "remoterag");
    assert.equal(remoterag.metrics.queryProtection, "deterministic-generalization");
    assert.ok(remoterag.metrics.perturbedTerms > 0);
  } finally {
    delete process.env.LOCAL_LLM_BASE_URL;
    delete process.env.LOCAL_LLM_MODEL;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("records an empty Ollama response as a deterministic fallback", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/chat");
    sendOllamaNdjson(response, "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.LOCAL_LLM_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.LOCAL_LLM_MODEL = "mnc5-empty-test";
  try {
    const result = await orchestrate("budget operating plan evidence", "centralized");
    assert.equal(result.integration.backend, "deterministic");
    assert.equal(result.integration.answerSource, "deterministic-fallback");
    assert.equal(result.integration.fallbackReason, "Ollama returned an empty response");
    assert.equal(result.metrics.llmBackend, "deterministic");
    assert.ok(result.conclusion.trim().length > 0);
  } finally {
    delete process.env.LOCAL_LLM_BASE_URL;
    delete process.env.LOCAL_LLM_MODEL;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("releases the Ollama inference slot after HTTP and timeout fallbacks", { timeout: 15_000 }, async () => {
  let requestCount = 0;
  let markTimeoutStarted;
  const timeoutStarted = new Promise((resolve) => {
    markTimeoutStarted = resolve;
  });
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/chat");
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requestCount += 1;
      if (requestCount === 1) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end('{"error":"temporary"}');
        return;
      }
      if (requestCount === 2) {
        markTimeoutStarted();
        return;
      }
      const payload = JSON.parse(body);
      sendOllamaNdjson(response, `QUEUE_RECOVERED [${ollamaEvidenceId(payload)}]`);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.LOCAL_LLM_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.LOCAL_LLM_MODEL = "mnc5-slot-test";
  process.env.LOCAL_LLM_TIMEOUT_MS = "80";
  try {
    const httpFailure = await orchestrateWithRuntime(
      await worker(),
      "budget HTTP fallback evidence",
      "centralized",
    );
    assert.equal(httpFailure.integration.answerSource, "deterministic-fallback");
    assert.equal(httpFailure.integration.fallbackReason, "Ollama HTTP 503");

    const runtime = await worker();
    const timeoutRun = orchestrateWithRuntime(runtime, "budget timeout evidence", "centralized");
    await timeoutStarted;
    const recoveryRun = orchestrateWithRuntime(runtime, "budget recovery evidence", "centralized");
    const [timedOut, recovered] = await Promise.all([timeoutRun, recoveryRun]);

    assert.equal(timedOut.integration.answerSource, "deterministic-fallback");
    assert.match(timedOut.integration.fallbackReason, /abort|timeout/i);
    assert.equal(recovered.integration.answerSource, "local-llm");
    assert.equal(recovered.integration.fallbackReason, undefined);
    assert.match(recovered.conclusion, /QUEUE_RECOVERED/);
    assert.equal(requestCount, 3);
    const recoveredIntegrationTask = recovered.execution.tasks.find(
      (task) => task.kind === "central-integration",
    );
    assert.ok(recoveredIntegrationTask?.scheduler, "central integration was not scheduled");
    assert.equal(recoveredIntegrationTask.scheduler.outcome, "succeeded");
    assert.ok(recoveredIntegrationTask.scheduler.queueWaitMs >= 0);
    assert.ok(recoveredIntegrationTask.scheduler.inferenceMs >= 0);
    assert.equal(
      recoveredIntegrationTask.scheduler.endToEndMs,
      recoveredIntegrationTask.scheduler.queueWaitMs + recoveredIntegrationTask.scheduler.inferenceMs,
    );
  } finally {
    delete process.env.LOCAL_LLM_BASE_URL;
    delete process.env.LOCAL_LLM_MODEL;
    delete process.env.LOCAL_LLM_TIMEOUT_MS;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("serializes Agent calls that share one physical endpoint", { timeout: 20_000 }, async () => {
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let requestCount = 0;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/chat");
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requestCount += 1;
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      const payload = JSON.parse(body);
      setTimeout(() => {
        sendOllamaNdjson(response, `SERIALIZED [${ollamaEvidenceId(payload)}]`);
        activeRequests -= 1;
      }, 15);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.LOCAL_LLM_BASE_URL = baseUrl;
  process.env.LOCAL_LLM_MODEL = "mnc8-shared-endpoint-test";
  process.env.EDGE_AGENT_MODE = "local";
  try {
    const runtime = await worker();
    const [first, second] = await Promise.all([
      orchestrateWithRuntime(runtime, "shared endpoint first request", "parallel"),
      orchestrateWithRuntime(runtime, "shared endpoint second request", "parallel"),
    ]);

    const expectedHttpCalls = [first, second].reduce(
      (count, result) => count + result.agents.filter(
        (agent) => agent.selected && agent.inference.backend === "ollama",
      ).length,
      0,
    );
    assert.equal(requestCount, expectedHttpCalls);
    assert.equal(maxActiveRequests, 1);
    for (const result of [first, second]) {
      const agentTasks = result.execution.tasks.filter((task) => task.kind === "agent");
      assert.equal(agentTasks.length, 8);
      assert.equal(result.execution.scheduling.scheduledTaskCount, 8);
      assert.ok(agentTasks.every((task) => task.scheduler));
      assert.ok(agentTasks.every((task) => task.scheduler.resourceKey === `ollama:${baseUrl}`));
      assert.ok(agentTasks.every((task) => task.scheduler.outcome === "succeeded"));
      assert.ok(agentTasks.every((task) =>
        task.scheduler.endToEndMs === task.scheduler.queueWaitMs + task.scheduler.inferenceMs
      ));
    }
  } finally {
    delete process.env.LOCAL_LLM_BASE_URL;
    delete process.env.LOCAL_LLM_MODEL;
    delete process.env.EDGE_AGENT_MODE;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("terminates the full request graph after an Agent dispatch failure", { timeout: 15_000 }, async () => {
  let requestCount = 0;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/edge/agent");
    requestCount += 1;
    response.writeHead(503, { "content-type": "application/json" });
    response.end('{"error":"temporary"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  process.env.EDGE_AGENT_MODE = "remote";
  process.env.EDGE_AGENT_BASE_URL = baseUrl;
  process.env.EDGE_AGENT_TOKEN = "scheduler-test-token";
  process.env.EDGE_AGENT_FINANCE_TOKEN = "scheduler-test-token";
  try {
    const result = await orchestrate(
      "3년 예산과 총소유비용을 산정해 주세요.",
      "proposed",
    );
    assert.ok(requestCount <= 1);
    assert.equal(result.execution.executionStatus, "partial_failed");
    assert.equal(result.execution.remainingCount, 0);
    assert.ok(result.execution.tasks.every((task) =>
      ["succeeded", "failed", "cancelled", "skipped"].includes(task.status)
    ));
    const failedAgent = result.execution.tasks.find((task) => task.kind === "agent" && task.required);
    assert.equal(failedAgent?.status, "failed");
    assert.equal(failedAgent?.scheduler?.outcome, "failed");
    assert.equal(failedAgent?.scheduler?.resourceKey, `edge:${baseUrl}/api/edge/agent`);
    assert.equal(result.execution.scheduling.scheduledTaskCount, 2);
  } finally {
    delete process.env.EDGE_AGENT_MODE;
    delete process.env.EDGE_AGENT_BASE_URL;
    delete process.env.EDGE_AGENT_TOKEN;
    delete process.env.EDGE_AGENT_FINANCE_TOKEN;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("rechecks Coordinator state and prioritizes a request's final task", { timeout: 20_000 }, async () => {
  let requestCount = 0;
  let releaseBlockedRequest = null;
  let markBlockerActive;
  const blockerActive = new Promise((resolve) => {
    markBlockerActive = resolve;
  });
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/chat");
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requestCount += 1;
      const payload = JSON.parse(body);
      const answer = `COORDINATED [${ollamaEvidenceId(payload)}]`;
      if (requestCount === 1) {
        releaseBlockedRequest = () => sendOllamaNdjson(response, answer);
        markBlockerActive();
        return;
      }
      setTimeout(() => sendOllamaNdjson(response, answer), 15);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.LOCAL_LLM_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.LOCAL_LLM_MODEL = "mnc9-last-task-test";
  process.env.EDGE_AGENT_MODE = "local";
  try {
    const runtime = await worker();
    const blocker = orchestrateWithRuntime(
      runtime,
      "budget blocker evidence",
      "centralized",
    );
    await blockerActive;

    const shortRequest = orchestrateWithRuntime(
      runtime,
      "3년 예산과 총소유비용을 산정해 주세요.",
      "managed",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const busyRequest = orchestrateWithRuntime(
      runtime,
      "keep every specialist busy on the shared endpoint",
      "parallel",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(releaseBlockedRequest, "the blocking endpoint request did not start");
    releaseBlockedRequest();
    releaseBlockedRequest = null;

    const [, prioritized, busy] = await Promise.all([blocker, shortRequest, busyRequest]);
    const integrationTask = prioritized.execution.tasks.find(
      (task) => task.kind === "managed-supervisor",
    );
    assert.ok(integrationTask?.scheduler, "final integration task was not scheduled");
    assert.equal(integrationTask.scheduler.dispatchReason, "last-task");
    assert.ok(integrationTask.scheduler.queueDepthAtDispatch > 1);
    assert.equal(prioritized.execution.executionStatus, "completed");
    assert.equal(busy.execution.executionStatus, "completed");
  } finally {
    releaseBlockedRequest?.();
    delete process.env.LOCAL_LLM_BASE_URL;
    delete process.env.LOCAL_LLM_MODEL;
    delete process.env.EDGE_AGENT_MODE;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("masks model-generated PII and judges the exact final conclusion", async () => {
  let capturedJudgePayload;
  const exposedValues = [
    "900101-1234567",
    "010-9876-5432",
    "private@example.com",
    "192.168.10.20",
  ];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body);
      if (request.url === "/api/chat") {
        const evidenceId = ollamaEvidenceId(payload);
        sendOllamaNdjson(
          response,
          `MODEL_PII ${exposedValues.join(" ")} [${evidenceId}]`,
        );
        return;
      }
      assert.equal(request.url, "/chat/completions");
      capturedJudgePayload = payload;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              correctness: 90,
              groundedness: 90,
              completeness: 90,
              overall: 90,
              rationale: "final answer matched",
            }),
          },
        }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.LOCAL_LLM_BASE_URL = baseUrl;
  process.env.LOCAL_LLM_MODEL = "mnc5-pii-test";
  process.env.COMMERCIAL_JUDGE_BASE_URL = baseUrl;
  process.env.COMMERCIAL_JUDGE_API_KEY = "mnc5-judge-key";
  process.env.COMMERCIAL_JUDGE_MODEL = "mnc5-judge-test";
  try {
    const result = await orchestrate("budget evidence final answer review", "centralized", true);
    assert.equal(result.integration.answerSource, "local-llm");
    assert.equal(result.commercialJudge.enabled, true);
    assert.ok(capturedJudgePayload, "commercial judge request was not captured");

    const serializedResult = JSON.stringify(result);
    const serializedJudgePayload = JSON.stringify(capturedJudgePayload);
    for (const value of exposedValues) {
      assert.equal(serializedResult.includes(value), false, `${value} leaked through the final API`);
      assert.equal(serializedJudgePayload.includes(value), false, `${value} leaked to the judge`);
    }

    const judgeContent = capturedJudgePayload.messages?.[1]?.content ?? "";
    const answerMatch = judgeContent.match(/\n\n답변:\n([\s\S]*?)\n\n검색 근거:\n/);
    assert.ok(answerMatch, "commercial judge answer section was not found");
    assert.equal(answerMatch[1], result.conclusion);
    assert.match(result.conclusion, /MODEL_PII/);
  } finally {
    delete process.env.LOCAL_LLM_BASE_URL;
    delete process.env.LOCAL_LLM_MODEL;
    delete process.env.COMMERCIAL_JUDGE_BASE_URL;
    delete process.env.COMMERCIAL_JUDGE_API_KEY;
    delete process.env.COMMERCIAL_JUDGE_MODEL;
    await new Promise((resolve) => server.close(resolve));
  }
});
