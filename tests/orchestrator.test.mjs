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

async function orchestrate(query, mode = "proposed") {
  const runtime = await worker();
  const response = await runtime.fetch(
    new Request("http://localhost/api/orchestrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, mode }),
    }),
    environment,
    context,
  );
  assert.equal(response.status, 200);
  return response.json();
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
  assert.match(html, /분산된 전문성은 연결하고/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview/);
});

test("retrieves public evidence for every agent", async () => {
  const result = await orchestrate(
    "공공기관 생성형 AI 도입의 기술, 개인정보 보안, 계약 책임, 조달 예산을 검토해 주세요.",
    "parallel",
  );
  assert.equal(result.metrics.ragChunks, 1499);
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

test("uses an Ollama-compatible local model and records TTFT/TPOT", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/chat");
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    setTimeout(() => {
      response.write(`${JSON.stringify({ message: { content: "로컬 " }, done: false })}\n`);
      setTimeout(() => {
        response.end(`${JSON.stringify({
          message: { content: "응답입니다." },
          done: true,
          prompt_eval_count: 42,
          eval_count: 12,
          eval_duration: 600_000_000,
        })}\n`);
      }, 15);
    }, 10);
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
    assert.match(result.agents.find((agent) => agent.id === "finance").summary, /로컬 응답입니다/);
    const centralized = await orchestrate("예산과 보안 검토", "centralized");
    assert.equal(centralized.metrics.calls, 1);
    assert.equal(centralized.metrics.llmBackend, "ollama");
    assert.ok(centralized.metrics.ttftMs >= 0);
    assert.ok(centralized.metrics.tpotMs > 0);
    assert.equal(centralized.metrics.rawDataLeavesEdge, true);
    assert.equal(result.metrics.rawDataLeavesEdge, false);
    assert.ok(result.metrics.minimizationRate > centralized.metrics.minimizationRate);
    assert.ok(result.metrics.privacyRiskScore < centralized.metrics.privacyRiskScore);
    assert.ok(result.metrics.qualityScore >= 0 && result.metrics.qualityScore <= 100);
    assert.ok(result.metrics.groundedness >= 0 && result.metrics.groundedness <= 100);
    const managed = await orchestrate("예산 검토", "managed");
    assert.equal(managed.metrics.calls, 2);
    assert.equal(managed.metrics.rawDataLeavesEdge, true);
    assert.ok(managed.metrics.privacyRiskScore > result.metrics.privacyRiskScore);
  } finally {
    delete process.env.LOCAL_LLM_BASE_URL;
    delete process.env.LOCAL_LLM_MODEL;
    await new Promise((resolve) => server.close(resolve));
  }
});
