import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { conceptMatches } from "../emulation/runtime.mjs";
import { knowledge } from "../lib/knowledge.ts";

const datasetUrl = new URL("../data/evaluation/ax-golden-set-40.jsonl", import.meta.url);
const outputUrl = new URL("../data/evaluation/ax-golden-set-40-security-manifest.json", import.meta.url);
const datasetText = await readFile(datasetUrl, "utf8");
const cases = datasetText.trim().split(/\r?\n/).map(JSON.parse);
const corpus = JSON.parse(await readFile(new URL("../data/rag-corpus.json", import.meta.url), "utf8"));
const aliases = JSON.parse(await readFile(new URL("../data/security-evidence-manifest.json", import.meta.url), "utf8")).conceptAliases;
const documents = [...knowledge, ...corpus.documents];
const byId = new Map(documents.map((document) => [document.id, document]));
const queryRoleRequiredConcepts = {}; const forcedAssignments = [];

for (const item of cases) {
  const roleDocuments = Object.fromEntries(item.expected_agents.map((role) => [role, item.relevant_document_ids.map((id) => byId.get(id)).filter((document) => document?.agent === role)]));
  const mapping = Object.fromEntries(item.expected_agents.map((role) => [role, []]));
  for (const concept of item.required_concepts) {
    let roles = item.expected_agents.filter((role) => roleDocuments[role].some((document) => covers(document, concept)));
    if (!roles.length) roles = item.expected_agents.filter((role) => documents.some((document) => document.agent === role && covers(document, concept)));
    if (!roles.length) {
      roles = [...item.expected_agents];
      forcedAssignments.push({ queryId: item.id, concept, roles, reason: "No lexical/alias support in role corpus; retained for every required role rather than dropped." });
    }
    roles.forEach((role) => mapping[role].push(concept));
  }
  for (const role of item.expected_agents) if (!mapping[role].length) {
    mapping[role] = [...item.required_concepts];
    forcedAssignments.push({ queryId: item.id, concept: "*", roles: [role], reason: "Role had no corpus-matched concept; full query concept set retained." });
  }
  queryRoleRequiredConcepts[item.id] = mapping;
}

await writeFile(outputUrl, JSON.stringify({
  version: 1,
  derivedFrom: "data/evaluation/ax-golden-set-40.jsonl",
  sourceSha256: createHash("sha256").update(datasetText).digest("hex"),
  method: "For each required concept, retain every expected role whose labelled relevant document or role corpus matches under the fixed alias matcher. Never drop an unmatched concept; assign it to every expected role and record it in forcedAssignments.",
  queryRoleRequiredConcepts,
  forcedAssignments,
}, null, 2));
console.log(outputUrl.pathname);

function covers(document, concept) { return conceptMatches(`${document.title} ${document.section} ${document.text} ${(document.tags ?? []).join(" ")}`, concept, aliases); }
