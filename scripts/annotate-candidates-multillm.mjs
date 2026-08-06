import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const argument = (name, fallback) => process.argv.find((item) => item.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
const inputFile = argument("input", "data/evaluation/ax-candidate-set-240.jsonl");
const limit = Number(argument("limit", "240"));
const sampling = argument("sampling", "head");
const runId = argument("run-id", `multi-llm-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const models = argument("models", "qwen2.5:3b,llama3.1:8b,gemma3:4b").split(",").map((item) => item.trim()).filter(Boolean);
const endpoint = argument("endpoint", process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const requestTimeoutMs = Number(argument("request-timeout-ms", "120000"));
const maxAttempts = Number(argument("max-attempts", "2"));
const candidatesText = await readFile(new URL(inputFile, root), "utf8");
const allCandidates = candidatesText.trim().split(/\r?\n/).map(JSON.parse);
const sampledCandidates = sampling === "semantic-family" ? firstBy(allCandidates, (candidate) => candidate.semantic_family_id) : allCandidates;
const candidates = sampledCandidates.slice(0, limit);
const outputDirectory = new URL(`data/evaluation/multi-llm-annotation/${runId}/`, root);
await mkdir(outputDirectory, { recursive: true });

const roles = ["tech", "data", "security", "legal", "policy", "finance", "procurement", "operations"];
const roleDescriptions = {
  tech: "시스템 아키텍처, LLM/RAG 구현, 성능 및 기술 설계",
  data: "데이터 품질, 생명주기, 메타데이터, 학습 데이터",
  security: "접근통제, 개인정보 안전조치, 공격과 보안",
  legal: "법적 근거, 계약 책임, 개인정보 및 저작권 법률",
  policy: "공공성, 윤리, 설명가능성, 거버넌스",
  finance: "예산, TCO, 비용과 경제성",
  procurement: "발주, 제안요청서, 조달과 검수",
  operations: "SLA, 장애, 모니터링, 운영 절차",
};
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["role_indices", "confidence", "needs_review"],
  properties: {
    role_indices: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "integer", minimum: 0, maximum: 7 } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    needs_review: { type: "boolean" },
  },
};

const provenance = [];
for (const model of models) provenance.push(await modelProvenance(model));
await writeFile(new URL("run-config.json", outputDirectory), JSON.stringify({
  runId, inputFile, inputSha256: sha(candidatesText), sampling, candidateIds: candidates.map((candidate) => candidate.id), candidates: candidates.length, models,
  endpoint, temperature: 0, seed: 20260806, numCtx: 1024, numPredict: 64, requestTimeoutMs, maxAttempts,
  promptVersion: "ax-multillm-blind-role-v1", schemaSha256: sha(JSON.stringify(schema)), modelProvenance: provenance,
  generatedAt: new Date().toISOString(),
}, null, 2));

for (const [modelIndex, model] of models.entries()) {
  const slug = model.replace(/[^a-zA-Z0-9.-]+/g, "_");
  const progressUrl = new URL(`${slug}.jsonl`, outputDirectory);
  const records = await readJsonLines(progressUrl);
  const completed = new Set(records.filter((row) => row.status === "ok").map((row) => row.id));
  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (completed.has(candidate.id)) continue;
    const roleOrder = rotate(roles, (candidateIndex * 3 + modelIndex * 5) % roles.length);
    const started = performance.now();
    let record;
    try {
      const response = await judge(model, candidate, roleOrder);
      const validation = validate(response.annotation);
      record = { id: candidate.id, model, status: validation.valid ? "ok" : "invalid", roleOrder, annotation: response.annotation, raw: response.raw, validation, usage: response.usage, elapsedMs: Number((performance.now() - started).toFixed(1)) };
    } catch (error) {
      record = { id: candidate.id, model, status: "error", roleOrder, error: String(error.message ?? error), elapsedMs: Number((performance.now() - started).toFixed(1)) };
    }
    const existingIndex = records.findIndex((row) => row.id === candidate.id);
    if (existingIndex >= 0) records[existingIndex] = record; else records.push(record);
    await writeFile(progressUrl, `${records.map(JSON.stringify).join("\n")}\n`);
    console.log(`[${model}] ${candidateIndex + 1}/${candidates.length} ${candidate.id} ${record.status} ${record.elapsedMs}ms`);
  }
}
console.log(outputDirectory.pathname);

async function modelProvenance(model) {
  const [response, tagsResponse] = await Promise.all([
    fetch(`${endpoint}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) }),
    fetch(`${endpoint}/api/tags`),
  ]);
  if (!response.ok) throw new Error(`Ollama show ${model}: ${response.status} ${(await response.text()).slice(0, 300)}`);
  const payload = await response.json();
  const tags = tagsResponse.ok ? await tagsResponse.json() : { models: [] };
  const tag = tags.models?.find((item) => item.name === model || item.model === model);
  return { model, family: payload.details?.family, parameterSize: payload.details?.parameter_size, quantization: payload.details?.quantization_level, digest: tag?.digest, size: tag?.size, modifiedAt: tag?.modified_at ?? payload.modified_at };
}

async function judge(model, candidate, roleOrder) {
  const system = "You are a blinded reviewer for a Korean public-sector multi-agent benchmark. Select only roles directly necessary for the requested deliverable. Return JSON only: {\"role_indices\":[0,2],\"confidence\":0.8,\"needs_review\":false}. Choose 1-4 valid role indices. Do not copy an existing label.";
  const roleGuide = roleOrder.map((role, index) => `[${index}] ${role}: ${roleDescriptions[role]}`).join("\n");
  const user = `QUERY\n${candidate.query}\n\nCONTEXT\norganization=${candidate.organization}; domain=${candidate.domain}; task_angle=${candidate.task_angle}\n\nAVAILABLE ROLES (order is randomized)\n${roleGuide}\n\nChoose 1-4 directly required roles.`;
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/api/chat`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(requestTimeoutMs),
        body: JSON.stringify({ model, stream: false, format: "json", keep_alive: "2m", messages: [{ role: "system", content: system }, { role: "user", content: user }], options: { temperature: 0, seed: 20260806, num_ctx: 1024, num_predict: 64 } }),
      });
      if (!response.ok) throw new Error(`Ollama ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const payload = await response.json();
      const raw = payload.message?.content ?? "";
      const compact = JSON.parse(raw);
      const annotation = {
        expected_agents: [...new Set((compact.role_indices ?? []).filter(Number.isInteger).map((index) => roleOrder[index]).filter(Boolean))],
        confidence: Number(compact.confidence),
        needs_review: Boolean(compact.needs_review),
      };
      return { annotation, raw, usage: { totalDuration: payload.total_duration, loadDuration: payload.load_duration, promptEvalCount: payload.prompt_eval_count, evalCount: payload.eval_count, evalDuration: payload.eval_duration } };
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

function validate(annotation) {
  const errors = [];
  if (!Array.isArray(annotation.expected_agents) || annotation.expected_agents.length < 1 || annotation.expected_agents.length > 4 || annotation.expected_agents.some((role) => !roles.includes(role))) errors.push("invalid expected_agents");
  if (!Number.isFinite(annotation.confidence) || annotation.confidence < 0 || annotation.confidence > 1) errors.push("invalid confidence");
  return { valid: errors.length === 0, errors };
}
function rotate(values, offset) { return [...values.slice(offset), ...values.slice(0, offset)]; }
function firstBy(rows, key) { const seen = new Set(); return rows.filter((row) => { const value = key(row); if (seen.has(value)) return false; seen.add(value); return true; }); }
function sha(value) { return createHash("sha256").update(value).digest("hex"); }
async function readJsonLines(url) { try { const text = await readFile(url, "utf8"); return text.trim() ? text.trim().split(/\r?\n/).map(JSON.parse) : []; } catch (error) { if (error.code === "ENOENT") return []; throw error; } }
