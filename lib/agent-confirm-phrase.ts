/**
 * lib/agent-confirm-phrase.ts — pure "does this chat reply mean commit/
 * register" detector, the confirm-side counterpart to
 * lib/agent-slot-fill.ts's `isCancelPhrase`.
 *
 * Project owner directive: no structured card/modal for NEW confirmation
 * surfaces — "チャットで自然言語で確認すればいいじゃん" (confirm via plain-
 * language chat). AgentChatConfirm (components/panes/AgentChatConfirm.tsx)
 * already offers a tap-to-confirm affordance for chat-native drafts; this
 * function is what lets typing a plain reply ("OK" / "登録して") do the same
 * thing as tapping the button — see hooks/use-ai-pane-dispatch.ts's dispatch(),
 * which checks this against the whole message BEFORE falling through to the
 * "neither confirm nor cancel" re-ask branch.
 *
 * Whole-message EXACT match (case-insensitive, after trim), never a
 * substring/partial match — mirrors isCancelPhrase's own implementation
 * pattern exactly (see its doc comment in lib/agent-slot-fill.ts), so a
 * legitimate reply that merely CONTAINS "ok" or "yes" (e.g. a hand-typed
 * prompt edit like "make it snappier, ok?") is never misread as a
 * confirmation, and short tokens ("ok"/"はい") are safe specifically because
 * the match is against the ENTIRE trimmed message, not a fragment of it.
 */
export function isConfirmPhrase(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return [
    // English
    'ok',
    'okay',
    'yes',
    'yep',
    'yeah',
    'confirm',
    'register',
    'go ahead',
    'do it',
    'sounds good',
    'looks good',
    // Japanese
    'はい',
    'それで',
    'それでいい',
    'それでお願い',
    'それでお願いします',
    '登録して',
    '登録',
    '確定',
    '確定して',
    'お願いします',
    'よろしく',
    'よろしくお願いします',
  ].includes(trimmed);
}
