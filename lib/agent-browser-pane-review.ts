/**
 * lib/agent-browser-pane-review.ts — the RN-side "fire" step for the
 * `browser-pane` agent action, mirroring lib/agent-intent-review.ts and
 * lib/agent-app-act-review.ts's thin, testable wrapper pattern: the actual
 * side effect (injecting a closed click/fill/extractText script into a live
 * WebView) only ever happens from the human Review-accept path in
 * app/_layout.tsx, BEFORE the accept reply is written back to the waiting
 * executor — same "fire-then-reply" invariant every other RN-fired action
 * type (intent/dm-reply/app-act) already follows.
 *
 * This module intentionally does NOT touch lib/browser-pane-automation.ts.
 * It only builds a BrowserPaneActionRequest from the approval request's own
 * (already-reviewed) fields and hands it to executeBrowserPaneAction, whose
 * own approval-grant check, URL-allowlist check (both before dispatch here
 * AND again inside the injected script after navigation), closed action-kind
 * union, and JSON.stringify-only templating are the ONLY gates that matter —
 * nothing here loosens any of them.
 */
import type {
  BrowserPaneAction,
  BrowserPaneActionRequest,
  BrowserPaneActionResult,
} from './browser-pane-automation';

export type BrowserPaneSlot = { id: string; tab: string };

export type ReviewedAgentBrowserPaneAction = {
  browserPaneActionKind?: 'click' | 'fill' | 'extractText' | null;
  browserPaneSelector?: string | null;
  browserPaneValue?: string | null;
  /** JSON-encoded string[] — the wire shape the approval request carries
   *  (mirrors appActParamsResolved's JSON-string convention). */
  browserPaneUrlAllowlist?: string | null;
};

export type ExecuteBrowserPaneAction = (
  paneId: string,
  request: BrowserPaneActionRequest,
) => Promise<BrowserPaneActionResult>;

/**
 * Resolves WHICH Browser Pane receives the action. Deliberately the EXACT
 * same algorithm as components/panes/BrowserPane.tsx's own (unexported)
 * isOpenSignalTargetPane, re-implemented here as a pure function (over
 * caller-supplied slot/focus state, not live Zustand reads) so it is
 * independently unit-testable and has no import-cycle risk with the
 * component file:
 *   1. Zero Browser Panes mounted -> null (fail-closed: nothing to act on).
 *   2. If the focused pane is a Browser Pane, it is the target.
 *   3. Otherwise, the first Browser Pane in slot order is the target.
 * A caller getting `null` back MUST refuse the action (decline the pending
 * approval) rather than guess a pane id — there is no author-time pane id to
 * fall back to (see AgentAction.browserPaneAction's doc comment).
 */
export function resolveTargetBrowserPaneId(
  slots: ReadonlyArray<BrowserPaneSlot | null | undefined>,
  focusedPaneId: string | null | undefined,
): string | null {
  const browserSlotIds: string[] = [];
  for (const slot of slots) {
    if (slot && slot.tab === 'browser') browserSlotIds.push(slot.id);
  }
  if (browserSlotIds.length === 0) return null;
  if (focusedPaneId && browserSlotIds.includes(focusedPaneId)) return focusedPaneId;
  return browserSlotIds[0];
}

function parseUrlAllowlist(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  } catch {
    return [];
  }
}

function buildBrowserPaneAction(request: ReviewedAgentBrowserPaneAction): BrowserPaneAction {
  const kind = request.browserPaneActionKind;
  const selector = request.browserPaneSelector ?? '';
  if (!selector) throw new Error('Browser-pane action is missing a selector.');
  switch (kind) {
    case 'click':
      return { kind: 'click', selector };
    case 'extractText':
      return { kind: 'extractText', selector };
    case 'fill':
      return { kind: 'fill', selector, value: request.browserPaneValue ?? '' };
    default:
      throw new Error('Unsupported browser-pane action kind.');
  }
}

/**
 * Fires the side effect only from the human Review accept path, mirroring
 * fireReviewedAgentIntent/fireReviewedAgentAppAct exactly. `paneId` must
 * already be resolved by the caller via resolveTargetBrowserPaneId — this
 * function never guesses one. `actionId` is the approval's own runId, reused
 * as browser-pane-automation.ts's per-request pending-action key (it is
 * already a fresh, single-use identifier minted per approval request, so no
 * second id needs inventing).
 */
export async function fireReviewedAgentBrowserPaneAction(
  request: ReviewedAgentBrowserPaneAction,
  paneId: string,
  actionId: string,
  executeAction: ExecuteBrowserPaneAction,
): Promise<BrowserPaneActionResult> {
  const action = buildBrowserPaneAction(request);
  const urlAllowlist = parseUrlAllowlist(request.browserPaneUrlAllowlist);
  if (urlAllowlist.length === 0) {
    throw new Error('Browser-pane action is missing its URL allowlist.');
  }
  return executeAction(paneId, {
    action,
    urlAllowlist,
    approval: { approved: true, actionId },
  });
}
