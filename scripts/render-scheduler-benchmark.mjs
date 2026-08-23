import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const reportPath = resolve("reports", "scheduler-benchmark-v1.json");
const outputPath = resolve("reports", "scheduler-benchmark-v1.svg");
const report = JSON.parse(await readFile(reportPath, "utf8"));
const bursts = report.configuration.bursts;
const rows = (policy) => bursts.map((burst) =>
  report.scenarios.find((row) => row.burst === burst && row.policy === policy));
const fifo = rows("fifo");
const priority = rows("priority");

const width = 1200;
const height = 820;
const colors = { fifo: "#6B7280", priority: "#4C72B0", accent: "#DD8452", ink: "#172033", muted: "#68738A" };

function escape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
  })[character]);
}

function groupedChart({ x, y, w, h, title, unit, baseline, improved, decimals = 0 }) {
  const top = y + 46;
  const bottom = y + h - 52;
  const plotHeight = bottom - top;
  const maximum = Math.max(...baseline, ...improved, 1) * 1.16;
  const groupWidth = w / baseline.length;
  const barWidth = Math.min(58, groupWidth * 0.25);
  const elements = [
    `<text x="${x}" y="${y + 22}" class="chart-title">${escape(title)}</text>`,
    `<text x="${x}" y="${y + 39}" class="chart-unit">${escape(unit)}</text>`,
    `<line x1="${x}" y1="${bottom}" x2="${x + w}" y2="${bottom}" class="axis"/>`,
  ];
  baseline.forEach((value, index) => {
    const center = x + groupWidth * (index + 0.5);
    const baseHeight = value / maximum * plotHeight;
    const improvedHeight = improved[index] / maximum * plotHeight;
    elements.push(
      `<rect x="${center - barWidth - 3}" y="${bottom - baseHeight}" width="${barWidth}" height="${baseHeight}" fill="url(#fifoPattern)" stroke="${colors.fifo}"/>`,
      `<rect x="${center + 3}" y="${bottom - improvedHeight}" width="${barWidth}" height="${improvedHeight}" fill="${colors.priority}"/>`,
      `<text x="${center - barWidth / 2 - 3}" y="${bottom - baseHeight - 8}" class="value">${value.toFixed(decimals)}</text>`,
      `<text x="${center + barWidth / 2 + 3}" y="${bottom - improvedHeight - 8}" class="value priority">${improved[index].toFixed(decimals)}</text>`,
      `<text x="${center}" y="${bottom + 25}" class="category">Burst ${bursts[index]}</text>`,
    );
  });
  return elements.join("\n");
}

function singleChart({ x, y, w, h, title, unit, values }) {
  const top = y + 46;
  const bottom = y + h - 52;
  const plotHeight = bottom - top;
  const maximum = Math.max(...values, 1) * 1.16;
  const groupWidth = w / values.length;
  const barWidth = Math.min(86, groupWidth * 0.38);
  const elements = [
    `<text x="${x}" y="${y + 22}" class="chart-title">${escape(title)}</text>`,
    `<text x="${x}" y="${y + 39}" class="chart-unit">${escape(unit)}</text>`,
    `<line x1="${x}" y1="${bottom}" x2="${x + w}" y2="${bottom}" class="axis"/>`,
  ];
  values.forEach((value, index) => {
    const center = x + groupWidth * (index + 0.5);
    const barHeight = value / maximum * plotHeight;
    elements.push(
      `<rect x="${center - barWidth / 2}" y="${bottom - barHeight}" width="${barWidth}" height="${barHeight}" fill="${colors.accent}"/>`,
      `<text x="${center}" y="${bottom - barHeight - 8}" class="value">${value}</text>`,
      `<text x="${center}" y="${bottom + 25}" class="category">Burst ${bursts[index]}</text>`,
    );
  });
  return elements.join("\n");
}

const best = Math.max(...report.comparisons.map((row) => row.completionReadyP50ImprovementPercent));
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Completion-aware scheduling cuts ready-request p50 by up to ${best.toFixed(1)} percent</title>
  <desc id="desc">Four grouped bar charts compare FIFO and last-task plus aging policies for burst 10 and burst 50 deterministic mock workloads. Ready-request completion improves while throughput is unchanged.</desc>
  <defs>
    <pattern id="fifoPattern" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="8" height="8" fill="#EEF0F4"/><line x1="0" y1="0" x2="0" y2="8" stroke="${colors.fifo}" stroke-width="3"/>
    </pattern>
    <style>
      text { font-family: Inter, "Segoe UI", Arial, sans-serif; fill: ${colors.ink}; }
      .headline { font-size: 27px; font-weight: 800; }
      .subtitle { font-size: 13px; fill: ${colors.muted}; }
      .chart-title { font-size: 16px; font-weight: 750; }
      .chart-unit { font-size: 11px; fill: ${colors.muted}; }
      .value { font-size: 12px; text-anchor: middle; font-weight: 700; fill: ${colors.fifo}; }
      .value.priority { fill: ${colors.priority}; }
      .category { font-size: 12px; text-anchor: middle; fill: ${colors.muted}; }
      .axis { stroke: #CBD1DC; stroke-width: 1; }
      .legend { font-size: 12px; fill: ${colors.muted}; }
      .footnote { font-size: 10px; fill: ${colors.muted}; }
      .panel { fill: #FFFFFF; stroke: #E1E5EC; rx: 10; }
    </style>
  </defs>
  <rect width="1200" height="820" fill="#F7F8FB"/>
  <text x="54" y="54" class="headline">Completion-aware scheduling cuts ready-request p50 by up to ${best.toFixed(1)}%</text>
  <text x="54" y="80" class="subtitle">Deterministic mock workload · 1/3/8-Agent requests · two endpoints · capacity 1</text>
  <g transform="translate(800,50)">
    <rect x="0" y="-13" width="20" height="12" fill="url(#fifoPattern)" stroke="${colors.fifo}"/><text x="29" y="-2" class="legend">FIFO baseline</text>
    <rect x="145" y="-13" width="20" height="12" fill="${colors.priority}"/><text x="174" y="-2" class="legend">Last-task + aging</text>
  </g>
  <rect x="38" y="108" width="548" height="300" class="panel"/>
  <rect x="614" y="108" width="548" height="300" class="panel"/>
  <rect x="38" y="430" width="548" height="300" class="panel"/>
  <rect x="614" y="430" width="548" height="300" class="panel"/>
  ${groupedChart({ x: 64, y: 126, w: 496, h: 260, title: "Completion-ready request p50", unit: "Virtual milliseconds · lower is better", baseline: fifo.map((row) => row.completionReadyRequestMs.p50), improved: priority.map((row) => row.completionReadyRequestMs.p50) })}
  ${groupedChart({ x: 640, y: 126, w: 496, h: 260, title: "Task queue wait p95", unit: "Virtual milliseconds · fairness trade-off", baseline: fifo.map((row) => row.queueWaitMs.p95), improved: priority.map((row) => row.queueWaitMs.p95) })}
  ${groupedChart({ x: 64, y: 448, w: 496, h: 260, title: "Throughput is preserved", unit: "Requests per virtual second · higher is better", baseline: fifo.map((row) => row.throughputRequestsPerSecond), improved: priority.map((row) => row.throughputRequestsPerSecond), decimals: 1 })}
  ${singleChart({ x: 640, y: 448, w: 496, h: 260, title: "Priority decisions actually applied", unit: "Last-task dispatch count", values: priority.map((row) => row.lastTaskPromotions) })}
  <text x="54" y="779" class="footnote">Source: ${escape(report.reportVersion)} · seed ${report.configuration.seed} · ${escape(report.generatedAt)} · JSON table accompanies this chart</text>
</svg>`;

await writeFile(outputPath, svg, "utf8");
console.log(outputPath);
