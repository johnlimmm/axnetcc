import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
}, load(url, context, nextLoad) {
  if (url.endsWith(".json")) return { format: "module", source: `export default ${readFileSync(new URL(url), "utf8")};`, shortCircuit: true };
  return nextLoad(url, context);
} });
const { executeEdgeAgentLocally } = await import("../lib/edge-agent-service.ts");
const { knowledge } = await import("../lib/knowledge.ts");
const { validateEdgeAgentResponse } = await import("../lib/edge-agent-contract.ts");
const { projectEdgeAgentResponseForCore, validateCoreEdgeAgentResponse } = await import("../lib/edge-core-contract.ts");

async function fixture(publicOnly, run) {
  const saved = { ...process.env }, oldFetch = globalThis.fetch, originalLength = knowledge.length;
  for (const key of Object.keys(process.env)) if (key.startsWith("DEMO_") || key.startsWith("EDGE_AGENT_SECURITY_")) delete process.env[key];
  process.env.LOCAL_LLM_BASE_URL = "http://127.0.0.1:11434";
  process.env.LOCAL_LLM_MODEL = "evaluation-test-model";
  if (publicOnly) process.env.EVALUATION_PUBLIC_EVIDENCE_ONLY = "true";
  else delete process.env.EVALUATION_PUBLIC_EVIDENCE_ONLY;
  try { await run(); }
  finally {
    knowledge.splice(originalLength);
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

const request = () => ({ version: "1", requestId: "EDGE-PUBLIC-EVAL-1", traceId: "RUN-PUBLIC-EVAL-1", agentId: "security", purpose: "orchestration", minimalQuery: "권한경계 기밀 대응 절차", limits: { topK: 10, deadlineMs: 10000 } });

test("default policy keeps confidential evidence restricted and never sends it to the LLM", () => fixture(false, async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Confidential prompt must not be submitted"); };
  const response = await executeEdgeAgentLocally(request());
  assert.equal(calls, 0);
  assert.equal(response.metrics.model, "edge-restricted-reference");
  assert.ok(response.evidence.some(item => item.referenceId === "SEC-BOUNDARY-DEMO" && item.disclosure === "reference-only"));
  assert.equal(response.metrics.promptTokens, null);
  assert.equal(response.metrics.tokensPerSecond, null);
}));

test("public-only evaluation filters private evidence before inference and preserves measured throughput across contracts", () => fixture(true, async () => {
  knowledge.push({ id: "PUBLIC-EVAL-SEC", agent: "security", title: "공개 평가 근거", section: "공개 접근통제", text: "PUBLIC-EVALUATION-FACT: 공개 근거에 따라 접근권한을 검토한다.", sourceType: "public", classification: "public", effectiveDate: "2026-10-08", tags: ["권한경계", "대응", "절차"] });
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body), prompt = JSON.stringify(body.messages);
    assert.match(prompt, /PUBLIC-EVALUATION-FACT/);
    for (const chunk of knowledge.filter(item => item.classification !== "public")) {
      assert.ok(!prompt.includes(chunk.text), `Restricted text submitted: ${chunk.id}`);
    }
    assert.doesNotMatch(prompt, /BLUE-731|010-9123-4567|SEC-BOUNDARY-DEMO|SEC-DATA-01/);
    return new Response(JSON.stringify({ done: true, message: { content: "공개 근거 검토 결과 [PUBLIC-EVAL-SEC]" }, prompt_eval_count: 31, eval_count: 10, eval_duration: 150000000 }));
  };
  const response = await executeEdgeAgentLocally(request());
  assert.equal(calls, 1);
  assert.equal(response.status, "completed");
  assert.deepEqual(response.policy.effectiveClasses, ["public"]);
  assert.ok(response.policy.blockedCount >= 2);
  assert.ok(response.evidence.every(item => item.classification === "public"));
  assert.equal(response.metrics.promptTokens, 31);
  assert.equal(response.metrics.completionTokens, 10);
  assert.equal(response.metrics.tpotMs, 15);
  assert.equal(response.metrics.tokensPerSecond, 66.67);
  const projected = projectEdgeAgentResponseForCore(response, "local");
  assert.equal(validateCoreEdgeAgentResponse(projected).metrics.tokensPerSecond, 66.67);
  const invalid = structuredClone(projected);
  invalid.metrics.tokensPerSecond = -1;
  assert.throws(() => validateCoreEdgeAgentResponse(invalid), /tokensPerSecond/);
  const invalidEdge = structuredClone(response);
  invalidEdge.metrics.tokensPerSecond = -1;
  assert.throws(() => validateEdgeAgentResponse(invalidEdge), /tokensPerSecond/);
  const legacy = structuredClone(response);
  delete legacy.metrics.tokensPerSecond;
  assert.equal(projectEdgeAgentResponseForCore(legacy, "local").metrics.tokensPerSecond, undefined);
}));
