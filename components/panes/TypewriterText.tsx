/**
 * components/panes/TypewriterText.tsx
 *
 * Case File only: reveals `text` a few characters at a time instead of all
 * at once, even though the underlying stream can arrive in large bursts —
 * the "wolf in sheep's clothing" bit is that the model is still exactly as
 * fast, this just paces how the burst gets drawn so it reads like an old
 * terminal mechanically typing rather than a modern app dumping tokens.
 * Non-Case-File themes skip this entirely (`active={false}` renders the
 * full text immediately, same as before this existed).
 */
import React, { useEffect, useRef, useState } from 'react';
import { Text, type TextStyle, type StyleProp } from 'react-native';
import { logAIPaneJitter } from '@/lib/ai-pane-scroll-follow';

const CHARS_PER_TICK = 2;
const TICK_MS = 16;

type Props = {
  text: string;
  style?: StyleProp<TextStyle>;
  active: boolean;
  cursorColor?: string;
};

export function TypewriterText({ text, style, active, cursorColor }: Props) {
  const [revealed, setRevealed] = useState(active ? 0 : text.length);
  // Chat history switching / a brand-new message resets the reveal;
  // ordinary growth of the SAME message (more tokens arriving) must not,
  // or every incoming chunk would restart the animation from zero.
  const textRef = useRef(text);
  const wasActiveRef = useRef(active);

  useEffect(() => {
    const isNewMessage = !text.startsWith(textRef.current) && !textRef.current.startsWith(text);
    const justActivated = active && !wasActiveRef.current;
    textRef.current = text;
    wasActiveRef.current = active;
    if (!active) {
      setRevealed(text.length);
      return;
    }
    if (isNewMessage || justActivated) {
      setRevealed(0);
    }
  }, [text, active]);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setRevealed((r) => (r >= textRef.current.length ? r : Math.min(textRef.current.length, r + CHARS_PER_TICK)));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [active]);

  // TEMPORARY (2026-11-17) jitter diagnosis: numbers only, at most once per
  // second while active. Remove after the 60fps device gate.
  const lastJitterLogRef = useRef(0);
  useEffect(() => {
    if (!active) return;
    const now = Date.now();
    if (now - lastJitterLogRef.current < 1000) return;
    lastJitterLogRef.current = now;
    logAIPaneJitter(`typewriter revealed=${revealed} len=${textRef.current.length}`);
  }, [revealed, active]);

  const shown = active ? text.slice(0, revealed) : text;
  // While streaming the glyph is ALWAYS laid out so its footprint never
  // changes (it takes part in line breaking; toggling it made the last line
  // wrap/unwrap at the reveal's catch-up rate and the pane jitter). Once the
  // reveal has caught up it is drawn at near-zero alpha. Not 'transparent':
  // that is colour value 0, which Android treats as the undefined-colour
  // sentinel, so the cursor would inherit the text colour and render opaque.
  const showCursor = active;
  const caughtUp = revealed >= text.length;

  return (
    <Text style={style} selectable>
      {shown}
      {showCursor ? <Text style={{ color: caughtUp ? 'rgba(0,0,0,0.01)' : (cursorColor ?? undefined) }}>{'▋'}</Text> : null}
    </Text>
  );
}
