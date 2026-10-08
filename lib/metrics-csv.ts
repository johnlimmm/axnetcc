export function metricsCsv(rows: Array<Array<string | number | null | undefined>>): string {
  return "\uFEFF" + rows.map((row) => row.map((value) => {
    let cell = value == null ? "" : String(value);
    if (typeof value === "string" && /^\s*[=+@-]/.test(cell)) cell = `'${cell}`;
    return `"${cell.replaceAll('"', '""')}"`;
  }).join(",")).join("\r\n");
}
