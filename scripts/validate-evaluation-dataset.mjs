import { readFile } from "node:fs/promises";

const file = process.argv[2] ?? "data/evaluation/annotation-template.jsonl";
const agents = new Set(["tech", "data", "security", "legal", "policy", "finance", "procurement", "operations"]);
const allowed = {
  difficulty: new Set(["basic", "advanced", "adversarial"]),
  data_class: new Set(["public", "internal", "confidential"]),
  adjudication_status: new Set(["pending", "agreed", "adjudicated", "excluded"]),
  split: new Set(["unassigned", "train", "validation", "test", "external-test"]),
};
const required = [
  "id", "group_id", "organization", "domain", "difficulty", "data_class", "query",
  "expected_agents", "required_concepts", "evidence", "forbidden_output",
  "annotator_ids", "adjudication_status", "split",
];
const text = await readFile(file, "utf8");
const rows = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
  try { return JSON.parse(line); } catch { throw new Error(`line ${index + 1}: invalid JSON`); }
});
const errors = [];
const ids = new Set();
const groupSplits = new Map();
for (const [index, row] of rows.entries()) {
  const line = index + 1;
  for (const field of required) if (!(field in row)) errors.push(`line ${line}: missing ${field}`);
  if (ids.has(row.id)) errors.push(`line ${line}: duplicate id ${row.id}`);
  ids.add(row.id);
  for (const [field, values] of Object.entries(allowed)) {
    if (!values.has(row[field])) errors.push(`line ${line}: invalid ${field}=${row[field]}`);
  }
  for (const agent of row.expected_agents ?? []) if (!agents.has(agent)) errors.push(`line ${line}: invalid agent ${agent}`);
  if (!(row.query ?? "").trim()) errors.push(`line ${line}: empty query`);
  if (groupSplits.has(row.group_id) && groupSplits.get(row.group_id) !== row.split) {
    errors.push(`line ${line}: group ${row.group_id} crosses splits`);
  }
  groupSplits.set(row.group_id, row.split);
  for (const evidence of row.evidence ?? []) {
    if (!evidence.document_id || !evidence.span || !evidence.supports) errors.push(`line ${line}: incomplete evidence`);
  }
  if (row.eligible_for_confirmatory_test) {
    if (row.label_status !== "final") errors.push(`line ${line}: confirmatory row requires label_status=final`);
    if (!["agreed", "adjudicated"].includes(row.adjudication_status)) {
      errors.push(`line ${line}: confirmatory row requires completed adjudication`);
    }
    if ((row.annotator_ids ?? []).length < 2) errors.push(`line ${line}: confirmatory row requires >=2 annotators`);
    if ((row.evidence ?? []).some((item) => item.span.includes("확정해야 함"))) {
      errors.push(`line ${line}: confirmatory row contains provisional evidence span`);
    }
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ file, valid: true, rows: rows.length, groups: groupSplits.size }, null, 2));
}
