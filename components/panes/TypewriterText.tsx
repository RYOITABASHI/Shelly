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

  const shown = active ? text.slice(0, revealed) : text;
  const showCursor = active && revealed < text.length;

  return (
    <Text style={style} selectable>
      {shown}
      {showCursor ? <Text style={{ color: cursorColor ?? undefined }}>{'▋'}</Text> : null}
    </Text>
  );
}
