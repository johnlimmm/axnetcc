import assert from "node:assert/strict";
import test from "node:test";
import { publicDemoSynthesis, demoSynthesisEnabled, filterDemoSynthesisCitations } from "../lib/demo-synthesis.ts";
import { generateLocalAnswer } from "../lib/local-llm.ts";
const publicEvidence = { id: "PUB-EXACT-7", title: "Approved source", excerpt: "The public source requires API access logs.", classification: "public", disclosure: "sanitized-preview", effectiveDate: "v1" };
const agent = { id: "tech", summary: "Generated claim: invent thirty-hour deadline.", evidence: [publicEvidence] };
test("demo synthesis preserves actual approved public facts and exact IDs, not generated statements as source", () => {
  const projected = publicDemoSynthesis([agent, { ...agent }]);
  assert.equal(projected.evidence.length, 1); assert.equal(projected.evidence[0].id, "PUB-EXACT-7");
  assert.equal(projected.evidence[0].text, publicEvidence.excerpt);
  assert.equal(projected.evidence[0].sourceType, "public");
  assert.equal(Object.hasOwn(projected, "nonAuthoritativeSummaries"), false);
  assert.equal(JSON.stringify(projected.evidence).includes("thirty-hour"), false);
});
test("restricted, confidential, and reference-only text cannot enter demo synthesis, including mixed Agent notes", () => {
  const secrets = [
    { ...publicEvidence, id: "INT-1", classification: "internal", disclosure: "reference-only", excerpt: "INTERNAL-SECRET" },
    { ...publicEvidence, id: "CONF-1", classification: "confidential", disclosure: "sanitized-preview", excerpt: "CONFIDENTIAL-SECRET" },
    { ...publicEvidence, id: "PUBLIC-REF", disclosure: "reference-only", excerpt: "REFERENCE-ONLY-SECRET" },
  ];
  const projected = publicDemoSynthesis([{ ...agent, summary: "MIXED-SUMMARY-SECRET", evidence: [publicEvidence, ...secrets] }]);
  assert.deepEqual(projected.evidence.map(item => item.id), ["PUB-EXACT-7"]);
  assert.equal(Object.hasOwn(projected, "nonAuthoritativeSummaries"), false);
  assert.doesNotMatch(JSON.stringify(projected), /INTERNAL-SECRET|CONFIDENTIAL-SECRET|REFERENCE-ONLY-SECRET|MIXED-SUMMARY-SECRET/);
});
async function runtime(profile, run) {
  const saved = { ...process.env }; const oldFetch = globalThis.fetch;
  process.env.DEMO_PROFILE = profile; process.env.LOCAL_LLM_BASE_URL = "http://localhost:13434";
  delete process.env.DEMO_SYNTHESIS_MAX_TOKENS;
  try { await run(); } finally { globalThis.fetch = oldFetch; for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
}
const input = () => ({ agent: "tech", agentName: "Core", responsibility: "synthesis", query: "Explain public API logging", ...publicDemoSynthesis([agent]), fallback: "Explicit deterministic fallback", outputFormat: "integrated-report" });
test("isolated demo calls real provider with approved excerpts, concise instruction and bounded preregistered token setting", () => runtime("service", async () => {
  let body; let calls = 0;
  globalThis.fetch = async (_url, options) => { calls++; body = JSON.parse(options.body); return new Response(JSON.stringify({ done: true, message: { content: "Public API access logs [PUB-EXACT-7]" }, prompt_eval_count: 40, eval_count: 8 })); };
  const result = await generateLocalAnswer(input());
  assert.equal(demoSynthesisEnabled(), true); assert.equal(calls, 1); assert.equal(body.options.num_predict, 384);
  assert.match(body.messages[0].content, /2-3 concise Korean/); assert.match(body.messages[0].content, /Do not invent/);
  assert.match(body.messages[1].content, /\[PUB-EXACT-7\].*Approved source/); assert.match(body.messages[1].content, /requires API access logs/);
  assert.doesNotMatch(body.messages[1].content, /NON-AUTHORITATIVE GENERATED NOTES|thirty-hour/);
  assert.equal(result.metrics.backend, "ollama"); assert.equal(result.metrics.promptTokens, 40);
  process.env.DEMO_SYNTHESIS_MAX_TOKENS = "512"; await generateLocalAnswer(input()); assert.equal(body.options.num_predict, 512);
  process.env.DEMO_SYNTHESIS_MAX_TOKENS = "513"; const rejected = await generateLocalAnswer(input());
  assert.equal(calls, 2); assert.equal(rejected.metrics.backend, "deterministic"); assert.equal(rejected.metrics.failureCode, "configuration");
}));
test("ordinary deployment keeps original integration budget and excludes demo-only notes", () => runtime("", async () => {
  let body; globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify({ done: true, message: { content: "Normal report" } })); };
  await generateLocalAnswer(input()); assert.equal(demoSynthesisEnabled(), false); assert.equal(body.options.num_predict, 192);
  assert.doesNotMatch(body.messages[1].content, /NON-AUTHORITATIVE GENERATED NOTES/);
}));
test("provider failure is never replaced with evidence-only text labeled LLM success", () => runtime("operator", async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; return new Response("bad provider", { status: 503 }); };
  const result = await generateLocalAnswer(input()); assert.equal(calls, 1);
  assert.equal(result.metrics.backend, "deterministic"); assert.equal(result.text, "Explicit deterministic fallback");
  assert.equal(result.metrics.promptTokens, null);
}));

test("demo keeps approved source conditions beyond250 characters up to800 and limits factual chunks to4", () => runtime("service", async () => {
  const fullExcerpt = "Public parsing conditions. " + "x".repeat(280) + " EMBEDDING-CONDITION SEARCH-API-CONDITION " + "y".repeat(460) + " OUTSIDE-APPROVED-PROMPT-BUDGET";
  const projected = publicDemoSynthesis([{ ...agent, evidence: Array.from({ length: 5 }, (_, index) => ({ ...publicEvidence, id: `PUB-${index}`, excerpt: fullExcerpt })) }]);
  let body; globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify({ done: true, message: { content: "Supported source response [PUB-0]" } })); };
  await generateLocalAnswer({ ...input(), ...projected });
  const prompt = body.messages[1].content;
  assert.match(prompt, /EMBEDDING-CONDITION SEARCH-API-CONDITION/);
  assert.ok(prompt.includes(fullExcerpt.slice(0, 800)));
  assert.doesNotMatch(prompt, /OUTSIDE-APPROVED-PROMPT-BUDGET|\[PUB-4\]/);
  process.env.DEMO_PROFILE = "";
  const ordinaryEvidence = [...projected.evidence, { ...projected.evidence[0], id: "PUB-4" }];
  await generateLocalAnswer({ ...input(), evidence: ordinaryEvidence });
  assert.doesNotMatch(body.messages[1].content, /EMBEDDING-CONDITION SEARCH-API-CONDITION/);
  assert.match(body.messages[1].content, /\[PUB-4\]/);
}));

test("explicitly internal generated summary cannot pass even with exclusively public references", () => runtime("service", async () => {
  const projected = publicDemoSynthesis([{ ...agent, summaryClassification: "internal", summary: "INTERNAL-GENERATED-SUMMARY-SECRET" }]);
  let body; globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify({ done: true, message: { content: "Public source answer [PUB-EXACT-7]" } })); };
  await generateLocalAnswer({ ...input(), ...projected });
  assert.doesNotMatch(JSON.stringify(body), /INTERNAL-GENERATED-SUMMARY-SECRET/);
  assert.match(body.messages[1].content, /requires API access logs/);
}));
test("demo final citations use only supplied public IDs and never append references to insufficient evidence", () => {
  assert.equal(filterDemoSynthesisCitations("Insufficient public evidence [CONF-1]", new Set()), "Insufficient public evidence");
  assert.equal(filterDemoSynthesisCitations("Unsupported citation [REF-1]", new Set(["PUB-1"])), "Unsupported citation");
  assert.equal(filterDemoSynthesisCitations("Supported [PUB-1] and invalid [REF-1]", new Set(["PUB-1"])), "Supported [PUB-1] and invalid");
  const projected = publicDemoSynthesis([{ ...agent, evidence: Array.from({ length: 5 }, (_, index) => ({ ...publicEvidence, id: `PUB-${index}` })) }]);
  assert.deepEqual(projected.evidence.map(item => item.id), ["PUB-0", "PUB-1", "PUB-2", "PUB-3"]);
  assert.equal(filterDemoSynthesisCitations("Outside supplied budget [PUB-4]", new Set(projected.evidence.map(item => item.id))), "Outside supplied budget");
});
