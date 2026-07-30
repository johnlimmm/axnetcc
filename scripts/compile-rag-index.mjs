import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const agents = ["tech", "security", "legal", "finance"];
const documents = [];

for (const agent of agents) {
  const file = new URL(`../corpus/processed/${agent}.jsonl`, import.meta.url);
  const lines = (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const chunk = JSON.parse(line);
    documents.push({
      id: chunk.chunk_id,
      agent: chunk.agent,
      title: chunk.title,
      section: chunk.section,
      text: chunk.text,
      sourceUrl: chunk.source_url,
      publishedAt: chunk.published_at,
      sourceSha256: chunk.source_sha256,
      licenseReview: chunk.license_review,
    });
  }
}

const counts = Object.fromEntries(
  agents.map((agent) => [agent, documents.filter((document) => document.agent === agent).length]),
);
const payload = {
  generatedAt: new Date().toISOString(),
  algorithm: "BM25 sparse vector retrieval",
  count: documents.length,
  counts,
  documents,
};

await writeFile(
  new URL("../data/rag-corpus.json", import.meta.url),
  `${JSON.stringify(payload)}\n`,
  "utf8",
);
console.log(`Compiled ${documents.length} chunks to ${join("data", "rag-corpus.json")}`);

