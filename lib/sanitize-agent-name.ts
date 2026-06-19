/**
 * lib/sanitize-agent-name.ts — leaf util (no native deps, unit-testable).
 *
 * SECURITY: an agent name lands verbatim in the generated run script's comment
 * line (lib/agent-executor.ts). An interior control char — especially a newline —
 * would close the `#` comment and turn the following bytes into executable shell
 * when the script runs. Strip ALL control chars (0x00–0x1F, 0x7F) and collapse the
 * resulting whitespace at the single createAgent write-boundary, so every caller
 * (NL confirm-card free-text, autonomous, terminal @agent) is safe.
 *
 * Implemented with char-code checks (no regex containing literal control bytes) so
 * the source file stays plain text.
 */
export function sanitizeAgentName(name: string, fallback = 'agent'): string {
  let out = '';
  let pendingSpace = false;
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    const isControl = code <= 0x1f || code === 0x7f;
    const isSpace = ch === ' ' || isControl;
    if (isSpace) {
      // Defer the space; only emit it if a non-space follows (collapses runs,
      // and drops leading whitespace because out is still empty).
      if (out.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      out += ' ';
      pendingSpace = false;
    }
    out += ch;
  }
  return out || fallback;
}
