/**
 * TypewriterText cursor: while active the ▋ glyph is always rendered (so line
 * breaking never changes mid-stream); once the reveal catches up it is
 * transparent rather than removed. Inactive renders no cursor.
 */
import React from 'react';
import { act, render } from '@testing-library/react-native';
import { TypewriterText } from '@/components/panes/TypewriterText';

const CURSOR = '▋';

function flatten(style: unknown): Record<string, unknown> {
  return Object.assign({}, ...[style].flat(Infinity).filter(Boolean) as object[]);
}

describe('TypewriterText cursor', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('renders the cursor while the reveal lags and after it catches up (active)', () => {
    const { queryByText } = render(
      <TypewriterText text="hello world" active cursorColor="#0f0" />,
    );
    const lagging = queryByText(CURSOR);
    expect(lagging).not.toBeNull();
    expect(flatten(lagging!.props.style).color).toBe('#0f0');

    act(() => {
      jest.advanceTimersByTime(16 * 20);
    });
    const caught = queryByText(CURSOR);
    expect(caught).not.toBeNull();
    expect(flatten(caught!.props.style).color).toBe('transparent');
  });

  it('keeps the cursor present when more text arrives after catching up', () => {
    const { queryByText, rerender } = render(<TypewriterText text="abc" active cursorColor="#0f0" />);
    act(() => {
      jest.advanceTimersByTime(16 * 10);
    });
    expect(flatten(queryByText(CURSOR)!.props.style).color).toBe('transparent');
    rerender(<TypewriterText text="abcdef" active cursorColor="#0f0" />);
    expect(queryByText(CURSOR)).not.toBeNull();
    expect(flatten(queryByText(CURSOR)!.props.style).color).toBe('#0f0');
  });

  it('renders no cursor when inactive', () => {
    const { queryByText } = render(<TypewriterText text="hello" active={false} />);
    expect(queryByText(CURSOR)).toBeNull();
  });
});
