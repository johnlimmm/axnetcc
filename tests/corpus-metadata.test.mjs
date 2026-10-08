import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Digitalmarket edition date follows the PDF cover month, not its older URL directory", () => {
  const sources = JSON.parse(readFileSync(new URL("../corpus/sources.json", import.meta.url), "utf8"));
  const corpus = JSON.parse(readFileSync(new URL("../data/rag-corpus.json", import.meta.url), "utf8"));
  const source = sources.find(item => item.id === "digitalmarket-contract-guide");
  // Verified original PDF cover: 2024. 4.; no day is established.
  assert.equal(source.published_at, "2024-04");
  const chunks = corpus.documents.filter(item => item.id.startsWith(`${source.id}:`));
  assert.equal(chunks.length, 132);
  assert.deepEqual([...new Set(chunks.map(item => item.agent))].sort(), ["finance", "legal", "procurement"]);
  for (const chunk of chunks) {
    assert.equal(chunk.publishedAt, source.published_at);
    assert.equal(chunk.sourceUrl, source.url);
    assert.match(chunk.sourceUrl, /\/2021\/4\/22\//);
    assert.equal(chunk.sourceSha256, "baff264721b21e5faed02928ddf841767390284d0a9690be828445cb760aca3e");
    assert.equal(chunk.licenseReview, "required");
  }
  assert.equal(source.license_review, "required");
});
