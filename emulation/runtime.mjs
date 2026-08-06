import { TextEncoder } from "node:util";

export const roles = ["tech", "data", "security", "legal", "policy", "finance", "procurement", "operations"];
export const ports = Object.fromEntries(roles.map((role, index) => [role, 4311 + index]));
export const modes = ["raw", "sanitized", "local-summary", "metadata-only"];
const patterns = [/\b\d{6}-?[1-4]\d{6}\b/g, /\b01[016789]-?\d{3,4}-?\d{4}\b/g, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)(?:\.\d{1,3}){2}\b/g, /\b(?:account|계좌)\s*[:#]?\s*[\d-]{8,}\b/gi, /\b(?:secret|sensitive|민감)\s*[:=]\s*[^\s,;]+/gi];
export const byteLength = (value) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;
const normalize = (value) => value.normalize("NFKC").toLowerCase();
export function conceptMatches(text, concept, conceptAliases = {}) {
  const normalizedText = normalize(text);
  const variants = [concept, ...(conceptAliases[concept] ?? [])];
  return variants.some((variant) => normalizedText.includes(normalize(variant)));
}
export function allowed(level, mode, owner, requester, zone) {
  if (level === "public") return true;
  if (level === "internal") return mode !== "raw" || (requester === owner && zone === owner);
  if (level === "confidential") return mode === "raw" ? requester === owner && zone === owner : (mode !== "sanitized" || [owner, "security", "legal"].includes(requester));
  return mode !== "raw" && (mode !== "sanitized" || ["security", "legal"].includes(requester));
}
export function transform(document, mode) {
  const started = performance.now();
  let content;
  let removedSensitiveFieldCount = 0;
  if (mode === "raw") content = document.text;
  if (mode === "sanitized") {
    content = document.text;
    for (const pattern of patterns) content = content.replace(pattern, () => { removedSensitiveFieldCount += 1; return "[REDACTED]"; });
  }
  if (mode === "local-summary") {
    const sentences = document.text.split(/(?<=[.!?。]|다\.)\s+/).filter(Boolean);
    const terms = document.requiredConcepts ?? [];
    content = sentences.map((sentence) => ({ sentence, score: terms.filter((term) => conceptMatches(sentence, term, document.conceptAliases)).length })).sort((a, b) => b.score - a.score).slice(0, Math.max(2, terms.length)).map((item) => item.sentence).join(" ").slice(0, 1200);
    content = `[evidence:${document.id}] ${content}`;
  }
  const evidence = { documentId: document.id, canonicalId: document.canonicalId, title: document.title, section: document.section, ownerDepartment: document.ownerDepartment, securityLevel: document.securityLevel, effectiveDate: document.effectiveDate, contentByteLength: byteLength(document.text), ...(content === undefined ? {} : { content }) };
  return { evidence, removedSensitiveFieldCount, transformationMs: Number((performance.now() - started).toFixed(3)), responseBytes: byteLength(evidence) };
}
export function coverage(concepts, evidence, conceptAliases = {}) {
  if (!concepts.length) return 1;
  const text = JSON.stringify(evidence);
  return concepts.filter((concept) => conceptMatches(text, concept, conceptAliases)).length / concepts.length;
}
export function seeded(seed) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
}
