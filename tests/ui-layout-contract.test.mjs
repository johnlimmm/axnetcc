import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const globalsUrl = new URL("../app/globals.css", import.meta.url);
const publicUrl = new URL("../public/site.css", import.meta.url);

test("the shared typography token raises every declared font size by 4pt", async () => {
  const css = await readFile(globalsUrl, "utf8");
  const declarations = css.match(/font-size:\s*[^;]+/g) ?? [];

  assert.match(css, /--type-bump:\s*4pt/);
  assert.ok(declarations.length > 250, "expected the complete application type scale");
  assert.ok(
    declarations.every((declaration) => declaration.includes("var(--type-bump)")),
    "every explicit font size must use the shared 4pt type bump",
  );
});

test("result report grids shrink and wrap without escaping the page shell", async () => {
  const css = await readFile(globalsUrl, "utf8");

  assert.match(css, /--focus-shell-max:\s*1360px/);
  assert.match(css, /\.focusShell\s*\{[^}]*width:\s*min\(var\(--focus-shell-max\),\s*100%\)/);
  assert.doesNotMatch(css, /(^|\n)footer\s*\{/);
  assert.match(css, /\.aboutPage\s*>\s*footer\s*\{/);
  assert.match(css, /\.reportSections\s*\{[^}]*min-width:\s*0[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.reportSections footer\s*\{[^}]*padding:\s*12px 0 0/);
  assert.match(css, /\.resultEvidenceBody\s*\{[^}]*min-width:\s*0[^}]*minmax\(0,\s*\.9fr\)[^}]*minmax\(0,\s*1\.1fr\)/);
  assert.match(css, /\.agentPathFlow\s*\{[^}]*min-width:\s*0[^}]*minmax\(0,\s*\.78fr\)/);
  assert.match(css, /@media \(max-width:\s*1100px\)[\s\S]*?\.agentPathFlow\s*\{[^}]*grid-template-columns:\s*1fr/);
  assert.match(css, /\.reportSections p\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.evidenceList article > p\s*\{[^}]*overflow-wrap:\s*anywhere/);
});

test("the generated public stylesheet stays synchronized", async () => {
  const [globals, publicCss] = await Promise.all([
    readFile(globalsUrl, "utf8"),
    readFile(publicUrl, "utf8"),
  ]);

  assert.equal(publicCss, globals);
});

test("service header does not treat configured Agent endpoints as proven availability", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const header = source.slice(source.indexOf("function AppHeader"), source.indexOf("function CitationChips"));
  assert.doesNotMatch(header, /health\.connected|health\.status/);
  assert.match(header, /health\.total/);
});

test("distributed monitor uses responsive cards and readable adopted-attempt colors", async () => {
  const css = await readFile(new URL("../monitor/public/style.css", import.meta.url), "utf8");
  assert.match(css, /metricGrid\s*\{[^}]*display:\s*grid;[^}]*repeat\(4,/);
  assert.match(css, /max-width:\s*1200px[^}]*metricGrid[^}]*repeat\(2,/);
  assert.match(css, /max-width:\s*600px[^}]*metricGrid[^}]*minmax\(0,\s*1fr\)/);
  const luminance = hex => {
    const channels = hex.match(/.{2}/g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const background = /\.adoptedAttempt\s*\{[^}]*background:\s*#([a-f0-9]{6})/.exec(css)[1];
  for (const pattern of [/\.adoptedAttempt td\s*\{[^}]*color:\s*#([a-f0-9]{6})/, /\.adoptedAttempt td small\s*\{[^}]*color:\s*#([a-f0-9]{6})/]) {
    const foreground = pattern.exec(css)[1];
    const light = Math.max(luminance(foreground), luminance(background));
    const dark = Math.min(luminance(foreground), luminance(background));
    assert.ok((light + .05) / (dark + .05) >= 4.5);
  }
});

test("first service example exactly matches the approved fixed public demo workload", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const fixtures = JSON.parse(await readFile(new URL("../data/evaluation/distributed-demo-fixtures.json", import.meta.url), "utf8"));
  const first = /const exampleRequests = \[\s*"([^"\n]+)"/.exec(source);
  assert.equal(first?.[1], fixtures.fixtures[0].query);
});
