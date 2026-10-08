import { handleFeedbackRequest } from "../../../lib/feedback";
import { fileFeedbackStore } from "../../../lib/feedback-store";

export const dynamic = "force-dynamic";
// Cloudflare requests are handled by the Worker with its persistent D1 binding.
export const GET = (request: Request) => handleFeedbackRequest(request, fileFeedbackStore());
export const POST = GET;
