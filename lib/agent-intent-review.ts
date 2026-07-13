export type ReviewedAgentIntent = {
  intentMode?: 'launch' | 'share' | null;
  intentTarget?: string | null;
  intentShareText?: string | null;
};

export type FireAgentIntent = (
  mode: 'launch' | 'share',
  target: string,
  shareText?: string | null,
) => Promise<void>;

/** Fires the native side effect only from the human Review accept path. */
export async function fireReviewedAgentIntent(
  request: ReviewedAgentIntent,
  fireAgentIntent: FireAgentIntent,
): Promise<void> {
  await fireAgentIntent(
    request.intentMode ?? 'launch',
    request.intentTarget ?? '',
    request.intentShareText ?? null,
  );
}
