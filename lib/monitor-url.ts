export function monitorUrl(path = "/") {
  const configured = process.env.MONITOR_PUBLIC_URL ?? "http://localhost:3200";
  const url = new URL(configured);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid MONITOR_PUBLIC_URL");
  return new URL(path, url).href;
}
