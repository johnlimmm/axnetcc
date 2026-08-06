# AXNetCC-SAEA

AXNetCC-SAEA keeps the eight existing department agents and their RAG scopes fixed. For every selected role it evaluates `raw`, `sanitized`, `local-summary`, and `metadata-only`, rejects policy or concept-coverage failures, and minimizes the lexicographic tuple `(sensitivity-weighted cross-boundary bytes, predicted end-to-end milliseconds, cross-boundary bytes, local processing milliseconds)`.

Security policy is a hard runtime constraint. Experimental baselines may bypass it only when traces explicitly set both `policyViolation` and `policyBypassForExperiment`; `/api/evidence/plan` never exposes the offline oracle. If no candidate is feasible, the planner returns `infeasible`, `humanReviewRequired`, and a reason instead of silently dropping the role.

Legacy orchestration remains the default (`evidenceStrategy=legacy`, `securityEmulation=false`). An opt-in request can use `evidenceStrategy=axnetcc-saea`, and the separate `POST /api/evidence/plan` keeps role routing separate from acquisition planning.
