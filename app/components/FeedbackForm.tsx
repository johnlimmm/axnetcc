"use client";

import { useRef, useState } from "react";
import { feedbackCategories, type FeedbackInput } from "../../lib/feedback";

export default function FeedbackForm({ runId = null, onSaved }: { runId?: string | null; onSaved?: () => void }) {
  const [rating, setRating] = useState(0);
  const [categories, setCategories] = useState<FeedbackInput["categories"]>([]);
  const [comment, setComment] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [savedId, setSavedId] = useState("");
  const receipt = useRef<FeedbackInput | null>(null);
  const submitting = useRef(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!rating || submitting.current) return;
    submitting.current = true;
    setState("saving");
    // Freeze the payload after the first attempt so uncertain network retries cannot duplicate votes.
    receipt.current ??= { id: crypto.randomUUID(), runId, rating, categories, comment };
    try {
      const response = await fetch("/api/feedback", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(receipt.current), signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok || !(await response.json()).saved) throw new Error("save failed");
      setSavedId(receipt.current.id);
      setState("saved");
      onSaved?.();
    } catch { setState("error"); }
    finally { submitting.current = false; }
  }

  return <section className="feedbackCard" aria-labelledby="feedback-title">
    <div className="feedbackHeading"><span>USER FEEDBACK</span><h2 id="feedback-title">{runId ? "이 응답이 도움이 되었나요?" : "사용 경험을 들려주세요"}</h2><p>{runId ? "이 응답에 대한 평가와 개선 의견을 남겨 주세요." : "답변 품질과 화면 사용 경험을 개선하는 데 참고합니다."}</p></div>
    {state === "saved" ? <div className="feedbackSuccess" role="status"><strong>피드백이 저장되었습니다. 감사합니다.</strong><p>접수 번호: {savedId}</p><p>남겨주신 의견은 운영자가 확인하고 서비스 개선에 참고합니다.</p></div> : <form onSubmit={submit}>
      <fieldset disabled={state === "saving" || state === "error"}>
        <legend>만족도 <span>(필수)</span></legend>
        <div className="ratingChoices">{[1, 2, 3, 4, 5].map((value) => <label key={value} className={rating === value ? "selected" : ""}><input type="radio" name="rating" value={value} checked={rating === value} onChange={() => setRating(value)} required /><span>{value}점</span></label>)}</div>
        <small>1점: 전혀 도움 안 됨 · 5점: 매우 도움 됨</small>
      </fieldset>
      <fieldset disabled={state === "saving" || state === "error"}>
        <legend>개선이 필요한 부분 <span>(선택)</span></legend>
        <div className="feedbackCategories">{Object.entries(feedbackCategories).map(([key, label]) => <label key={key}><input type="checkbox" checked={categories.includes(key as FeedbackInput["categories"][number])} onChange={(event) => setCategories((current) => event.target.checked ? [...current, key as FeedbackInput["categories"][number]] : current.filter((item) => item !== key))} />{label}</label>)}</div>
      </fieldset>
      <label className="feedbackComment">의견 <span>(선택 · {comment.length}/2000)</span><textarea value={comment} maxLength={2000} disabled={state === "saving" || state === "error"} onChange={(event) => setComment(event.target.value)} placeholder="어떤 점이 유용했거나 불편했는지 알려주세요." /></label>
      <p className="feedbackNotice">의견은 운영자가 확인합니다. 개인정보·내부 자료는 입력하지 마세요. 요청 원문과 응답 본문은 함께 저장하지 않습니다.</p>
      {state === "error" && <p className="feedbackError" role="alert">저장 여부를 확인하지 못했습니다. 입력한 내용은 유지됩니다. 같은 내용으로 다시 제출해 주세요.</p>}
      <button className="workspaceButton" type="submit" disabled={!rating || state === "saving"}>{state === "saving" ? "저장 중…" : state === "error" ? "다시 제출" : "피드백 보내기"}</button>
    </form>}
  </section>;
}
