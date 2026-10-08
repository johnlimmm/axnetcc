import Link from "next/link";

export default function WorkspaceNav({ active }: { active: "service" | "feedback" }) {
  return <nav className="workspaceNav" aria-label="주요 페이지">
    {[
      ["service", "/", "응답 서비스"], ["feedback", "/feedback", "사용자 피드백"],
    ].map(([id, href, label]) => <Link key={id} href={href} aria-current={active === id ? "page" : undefined}>{label}</Link>)}
  </nav>;
}
