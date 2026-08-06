import http from "node:http";
import { readFile } from "node:fs/promises";
import { allowed, byteLength, coverage, ports, transform } from "./runtime.mjs";

const role = process.argv[2];
if (!(role in ports)) throw new Error(`Unknown role: ${role}`);
const corpus = JSON.parse(await readFile(new URL("../data/rag-corpus.json", import.meta.url), "utf8"));
const documents = new Map(corpus.documents.filter((item) => item.agent === role).map((item) => [item.id, item]));
const readBody = (request) => new Promise((resolve, reject) => { const chunks = []; request.on("data", (chunk) => chunks.push(chunk)); request.on("end", () => resolve(Buffer.concat(chunks))); request.on("error", reject); });
const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") return json(response, 200, { ok: true, role, endpoint: ports[role] });
  if (request.method !== "POST" || request.url !== "/evidence/fetch") return json(response, 404, { error: "not found" });
  const started = performance.now();
  try {
    const raw = await readBody(request); const body = JSON.parse(raw.toString("utf8"));
    const source = body.derivedDocument?.ownerDepartment === role ? body.derivedDocument : documents.get(body.documentId) ?? documents.values().next().value;
    if (!source) return json(response, 404, { error: "no evidence for role" });
    const document = { id: source.id, canonicalId: source.canonicalId ?? source.sourceSha256, title: source.title, section: source.section, ownerDepartment: role, securityLevel: body.securityLevel ?? source.securityLevel ?? "public", effectiveDate: source.effectiveDate ?? source.publishedAt ?? "unknown", text: body.textOverride ?? source.text, requiredConcepts: body.requiredConcepts ?? [], conceptAliases: body.conceptAliases ?? {} };
    const policyAllowed = allowed(document.securityLevel, body.mode, role, body.requesterRole ?? "core", body.requesterZone ?? "core");
    if (!policyAllowed && !body.policyBypassForExperiment) return json(response, 403, { policyViolation: true, policyBypassForExperiment: false, selectedMode: body.mode });
    const transformed = transform(document, body.mode);
    const labelBasedCoverage = coverage(document.requiredConcepts, { title: document.title, section: document.section, content: document.text }, document.conceptAliases);
    const runtimeProxyCoverage = body.mode === "metadata-only" ? 0 : coverage(document.requiredConcepts, transformed.evidence, document.conceptAliases);
    const payload = { ...transformed, policyStatus: policyAllowed ? "allowed" : "bypassed", policyViolation: !policyAllowed, policyBypassForExperiment: !policyAllowed, selectedMode: body.mode, coverage: runtimeProxyCoverage, labelBasedCoverage, runtimeProxyCoverage, coverageBasis: "canonical-utf8-content-with-derived-aliases", requestBytes: raw.length, elapsedMs: Number((performance.now() - started).toFixed(3)), syntheticProfile: true };
    return json(response, 200, payload);
  } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
});
function json(response, status, body) { const data = JSON.stringify(body); response.writeHead(status, { "content-type": "application/json", "content-length": byteLength(data) }); response.end(data); }
server.listen(ports[role], "127.0.0.1", () => process.send?.({ type: "ready", role, port: ports[role] }));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
