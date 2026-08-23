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
