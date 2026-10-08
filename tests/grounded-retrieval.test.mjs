import assert from "node:assert/strict";
import test from "node:test";
import { selectPublicPassage, selectPublicHits } from "../lib/public-passages.ts";

const doc = (extra = {}) => ({ id: "guide:tech:page:4:1", agent: "tech", title: "Technical guide", section: "page:4", text: "API access requires authorization. However, public endpoints are exempt.", sourceUrl: "https://example.org/guide.pdf", sourceSha256: "v1", publishedAt: "2026-01-01", licenseReview: "required", ...extra });
test("query-aware passage retains tail match and adjacent qualification, with exact offsets", () => {
  const text = "Background information. ".repeat(35) + "API access requires authorization. However, public endpoints are exempt.";
  const passage = selectPublicPassage("API authorization", text, 300);
  assert.ok(passage.start > 480);
  assert.match(passage.text, /requires authorization.*However/s);
  assert.equal(text.slice(passage.start, passage.end), passage.text);
  assert.ok(passage.text.length <= 300);
});
test("cross-role copies deduplicate while retaining role and citation provenance", () => {
  const hits = selectPublicHits("API", [{chunk:doc(),score:8},{chunk:doc({id:"guide:security:page:4:1",agent:"security"}),score:7}],3);
  assert.equal(hits.length,1);
  assert.deepEqual(hits[0].agents,["tech","security"]);
  assert.equal(hits[0].sourceIds.length,2);
  assert.equal(hits[0].chunk.licenseReview,"required");
});
test("same words from distinct versions or page contexts never collapse", () => {
  const hits = selectPublicHits("API", [doc(),doc({id:"v2",sourceSha256:"v2"}),doc({id:"p5",section:"page:5"})].map(chunk=>({chunk,score:8})),4);
  assert.equal(hits.length,3);
});
test("listing, search XML, table of contents and unproven source cannot become factual evidence", () => {
  const bad = [doc({section:"document",text:"API guide download list"}),doc({text:"CONTENTS\nAPI security 04\nData 05"}),doc({text:"2\n목 차\n" + "API 보안 가이드 04\n".repeat(5)}),doc({sourceUrl:undefined}),doc({sourceUrl:"https://example.org/lawSearch.do",text:"<LawSearch>API</LawSearch>"})];
  const hits = selectPublicHits("API", [...bad.map(chunk=>({chunk,score:100})),{chunk:doc(),score:2}],3);
  assert.equal(hits.length,1);
  assert.equal(hits[0].chunk.id,doc().id);
});
test("passage does not silently cut a long indivisible sentence or fabricate ellipses", () => {
  assert.equal(selectPublicPassage("API", "API " + "x".repeat(200), 100).text, "");
});
test("PDF soft line wraps cannot detach an overbudget approval qualification", () => {
  for (const newline of ["\n", "\r\n"]) {
    const text = "API " + "x".repeat(1170) + " requires approval" + newline +
      "only for private administrative endpoints, never for public endpoints.";
    assert.ok(text.length > 1200);
    assert.deepEqual(selectPublicPassage("API", text), {text:"",start:0,end:0});
    assert.equal(selectPublicHits("API", [{chunk:doc({text}),score:9}],1).length,0);
  }
});
test("fitting wrapped Korean and English conditions remain exact contiguous statements", () => {
  for (const statement of [
    "API access requires approval\nonly for private endpoints, never public endpoints.",
    "API 접근 승인은\n비공개 관리 엔드포인트에만 필요하며 공개 엔드포인트에는 필요하지 않다.",
  ]) {
    const text = "Background information. ".repeat(35) + statement;
    const passage = selectPublicPassage("API", text,150);
    assert.ok(passage.text.includes(statement));
    assert.equal(text.slice(passage.start,passage.end),passage.text);
    assert.ok(passage.text.length <= 150);
  }
});
test("explicit following qualifiers are atomic with a completed rule at the cap", () => {
  const rule = "API " + "x".repeat(1140) + " requires approval.";
  const exception = " However, public endpoints are exempt from approval and must remain accessible without prior authorization.";
  assert.equal(rule.length,1163);
  assert.ok((rule + exception).length > 1200);
  assert.deepEqual(selectPublicPassage("API",rule + exception),{text:"",start:0,end:0});
  // A query matching only the caveat cannot detach it from its overbudget premise.
  assert.equal(selectPublicPassage("public endpoints",rule + exception).text,"");
});
test("Korean and English qualifier chains survive sentence-boundary selection or are omitted whole", () => {
  for (const qualifier of ["다만 공개 API는 제외한다.","단, 공개 API는 제외한다.","예외적으로 공개 API는 제외한다.","이 경우 공개 API는 제외한다.","경우에 따라 공개 API는 제외한다.","Only private API endpoints require approval.","Unless the API is public, approval is needed.","Otherwise, public API endpoints are exempt."]) {
    const rule = "API " + "x".repeat(90) + " requires approval.";
    const group = rule + " " + qualifier;
    assert.equal(selectPublicPassage("API",group,rule.length + 1).text,"");
    const text = "Background. ".repeat(30) + group;
    const passage = selectPublicPassage("API",text,group.length + 1);
    assert.ok(passage.text.includes(group));
    assert.equal(text.slice(passage.start,passage.end),passage.text);
  }
});
test("consecutive caveats keep their predecessor, without blocking independent neighboring sentences", () => {
  const group = "Administrative access requires approval. However, public endpoints are exempt. Unless abuse is detected, they remain available.";
  const text = "Background information. ".repeat(20) + group;
  const fitting = selectPublicPassage("abuse",text,group.length + 1);
  assert.ok(fitting.text.includes(group));
  assert.equal(text.slice(fitting.start,fitting.end),fitting.text);
  assert.equal(selectPublicPassage("abuse",text,group.length - 1).text,"");
  const independent = " Logging records every request.";
  const selected = selectPublicPassage("Logging",group + independent,independent.length);
  assert.equal(selected.text,independent);
  assert.equal(selected.start,group.length);
});
test("overlapping page chunks restore a qualification across ingestion boundaries", () => {
  const shared = "API access requires authorization for every administrative operation. ";
  const first = doc({text:"Background. " + shared,id:"guide:tech:page:4:1"});
  const second = doc({text:shared + "However, public endpoints are exempt.",id:"guide:tech:page:4:2"});
  const hits = selectPublicHits("API authorization", [{chunk:first,score:9},{chunk:second,score:4}],3,[first,second]);
  assert.equal(hits.length,1);
  assert.match(hits[0].passage.text,/However/);
  assert.equal(hits[0].passage.text.split("requires authorization").length,2);
  assert.equal(hits[0].sourceIds.length,2);
});
test("public reranking rewards requested component coverage rather than repeated single terms", () => {
  const hits = selectPublicHits("authorization logging", [{chunk:doc({text:"Authorization requirements. ".repeat(5)}),score:12},{chunk:doc({id:"other",section:"page:8",text:"Authorization requires a role check. Logging records every request."}),score:10}],1);
  assert.equal(hits[0].chunk.id,"other");
});
test("Korean particles use the same component terms for passage and page coverage", () => {
  const relevant = "승인 조건을 기록한다. 보관 기간은 삼십 일이다.";
  const text = "관련 없는 배경 설명이다. ".repeat(25) + relevant;
  const passage = selectPublicPassage("승인의 조건과 기간을",text,80);
  assert.ok(passage.text.includes(relevant));
  assert.equal(text.slice(passage.start,passage.end),passage.text);
});
test("window choice covers complementary preceding facts instead of filling forward from one unit", () => {
  const preceding = "Retention is thirty days.";
  const anchor = " Authorization and logging require approval.";
  const noise = " Other facts.";
  const text = "Unrelated background. ".repeat(20) + preceding + anchor + noise.repeat(5);
  const passage = selectPublicPassage("retention authorization logging",text,preceding.length + anchor.length + 2);
  assert.ok(passage.text.includes(preceding + anchor));
  assert.equal(text.slice(passage.start,passage.end),passage.text);
});
test("dates and numbered list punctuation cannot produce truncated table fragments", () => {
  for (const prefix of ["2025. 12월 기준 API ","3.2. API ","7. API "]) {
    const statement = prefix + "x".repeat(90) + " remains private until approval.";
    assert.equal(selectPublicPassage("API",statement,statement.length - 3).text,"");
    const text = "Background. ".repeat(20) + statement;
    const passage = selectPublicPassage("API",text,statement.length + 1);
    assert.ok(passage.text.includes(statement));
  }
});
test("explicit list entries stay usable without treating soft wraps or caveat bullets as independent facts", () => {
  const relevant = "○ Retention periods\n - Records are retained for thirty days.\n - However, legal holds suspend deletion.";
  const text = "1.1. Background " + "x".repeat(200) + "\n2.1. More background\n" + relevant;
  const selected = selectPublicPassage("records thirty",text,110);
  assert.match(selected.text,/thirty days/);
  assert.match(selected.text,/legal holds/);
  assert.equal(text.slice(selected.start,selected.end),selected.text);
  const rule = "○ API " + "x".repeat(1170) + " requires approval\n - Only private endpoints need approval, never public endpoints.";
  assert.equal(selectPublicPassage("API",rule).text,"");
});
test("marked footnote conditions without conjunction keywords cannot detach from a rule", () => {
  for (const marker of ["※","*"]) {
    const rule = "API " + "x".repeat(90) + " processing takes five days.";
    const text = rule + "\n" + marker + " 소요기간은 영업일 기준이며 공휴일은 포함하지 않는다.";
    assert.equal(selectPublicPassage("API",text,rule.length + 1).text,"");
    const fitting = selectPublicPassage("API", "Background. ".repeat(20) + text,text.length + 1);
    assert.ok(fitting.text.includes(text));
  }
});
