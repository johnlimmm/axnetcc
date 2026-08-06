import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const supplied = process.argv.slice(2).find((argument) => argument !== "--");
if (!supplied) throw new Error("Pass the completed security-evidence run directory.");
const directory = pathToFileURL(`${path.resolve(supplied)}${path.sep}`);
const config = JSON.parse(await readFile(new URL("experiment-config.json", directory), "utf8"));
const traces = (await readFile(new URL("raw-traces.jsonl", directory), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
const failedGroups = new Map();

for (const trace of traces.filter((row) => row.httpStatus === 599)) {
  const phase = (config.ablations ?? []).includes(trace.method) ? "ablation" : "primary";
  const key = [phase, trace.queryId, trace.method, trace.scenario, trace.profileSeed, trace.repetition].join(":");
  const group = failedGroups.get(key) ?? [];
  group.push({ traceId: trace.traceId, role: trace.ownerDepartment, elapsedMs: trace.elapsedMs, retries: trace.retries });
  failedGroups.set(key, group);
}

if (!failedGroups.size) {
  console.log("No status-599 jobs require recovery.");
  process.exit(0);
}

const completedUrl = new URL("completed-jobs.jsonl", directory);
const backupUrl = new URL("completed-jobs.pre-transport-recovery.jsonl", directory);
const completedText = await readFile(completedUrl, "utf8");
try { await copyFile(completedUrl, backupUrl, 1); } catch (error) { if (error.code !== "EEXIST") throw error; }
const completed = completedText.trim().split(/\r?\n/).filter(Boolean);
const retained = completed.filter((key) => !failedGroups.has(key));
if (completed.length - retained.length !== failedGroups.size) throw new Error("Transport-recovery job keys did not match the completed-job journal exactly.");
await writeFile(completedUrl, `${retained.join("\n")}\n`);
await writeFile(new URL("TRANSPORT_RECOVERY_AUDIT.json", directory), JSON.stringify({
  status: "pending-rerun",
  criterion: "job contains at least one final HTTP status 599 after retries",
  removedCompletedJobKeys: [...failedGroups.keys()],
  affectedTraces: Object.fromEntries(failedGroups),
  originalCompletedJobCount: completed.length,
  retainedCompletedJobCount: retained.length,
  backup: "completed-jobs.pre-transport-recovery.jsonl",
  generatedAt: new Date().toISOString(),
}, null, 2));
console.log(JSON.stringify({ jobsPreparedForRerun: failedGroups.size, retainedCompletedJobs: retained.length }, null, 2));
