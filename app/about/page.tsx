import { redirect } from "next/navigation";
import { monitorUrl } from "../../lib/monitor-url";

export default function ImplementationRedirect() {
  redirect(monitorUrl("/implementation"));
}
