import { distributedAttemptsCsv, distributedCallsCsv } from "./distributed.mjs";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { openMonitorStore } from "./store.mjs";
import { createCollector } from "./collector.mjs";
import { createNetworkSampler, parseNetworkTargets } from "./network.mjs";
import { readCampaign } from "./campaign.mjs";
import { readExecutionLogs } from "./execution-logs.mjs";
import { implementation, readBenchmarks, readRoutingBenchmark } from "./data.mjs";
import { fileFeedbackStore } from "../lib/feedback-store.ts";
import { summarizeFeedback } from "../lib/feedback.ts";
import { digest, verifyReport } from "../scripts/evaluate-grounded-completion.mjs";

const windows = { "15m": 900_000, "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 };
const modes = new Set(["all", "proposed", "managed", "parallel", "centralized", "masrouter", "remoterag"]);
const backends = new Set(["all", "ollama", "deterministic"]);

/** Read only operator-configured immutable artifacts. Never return free-form source fields. */
export function readCompletionEvidence(reportPath, gradesPath) {
  const pending = { status: "pending", bindingVerified: false, fullCompletionProven: false, remainingGates: { D: "unproven", M: "unproven", U: "unproven", V: "unproven" } };
  if (!reportPath && !gradesPath) return pending;
  try {
    if (!reportPath || !isAbsolute(reportPath) || (gradesPath && !isAbsolute(gradesPath))) throw new Error("Invalid local artifact configuration");
    const files = new Map();
    const readBounded = (path, maximum) => {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > maximum) throw new Error("Artifact limit");
      const bytes = readFileSync(path);
      if (bytes.length > maximum) throw new Error("Artifact limit");
      files.set(path, digest(bytes));
      return bytes;
    };
    const reportBytes = readBounded(reportPath, 1_000_000), report = JSON.parse(reportBytes);
    if (report.manifestFile !== "manifest.json" || !["samples.jsonl", "samples-final.jsonl"].includes(report.samplesFile)) throw new Error("Artifact layout");
    const directory = dirname(reportPath);
    const manifestBytes = readBounded(resolve(directory, "manifest.json"), 4_000_000);
    const manifest = JSON.parse(manifestBytes);
    const samplesBytes = readBounded(resolve(directory, report.samplesFile), 64_000_000);
    if (report.samplesFile === "samples-final.jsonl") readBounded(resolve(directory, "samples.jsonl"), 64_000_000);
    const gradesBytes = gradesPath ? readBounded(gradesPath, 8_000_000) : null;
    const verified = verifyReport(reportPath, gradesPath);
    // Fail closed if the configured files changed during validation. Do not cache a prior PASS.
    for (const [path, hash] of files) if (digest(readFileSync(path)) !== hash) throw new Error("Artifact changed");
    if (report.startedWithFrozenConfiguration && report.startedWithFrozenConfiguration !== manifest.configurationHash) throw new Error("Configuration binding");
    const reviewed = verified.semanticReview === "AI-assisted";
    const gate = key => !reviewed && key !== "P1" ? "pending" : verified.complete && verified.reportValid && verified.gates[key] ? "passed" : "failed";
    const samples = samplesBytes.toString().trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const primary = manifest.cases.filter(c => c.kind === "answerable").map(c => samples.find(s => s.caseId === c.id && s.occurrence === 1));
    const final = s => s?.status === "completed" && s.hasFinal === true && s.elapsedMs <= 60000 && s.transcriptComplete === true;
    return {
      ...pending, schemaVersion: "monitor-completion-evidence/v1", status: verified.passed ? "passed" : !reviewed && verified.complete && verified.reportValid ? "pending" : "failed",
      bindingVerified: true, semanticReview: reviewed ? "AI-assisted" : "pending", reportValid: verified.reportValid,
      cohortOnly: true, complete: verified.complete, planned: 50, admitted: verified.admitted, concurrency: 3,
      deploymentId: manifest.deploymentId, frozenAt: new Date(manifest.frozenAt).toISOString(), readiness: manifest.readiness.policy,
      gates: Object.fromEntries(["Q1", "Q2", "Q3", "P1"].map(key => [key, gate(key)])),
      quality: { answerablePassed: reviewed ? verified.answerablePassed : null, primaryDenominator: 40, safetyPassed: reviewed ? verified.safetyPassed : null, safetyDenominator: 10 },
      roleScores: Object.fromEntries(Object.entries(verified.roleScores).map(([role, score]) => [role, { passed: reviewed ? score.passed : null, denominator: 5 }])),
      latency: { denominator: 40, allTerminalP95Ms: verified.allTerminalP95Ms, finalResponseP95Ms: verified.finalResponseP95Ms,
        terminalObserved: primary.filter(s => s && ["completed", "partial_failed", "failed", "cancelled"].includes(s.status)).length,
        censoredFinalCount: primary.filter(s => !final(s)).length, estimator: "nearest-rank; no-final/deadline = Infinity" },
      renderingConfiguration: { edge: verified.renderingConfiguration.edge, core: verified.renderingConfiguration.core },
      renderingProvenance: "frozen-configuration-not-per-call-observation",
      outcomes: { ...verified.outcomes, useful: reviewed ? verified.outcomes.useful : null },
      hashes: { report: digest(reportBytes), manifest: digest(manifestBytes), samples: digest(samplesBytes), grades: gradesBytes ? digest(gradesBytes) : null,
        configuration: manifest.configurationHash, workload: manifest.workloadHash, rubrics: manifest.rubricHash },
      artifacts: manifest.artifacts.map(({ kind, sha256 }) => ({ kind, sha256 })),
    };
  } catch { return { ...pending, status: "invalid", error: "COMPLETION_EVIDENCE_INVALID" }; }
}

export async function startMonitor(options = {}) {
  const serviceUrl = options.serviceUrl ?? process.env.MONITOR_SERVICE_URL ?? "http://127.0.0.1:3100";
  const intervalMs = Math.max(1000, Number(options.intervalMs ?? process.env.MONITOR_INTERVAL_MS ?? 5000));
  const retentionDays = Math.min(365, Math.max(1, Number(process.env.MONITOR_RETENTION_DAYS ?? 30)));
  if (!Number.isFinite(intervalMs) || !Number.isFinite(retentionDays)) throw new Error("INVALID_MONITOR_CONFIGURATION");
  const filename = options.database ?? resolve(process.env.MONITOR_DATABASE ?? ".local-monitor/telemetry.sqlite");
  if (filename !== ":memory:") await mkdir(dirname(filename), { recursive: true });
  const store = openMonitorStore(filename);
  const collector = createCollector({ store, serviceUrl, intervalMs, retentionDays, token: process.env.MONITOR_SCRAPE_TOKEN ?? "", fetchImpl: options.fetchImpl });
  const startedAt = Date.now();
  const feedbackStore = options.feedbackStore ?? fileFeedbackStore(process.env.MONITOR_FEEDBACK_DIRECTORY ?? process.env.FEEDBACK_DIRECTORY);
  const network = createNetworkSampler(options.networkTargets ?? parseNetworkTargets(process.env.MONITOR_NETWORK_TARGETS ?? "[]"));
  const completionReport = options.completionReport ?? process.env.MONITOR_COMPLETION_REPORT;
  const completionGrades = options.completionGrades ?? process.env.MONITOR_COMPLETION_GRADES;
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const send = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value)); };
    if (request.method !== "GET") { response.setHeader("allow", "GET"); send({ error: "METHOD_NOT_ALLOWED" }, 405); return; }
    try {
      const url = new URL(request.url, "http://monitor.local");
      if (url.pathname === "/api/completion" || url.pathname === "/api/completion/report.json") {
        if (url.search) { send({ error: "UNSUPPORTED_QUERY" }, 400); return; }
        const evidence = readCompletionEvidence(completionReport, completionGrades);
        if (url.pathname.endsWith("report.json")) {
          if (!evidence.bindingVerified) { send({ error: "COMPLETION_EVIDENCE_UNAVAILABLE" }, 404); return; }
          response.setHeader("content-disposition", 'attachment; filename="completion-evidence-sanitized.json"');
        }
        send(evidence); return;
      }
      if (url.pathname === "/api/feedback") {
        try { send(summarizeFeedback(await feedbackStore.list())); }
        catch { send({ error: "FEEDBACK_STORAGE_UNAVAILABLE" }, 503); }
        return;
      }
      if (url.pathname === "/api/summary" || url.pathname === "/api/export.csv" || url.pathname === "/api/attempts.csv" || url.pathname === "/api/calls.csv") {
        const window = url.searchParams.get("window") ?? "1h", mode = url.searchParams.get("mode") ?? "all", backend = url.searchParams.get("backend") ?? "all";
        if (!Object.hasOwn(windows, window) || !modes.has(mode) || !backends.has(backend)) { send({ error: "INVALID_FILTER" }, 400); return; }
        const now = Date.now();
        const summary = store.summary({ from: now - windows[window], to: now, mode, backend });
        if (url.pathname === "/api/calls.csv") {
          response.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="mnc-distributed-calls.csv"' });
          response.end(distributedCallsCsv(summary.runs)); return;
        }
        if (url.pathname === "/api/attempts.csv") {
          response.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="mnc-distributed-attempts.csv"' });
          response.end(distributedAttemptsCsv(summary.runs)); return;
        }
        if (url.pathname === "/api/export.csv") {
          const { metricsCsv } = await import("../lib/metrics-csv.ts");
          const rows = [["instance_id", "run_id", "status", "mode", "backend", "completed_at", "e2e_ms", "ttft_ms", "tpot_ms", "queue_wait_ms", "inference_ms", "tokens", "boundary_bytes"]];
          for (const run of summary.runs) rows.push([run.instanceId, run.runId, run.status, run.mode, run.backend, run.completedAt ? new Date(run.completedAt).toISOString() : null, run.metrics.latencyMs, run.metrics.ttftMs, run.metrics.tpotMs, run.metrics.queueWaitMs, run.metrics.inferenceMs, run.metrics.tokens, run.metrics.boundaryBytes]);
          response.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="mnc-monitor-runs.csv"' }); response.end(metricsCsv(rows)); return;
        }
        send({ ...summary, config: { serviceUrl, intervalMs, retentionDays, startedAt }, implementation }); return;
      }
      if (url.pathname === "/api/run") { const run = store.findRun(url.searchParams.get("instance") ?? "", url.searchParams.get("run") ?? ""); send(run ?? { error: "RUN_NOT_FOUND" }, run ? 200 : 404); return; }
      if (url.pathname === "/api/network") { send(network.snapshot()); return; }
      if (url.pathname === "/api/campaign") { send(readCampaign(options.campaignReport ?? process.env.MONITOR_CAMPAIGN_REPORT)); return; }
      if (url.pathname === "/api/execution-logs") { send(readExecutionLogs(options.executionLogs ?? process.env.MONITOR_EXECUTION_LOGS)); return; }
      if (url.pathname === "/api/longitudinal") {
        try { send(JSON.parse(await readFile(new URL('../reports/local-evaluation/summary.json', import.meta.url), 'utf8'))); }
        catch { send({ status: 'not-started', rows: [] }); }
        return;
      }
      if (url.pathname === "/api/routing-benchmark") { send(await readRoutingBenchmark()); return; }
      if (url.pathname === "/api/benchmarks") { send(await readBenchmarks()); return; }
      const assets = { "/evaluation": ["index.html", "text/html"], "/lab-template-strip.png": ["lab-template-strip.png", "image/png"], "/distributed": ["index.html", "text/html"], "/feedback.css": ["feedback.css", "text/css"], "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"], "/": ["index.html", "text/html"], "/runs": ["index.html", "text/html"], "/implementation": ["index.html", "text/html"], "/benchmarks": ["index.html", "text/html"], "/feedback": ["index.html", "text/html"] };
      if (!Object.hasOwn(assets, url.pathname)) { send({ error: "NOT_FOUND" }, 404); return; }
      const [file, type] = assets[url.pathname];
      const content = await readFile(new URL(`./public/${file}`, import.meta.url));
      response.writeHead(200, { "content-type": `${type}; charset=utf-8` }); response.end(content);
    } catch { if (!response.headersSent) send({ error: "MONITOR_READ_FAILED" }, 500); else response.end(); }
  });
  const port = Number(options.port ?? process.env.MONITOR_PORT ?? 3200);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  collector.start();
  network.start();
  return { server, store, collector, network, url: `http://127.0.0.1:${server.address().port}`, async stop() { await network.stop(); await collector.stop(); await new Promise(resolve => server.close(resolve)); store.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const monitor = await startMonitor();
  console.log(`MNC Monitor: ${monitor.url} | background collector active`);
  for (const event of ["SIGINT", "SIGTERM"]) process.once(event, async () => { await monitor.stop(); process.exit(0); });
}
