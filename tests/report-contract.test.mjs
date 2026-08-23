import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentEvidenceReport,
  buildIntegratedEvidenceReport,
} from "../lib/report-contract.ts";
import { generateLocalAnswer } from "../lib/local-llm.ts";
import { createServer } from "node:http";

test("Agent reports cite only their own RAG evidence and cover every returned reference", () => {
  const evidenceIds = ["TECH-1", "TECH-2", "TECH-3"];
  const report = buildAgentEvidenceReport({
    agentId: "tech",
    agentName: "기술검토 Agent",
    responsibility: "기술 타당성 검토",
    executionRole: "primary",
    summary: "핵심 구성을 단계적으로 검증해야 합니다. [TECH-1] 잘못된 인용입니다. [FAKE-ID]",
    evidenceIds,
    evidenceTitles: evidenceIds.map((id) => ({ id, title: `${id} 공개 지침` })),
  });
  assert.equal(report.version, "1");
  assert.ok(report.findings.length >= 3);
  assert.deepEqual(new Set(report.citationIds), new Set(evidenceIds));
  for (const citation of [
    ...report.findings.flatMap((item) => item.citations),
    ...report.recommendations.flatMap((item) => item.citations),
  ]) {
    assert.ok(evidenceIds.includes(citation));
  }
  assert.doesNotMatch(JSON.stringify(report), /FAKE-ID/);
});

test("integrated reports retain primary/supporting provenance and reference union", () => {
  const fixtures = [
    ["tech", "primary", "TECH-1"],
    ["security", "required-reviewer", "SEC-1"],
    ["operations", "supporting", "OPS-1"],
  ].map(([id, role, evidenceId]) => ({
    id,
    evidenceIds: [evidenceId],
    report: buildAgentEvidenceReport({
      agentId: id,
      agentName: `${id} Agent`,
      responsibility: `${id} 검토`,
      executionRole: role,
      summary: `${id} 분야 검토 결과입니다. [${evidenceId}]`,
      evidenceIds: [evidenceId],
    }),
  }));
  const report = buildIntegratedEvidenceReport({
    title: "종합 검토보고서",
    conclusion: "주관·협력 검토를 종합합니다. [TECH-1] [FAKE-ID]",
    primaryAgentId: "tech",
    agents: fixtures,
  });
  assert.equal(report.primaryAgentId, "tech");
  assert.deepEqual(new Set(report.participatingAgentIds), new Set(["tech", "security", "operations"]));
  assert.deepEqual(new Set(report.references.map((item) => item.evidenceId)), new Set(["TECH-1", "SEC-1", "OPS-1"]));
  for (const fixture of fixtures) {
    assert.ok(report.sections.some((section) =>
      section.sourceAgentIds.length === 1 && section.sourceAgentIds[0] === fixture.id && section.citations.length > 0
    ));
  }
  assert.doesNotMatch(JSON.stringify(report), /FAKE-ID/);
});

test("evidence-free reports preserve a review limitation without fabricated citations", () => {
  const report = buildAgentEvidenceReport({
    agentId: "legal",
    agentName: "법무 Agent",
    responsibility: "법적 검토",
    executionRole: "required-reviewer",
    summary: "확인 가능한 근거가 없습니다. [FAKE-ID]",
    evidenceIds: [],
  });
  assert.deepEqual(report.citationIds, []);
  assert.ok(report.limitations.some((item) => item.includes("추가 확인")));
  assert.doesNotMatch(JSON.stringify(report), /FAKE-ID/);
});

test("report generation sends every supplied RAG item to Ollama", async () => {
  let capturedPayload;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      capturedPayload = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(`${JSON.stringify({
        message: { content: "핵심 판단: 세 근거를 모두 검토했습니다. [RAG-1] [RAG-2] [RAG-3]" },
        done: true,
        prompt_eval_count: 10,
        eval_count: 10,
        eval_duration: 100_000_000,
      })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  process.env.LOCAL_LLM_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.LOCAL_LLM_MODEL = "report-test";
  try {
    await generateLocalAnswer({
      agent: "tech",
      agentName: "기술 Agent",
      responsibility: "기술 검토",
      query: "세 근거를 검토해 주세요.",
      evidence: ["RAG-1", "RAG-2", "RAG-3"].map((id) => ({
        id,
        agent: "tech",
        title: `${id} 지침`,
        section: "본문",
        text: `${id} 검토 내용`,
        sourceType: "public",
        classification: "public",
        effectiveDate: "2026-01-01",
        tags: [],
      })),
      fallback: "fallback",
      outputFormat: "integrated-report",
    });
    const prompt = capturedPayload.messages[1].content;
    for (const id of ["RAG-1", "RAG-2", "RAG-3"]) assert.match(prompt, new RegExp(id));
    assert.equal(capturedPayload.options.num_predict, 192);
  } finally {
    delete process.env.LOCAL_LLM_BASE_URL;
    delete process.env.LOCAL_LLM_MODEL;
    await new Promise((resolve) => server.close(resolve));
  }
});
