/**
 * lib/post-format-directive.ts
 *
 * (B) Platform-aware summarisation. When a chat message asks to summarise the
 * in-context content "for an X post" / "for a Note post", we append a format
 * directive to the system prompt so the LLM returns a publish-ready summary with the
 * right shape and length:
 *   - X (旧Twitter) free tier → a hard 280-character cap.
 *   - Note (note.com)        → a longer Markdown article.
 *
 * Pure + dependency-free so it can be unit-tested without the dispatch hook's native
 * imports. Returns '' when no post-format intent is present (a no-op for normal chat).
 */

export const X_POST_DIRECTIVE =
  '\n\n[出力フォーマット指定：X(旧Twitter)無料版への投稿]\n直前までの内容を、日本語で X 投稿1本に要約してください。全体を必ず280文字以内に厳守（改行・URL・ハッシュタグも文字数に含める）。要点を絞り、投稿本文だけを返す（前置き・後置き・「以下が要約です」等は書かない）。';

export const NOTE_POST_DIRECTIVE =
  '\n\n[出力フォーマット指定：Note(note.com)記事]\n直前までの内容を、日本語の Note 記事として要約してください。見出し＋本文の読みやすい記事形式（Markdown 可）、長さの目安は1000〜2000字。前置きは不要で、記事本文だけを返す。';

export function detectPostFormatDirective(text: string): string {
  // X / Twitter post (e.g. "X投稿用に要約", "ツイート用にまとめて", "X用に要約").
  // The leading (^|non-letter) is REQUIRED so the bare "x用" doesn't match inside
  // "Linux用", "macOS X用" trailing words, etc. ツイート/tweet are distinctive enough.
  if (/(?:^|[^a-z])(?:x|twitter|ツイッター)(?:投稿|ポスト)?用/i.test(text) || /ツイート用|tweet\s*用/i.test(text)) {
    return X_POST_DIRECTIVE;
  }
  // Note article (e.g. "Note投稿用に要約", "note記事用にまとめて", "ノート用"). Same
  // boundary so "Evernote用" / "keynote用" don't false-trigger on "note用".
  if (/(?:^|[^a-z])note(?:投稿|記事)?用/i.test(text) || /ノート(?:投稿|記事)?用/i.test(text)) {
    return NOTE_POST_DIRECTIVE;
  }
  return '';
}
