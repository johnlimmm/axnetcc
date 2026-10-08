import { redirect } from "next/navigation";
import { monitorUrl } from "../../lib/monitor-url";

export default async function EvaluationRedirect({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const { run } = await searchParams;
  const validRun = typeof run === "string" && /^RUN-[A-Za-z0-9-]{3,64}$/.test(run);
  redirect(monitorUrl(validRun
    ? `/evaluation?run=${encodeURIComponent(run)}`
    : "/evaluation"));
}
