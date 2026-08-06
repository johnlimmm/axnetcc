import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
const root = new URL("../", import.meta.url);
const argument = (name, fallback) => process.argv.find((item) => item.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
const inputFile = argument("input", "data/evaluation/ax-candidate-set-240.jsonl");
const limit = Number(argument("limit", "40"));
const sampling = argument("sampling", "semantic-family");
const runId = argument("run-id", `openai-blind-role-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const model = argument("model", process.env.COMMERCIAL_JUDGE_MODEL ?? "gpt-5.4-mini");
const endpoint = (process.env.COMMERCIAL_JUDGE_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
const apiKey = process.env.COMMERCIAL_JUDGE_API_KEY;
if (!apiKey) throw new Error("COMMERCIAL_JUDGE_API_KEY is not configured.");

const inputText = await readFile(new URL(inputFile, root), "utf8");
const allCandidates = inputText.trim().split(/\r?\n/).map(JSON.parse);
const sampled = sampling === "semantic-family" ? firstBy(allCandidates, (row) => row.semantic_family_id) : allCandidates;
const candidates = sampled.slice(0, limit);
const outputDirectory = new URL(`data/evaluation/openai-blind-role/${runId}/`, root);
await mkdir(outputDirectory, { recursive: true });
const progressUrl = new URL("responses.jsonl", outputDirectory);
const records = await readJsonLines(progressUrl);
const completed = new Set(records.filter((row) => row.status === "ok").map((row) => row.id));
const roles = ["tech", "data", "security", "legal", "policy", "finance", "procurement", "operations"];
const roleDescriptions = {
  tech: "시스템 아키텍처, LLM/RAG 구현, 성능 및 기술 설계", data: "데이터 품질, 생명주기, 메타데이터, 학습 데이터",
  security: "접근통제, 개인정보 안전조치, 공격과 보안", legal: "법적 근거, 계약 책임, 개인정보 및 저작권 법률",
  policy: "공공성, 윤리, 설명가능성, 거버넌스", finance: "예산, TCO, 비용과 경제성",
  procurement: "발주, 제안요청서, 조달과 검수", operations: "SLA, 장애, 모니터링, 운영 절차",
};
const promptVersion = "ax-multillm-blind-role-v1-compact-index";
await writeFile(new URL("run-config.json", outputDirectory), JSON.stringify({ runId, inputFile, inputSha256: sha(inputText), sampling, candidateIds: candidates.map((row) => row.id), model, endpointHost: new URL(endpoint).hostname, promptVersion, temperature: 0, generatedAt: new Date().toISOString() }, null, 2));

for (const [candidateIndex, candidate] of candidates.entries()) {
  if (completed.has(candidate.id)) continue;
  const roleOrder = rotate(roles, (candidateIndex * 3 + 15) % roles.length);
  const system = "You are a blinded reviewer for a Korean public-sector multi-agent benchmark. Select only roles directly necessary for the requested deliverable. Return JSON only: {\"role_indices\":[0,2],\"confidence\":0.8,\"needs_review\":false}. Choose 1-4 valid role indices. Do not copy an existing label.";
  const roleGuide = roleOrder.map((role, index) => `[${index}] ${role}: ${roleDescriptions[role]}`).join("\n");
  const user = `QUERY\n${candidate.query}\n\nCONTEXT\norganization=${candidate.organization}; domain=${candidate.domain}; task_angle=${candidate.task_angle}\n\nAVAILABLE ROLES (order is randomized)\n${roleGuide}\n\nChoose 1-4 directly required roles.`;
  const started = performance.now();
  let record;
  try {
    const initial = await request(system, user, false);
    let result = initial;
    let annotation = parseAnnotation(initial.raw, roleOrder);
    let errors = validate(annotation);
    let repairApplied = false;
    if (errors.length) {
      result = await request(`${system} The previous response violated the 1-4 role constraint; comply exactly.`, user, true);
      annotation = parseAnnotation(result.raw, roleOrder);
      errors = validate(annotation);
      repairApplied = true;
    }
    record = { id: candidate.id, model: result.model, status: errors.length ? "invalid" : "ok", roleOrder, annotation, raw: result.raw, initialRaw: repairApplied ? initial.raw : undefined, repairApplied, responseId: result.responseId, systemFingerprint: result.systemFingerprint, usage: result.usage, initialUsage: repairApplied ? initial.usage : undefined, validation: { valid: errors.length === 0, errors }, elapsedMs: Number((performance.now() - started).toFixed(1)) };
  } catch (error) { record = { id: candidate.id, model, status: "error", roleOrder, error: String(error.message ?? error), elapsedMs: Number((performance.now() - started).toFixed(1)) }; }
  const existing = records.findIndex((row) => row.id === candidate.id);
  if (existing >= 0) records[existing] = record; else records.push(record);
  await writeFile(progressUrl, `${records.map(JSON.stringify).join("\n")}\n`);
  console.log(`[OpenAI ${model}] ${candidateIndex + 1}/${candidates.length} ${candidate.id} ${record.status} ${record.elapsedMs}ms`);
}
console.log(outputDirectory.pathname);

async function request(system, user, strict) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const responseFormat = strict ? { type: "json_schema", json_schema: { name: "blind_role_label", strict: true, schema: { type: "object", additionalProperties: false, required: ["role_indices", "confidence", "needs_review"], properties: { role_indices: { type: "array", minItems: 1, maxItems: 4, items: { type: "integer", minimum: 0, maximum: 7 } }, confidence: { type: "number", minimum: 0, maximum: 1 }, needs_review: { type: "boolean" } } } } } : { type: "json_object" };
      const response = await fetch(`${endpoint}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(180000), body: JSON.stringify({ model, temperature: 0, response_format: responseFormat, messages: [{ role: "system", content: system }, { role: "user", content: user }] }) });
      if (!response.ok) throw new Error(`OpenAI ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const payload = await response.json();
      return { raw: payload.choices?.[0]?.message?.content ?? "{}", responseId: payload.id, model: payload.model ?? model, systemFingerprint: payload.system_fingerprint, usage: payload.usage };
    } catch (error) { lastError = error; }
  }
  throw lastError;
}
function parseAnnotation(raw, roleOrder) { const compact = JSON.parse(raw); return { expected_agents: [...new Set((compact.role_indices ?? []).filter(Number.isInteger).map((index) => roleOrder[index]).filter(Boolean))], confidence: Number(compact.confidence), needs_review: Boolean(compact.needs_review) }; }
function validate(annotation) { const errors = []; if (annotation.expected_agents.length < 1 || annotation.expected_agents.length > 4) errors.push("invalid expected_agents"); if (!Number.isFinite(annotation.confidence) || annotation.confidence < 0 || annotation.confidence > 1) errors.push("invalid confidence"); return errors; }
function firstBy(rows, key) { const seen = new Set(); return rows.filter((row) => { const value = key(row); if (seen.has(value)) return false; seen.add(value); return true; }); }
function rotate(values, offset) { return [...values.slice(offset), ...values.slice(0, offset)]; }
function sha(value) { return createHash("sha256").update(value).digest("hex"); }
async function readJsonLines(url) { try { const text = await readFile(url, "utf8"); return text.trim() ? text.trim().split(/\r?\n/).map(JSON.parse) : []; } catch (error) { if (error.code === "ENOENT") return []; throw error; } }
