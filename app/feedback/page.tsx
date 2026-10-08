import WorkspaceNav from "../components/WorkspaceNav";
import FeedbackForm from "../components/FeedbackForm";

export const metadata = { title: "사용자 피드백 | MNC FLOW" };

export default function FeedbackPage() {
  return <main className="aboutPage feedbackPage">
    <header className="topbar"><a className="brand" href="/"><span className="brandMark">M</span><div><strong>MNC FLOW</strong><small>Distributed AI Governance</small></div></a><WorkspaceNav active="feedback" /></header>
    <section className="aboutHero"><span className="eyebrow">USER FEEDBACK</span><h1>더 나은 답변을 위해<br />사용 경험을 들려주세요.</h1><p>도움이 된 점과 개선이 필요한 점을 알려주세요. 남겨주신 의견은 운영자가 확인합니다.</p></section>
    <div className="feedbackSubmission"><FeedbackForm /></div>
  </main>;
}
