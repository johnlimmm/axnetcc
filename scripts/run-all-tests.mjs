import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const testDirectory = resolve("tests");
const testFiles = readdirSync(testDirectory)
  .filter((file) => file.endsWith(".test.mjs"))
  .sort()
  .map((file) => resolve(testDirectory, file));
const repeatCount = Math.max(1, Number.parseInt(process.env.TEST_REPEAT_COUNT ?? "1", 10) || 1);

if (!testFiles.length) {
  throw new Error("No tests/*.test.mjs files were found.");
}

for (let run = 1; run <= repeatCount; run += 1) {
  console.log(`\nComplete test pass ${run}/${repeatCount} (${testFiles.length} files)`);
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--test", "--test-concurrency=1", ...testFiles],
    { stdio: "inherit", env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
