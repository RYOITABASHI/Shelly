/**
 * lib/agent-closepaw-routing.ts — automatic ClosePaw routing of a UI-operation
 * step (2026-10-14, user-approved scope).
 *
 * Before this module only an EXPLICIT "ClosePawで…" / "have ClosePaw …"
 * produced a ClosePaw hand-off (lib/agent-nl-parser.ts detectClosePawAction —
 * unchanged and still checked first). Now, when an `@agent` request contains
 * ONE step that needs another app's screen operated ("LINEを開いて自分に送って",
 * "Chromeで天気予報を表示して", "open Spotify and play my playlist") and the
 * draft's delivery is still Shelly's plain default (draft / notify), only that
 * step becomes the ClosePaw hand-off; everything Shelly can do itself
 * (research, summarize, save, notify, cli) stays native — it runs first and
 * its output reaches ClosePaw through {{result}}.
 *
 * Conservative by design (false negatives preferred):
 *   - the step must name an app from a fixed list of launchable consumer apps
 *     (no payment / banking / social apps that have Shelly connectors), AND
 *   - use an explicit screen-operation verb right there ("を開いて", "で…送って",
 *     "で…表示して", "open X", "play … on X"). Generic phrases ("調べて",
 *     "search", "summarize", "remind") never route, and neither does an app
 *     mentioned only as a source ("LINEの通知が来たら", "Gmailのメールを要約").
 *   - native deliveries Shelly already resolved (social-post connector,
 *     browser-pane, webhook, cli, …) are never replaced.
 *
 * Never silent: the draft carries `closePawRouting`, and every confirmation
 * surface states which part ClosePaw will do by operating the phone (chat
 * summary — lib/agent-plan-summary.ts, the approval notification and the
 * `shelly agent add` stdout summary — lib/agent-add-approval.ts). A routed
 * draft is always confirmed in chat (shouldUseChatConfirm) and is HIGH-RISK
 * for remote approval (lib/agent-add-approval.ts assessAgentDraftRisk:
 * 'closepaw' → in-app review only). The per-run ClosePaw Review is unchanged
 * (never auto-accepted). Without ClosePaw installed nothing is routed and the
 * draft gets a caveat saying that step cannot be automated.
 */
import type { ParsedAgentDraft } from './agent-nl-parser';
import type { AgentOrchestrationStep } from '@/store/types';

type AppDef = { name: string; ja: string; en: string };

/** Launchable consumer apps whose UI ClosePaw may operate. Deliberately no
 *  payment/banking apps and no apps Shelly posts to via connectors (X,
 *  Bluesky, Threads, note, …). Regex sources (case-insensitive). */
const UI_APPS: AppDef[] = [
  { name: 'LINE', ja: 'LINE|ライン', en: 'LINE' },
  { name: 'Chrome', ja: '(?:Google\\s?)?Chrome|クローム', en: '(?:Google\\s)?Chrome' },
  { name: 'Gmail', ja: 'Gmail|Gメール', en: 'Gmail' },
  { name: 'Instagram', ja: 'Instagram|インスタ(?:グラム)?', en: 'Instagram' },
  { name: 'YouTube', ja: 'YouTube|ユーチューブ', en: 'YouTube' },
  { name: 'Slack', ja: 'Slack|スラック', en: 'Slack' },
  { name: 'Discord', ja: 'Discord|ディスコード', en: 'Discord' },
  { name: 'Spotify', ja: 'Spotify|スポティファイ', en: 'Spotify' },
  { name: 'Google Maps', ja: 'Google\\s?マップ|グーグルマップ|Google\\s?Maps', en: 'Google\\sMaps' },
  { name: 'WhatsApp', ja: 'WhatsApp', en: 'WhatsApp' },
  { name: 'Messenger', ja: 'Messenger|メッセンジャー', en: 'Messenger' },
  { name: 'Kindle', ja: 'Kindle|キンドル', en: 'Kindle' },
];

/** JA screen-operation verbs (て-form) that may follow "<app>で…". 検索/調べ
 *  are deliberately absent (research stays native). */
const JA_UI_VERBS = '(?:送って|送信して|送る|開いて|表示して|再生して|タップして|押して|入力して|投稿して|返信して|見せて|流して|スクロールして)';
const JA_OPEN_VERBS = '(?:を開いて|をひらいて|を起動して|アプリを開いて|を立ち上げて)';
const EN_UI_VERBS = '(?:send|play|show|display|open|tap|post|reply|type|message|text)';

const REMINDER_RE = /\bremind\b|リマインド|思い出させ|忘れないように/i;

export type UiOperationClause ={ app: string; clause: string; start: number; end: number };

/** Delimiters that end a UI clause (JA/EN sentence or clause boundary). */
const CLAUSE_END_RE = /[。．.!！?？\n;；]|、\s*(?:その後|それから|あと|最後に|終わったら)|,\s*(?:then|and then|after that|finally)\b|、(?=[^、。]*(?:保存|通知|まとめ|要約))/i;

function clauseEnd(text: string, from: number): number {
  const rest = text.slice(from);
  const m = CLAUSE_END_RE.exec(rest);
  return m ? from + m.index : text.length;
}

function cleanClause(s: string): string {
  return s.replace(/^[\s、,]+/, '').replace(/[\s、,。．.!！]+$/, '').trim();
}

/** Find the (first) UI-operation clause, or null. Pure, conservative. */
export function detectUiOperationClause(text: string): UiOperationClause | null {
  const src = String(text ?? '');
  // A reminder to do it yourself is a notification, not a UI operation.
  if (REMINDER_RE.test(src)) return null;
  let best: UiOperationClause | null = null;
  for (const app of UI_APPS) {
    const ja = new RegExp(
      `(?:${app.ja})(?:アプリ)?(?:${JA_OPEN_VERBS}|で[^。、\\n]{0,40}?${JA_UI_VERBS})`,
      'i',
    );
    const en = [
      new RegExp(`\\b(?:open|launch)\\s+(?:the\\s+)?(?:${app.en})(?:\\s+app)?\\b`, 'i'),
      new RegExp(`\\b(?:in|on|using|via)\\s+(?:the\\s+)?(?:${app.en})(?:\\s+app)?\\s*,?\\s*(?:and\\s+)?${EN_UI_VERBS}\\b`, 'i'),
      new RegExp(`\\b${EN_UI_VERBS}\\b[^.,;\\n]{0,60}?\\b(?:in|on|via|using)\\s+(?:the\\s+)?(?:${app.en})(?:\\s+app)?\\b`, 'i'),
    ];
    for (const re of [ja, ...en]) {
      const m = re.exec(src);
      if (!m) continue;
      // "LINE" must be the brand spelling, not the English word "line".
      if (app.name === 'LINE' && !/LINE|ライン/.test(m[0])) continue;
      // English verb-first form: the clause starts at the verb.
      const start = m.index;
      const end = Math.max(clauseEnd(src, start + m[0].length), start + m[0].length);
      const clause = cleanClause(src.slice(start, end));
      if (!clause) continue;
      if (!best || start < best.start) best = { app: app.name, clause, start, end };
    }
  }
  return best;
}

export type ClosePawRoutingInfo = {
  /** The request text ClosePaw will carry out on the phone. */
  clause: string;
  app: string;
  /** false = ClosePaw is not installed; nothing was routed (caveat set). */
  routed: boolean;
};

function isJa(text: string): boolean {
  return /[぀-ヿ一-鿿]/.test(text);
}

export function closePawNotInstalledCaveat(clause: string, ja: boolean): string {
  return ja
    ? `「${clause}」はアプリの画面操作が必要です。ClosePaw（ai.closepaw）がインストールされていないため、この部分は自動化できません。`
    : `"${clause}" needs another app's screen to be operated. ClosePaw (ai.closepaw) is not installed, so this step cannot be automated.`;
}

function stepText(s: string | AgentOrchestrationStep): string {
  return typeof s === 'string' ? s : s.instruction ?? '';
}

/**
 * Apply the routing to a freshly parsed draft. Returns the draft unchanged
 * when nothing applies. Never touches an explicit ClosePaw action or any
 * native delivery other than the plain draft/notify default.
 */
export function applyClosePawAutoRouting(
  draft: ParsedAgentDraft,
  rawText: string,
  opts: { closePawInstalled: boolean },
): ParsedAgentDraft {
  const type = draft.action?.type;
  if (type !== 'draft' && type !== 'notify') return draft;
  if (Array.isArray(draft.actions) && draft.actions.length >= 2) return draft;
  const ui = detectUiOperationClause(rawText);
  if (!ui) return draft;
  const ja = isJa(rawText);
  if (!opts.closePawInstalled) {
    const caveat = closePawNotInstalledCaveat(ui.clause, ja);
    return {
      ...draft,
      closePawRouting: { clause: ui.clause, app: ui.app, routed: false },
      actionCaveat: draft.actionCaveat ? `${draft.actionCaveat}\n${caveat}` : caveat,
    };
  }

  // Native remainder: the prompt without the UI clause.
  const prompt = String(draft.prompt ?? '');
  const strippedPrompt = prompt.includes(ui.clause)
    ? prompt.replace(ui.clause, ' ').replace(/[\s、,]+([。．.])/g, '$1').replace(/^[\s、,。．.]+|[\s、,]+$/g, '').trim()
    : prompt;
  const nativeLeft = strippedPrompt.replace(/[\s、,。．.!！]/g, '');
  const hasNativePart = nativeLeft.length >= 4 && strippedPrompt !== prompt;

  let orchestrationSteps = draft.orchestrationSteps;
  if (Array.isArray(orchestrationSteps) && orchestrationSteps.length > 0) {
    const kept = orchestrationSteps.filter((s) => !stepText(s).includes(ui.clause) && !ui.clause.includes(stepText(s).trim() || '\u0000'));
    orchestrationSteps = kept.length >= 2 ? kept : undefined;
  }

  const goal = hasNativePart
    ? ja
      ? `${ui.clause}（内容: {{result}}）`
      : `${ui.clause} (content: {{result}})`
    : ui.clause;
  return {
    ...draft,
    prompt: hasNativePart ? strippedPrompt : prompt,
    orchestrationSteps,
    action: { type: 'intent', intentMode: 'closepaw', intentShareText: goal },
    actions: undefined,
    closePawRouting: { clause: ui.clause, app: ui.app, routed: true },
  };
}
