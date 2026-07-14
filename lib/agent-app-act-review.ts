export type ReviewedAgentAppAct = {
  appActRecipeId?: string | null;
  /** JSON-encoded Record<string, string> — already {{result}}-resolved and
   *  redacted by the executor (write_action_approval_request /
   *  requestActionApproval) before this request ever reached RN. */
  appActParamsResolved?: string | null;
};

export type FireAgentAppAct = (
  recipeId: string,
  params: Record<string, string>,
) => Promise<void>;

/** Parses the JSON-encoded resolved params carried on the approval request.
 *  Returns {} (never throws) on malformed/absent JSON — fireReviewedAgentAppAct
 *  then calls fireAgentAppAct with an empty param map, which the native side
 *  and/or the recipe's own required-param check fails closed on, rather than
 *  this helper silently swallowing a parse failure into "nothing to post". */
export function parseAppActParamsResolved(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch (_e) {
    return {};
  }
}

/** Fires the native side effect only from the human Review accept path
 *  (mirrors lib/agent-intent-review.ts's fireReviewedAgentIntent exactly). */
export async function fireReviewedAgentAppAct(
  request: ReviewedAgentAppAct,
  fireAgentAppAct: FireAgentAppAct,
): Promise<void> {
  const recipeId = (request.appActRecipeId ?? '').trim();
  const params = parseAppActParamsResolved(request.appActParamsResolved);
  await fireAgentAppAct(recipeId, params);
}
