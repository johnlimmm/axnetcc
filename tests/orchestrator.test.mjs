import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

