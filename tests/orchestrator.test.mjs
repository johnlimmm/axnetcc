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

async function orchestrate(query, mode = "proposed", commercialJudge = false) {
  const runtime = await worker();
  const response = await runtime.fetch(
    new Request("http://localhost/api/orchestrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, mode, commercialJudge }),
    }),
    environment,
    context,
  );
  assert.equal(response.status, 200);
  return response.json();
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
  assert.match(html, /적합한 주관기관부터 찾습니다/);
  assert.match(html, /요청 처리 시작/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview/);
});

test("retrieves public evidence for every agent", async () => {
  const result = await orchestrate(
    "공공기관 생성형 AI 도입의 기술, 개인정보 보안, 계약 책임, 조달 예산을 검토해 주세요.",
    "parallel",
  );
  assert.equal(result.metrics.ragChunks, 3027);
  for (const agent of result.agents) {
    assert.ok(agent.evidence.length >= 1, `${agent.id} has no evidence`);
    assert.ok(agent.evidence.some((item) => item.sourceUrl?.startsWith("https://")));
    assert.ok(agent.evidence.every((item) => item.retrievalScore > 0));
  }
});

test("masks direct identifiers before retrieval and output", async () => {
  const query = "주민등록번호 900101-1234567과 010-1234-5678 민원 기록을 분석해 주세요.";
  const result = await orchestrate(query);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /900101-1234567|010-1234-5678/);
  assert.match(serialized, /주민등록번호 제거|휴대전화 제거/);
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

  assert.deepEqual(result.boundary.corePayloadFields, ["summary", "evidenceIds", "metrics"]);
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
      assert.ok(["sanitized-preview", "reference-only"].includes(item.disclosure));
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
  assert.ok(events.some((event) => event.stage === "agent.generating" && event.agentId === "legal"));
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
  const finalPacket = packets.at(-1);
  assert.equal(finalPacket.type, "result");
  assert.equal(finalPacket.result.runId, events[0].runId);
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
      const evidenceId = payload.messages?.[1]?.content?.match(/\[([^\]]+)\]/)?.[1] ?? "UNKNOWN";
      const generatedText = systemPrompt.includes("Managed Platform Supervisor")
        ? `판단: Managed Supervisor 실제 통합 응답입니다. 근거: [${evidenceId}]`
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
    assert.ok(managed.metrics.privacyRiskScore > result.metrics.privacyRiskScore);
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
