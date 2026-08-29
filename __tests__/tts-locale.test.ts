/**
 * __tests__/tts-locale.test.ts
 *
 * Fable5 review (2026-08-29, Hermes Agent parity audit): lib/tts.ts's speech
 * language and the "code block omitted" placeholder used to be hardcoded to
 * Japanese regardless of the app's own locale setting -- an English reply
 * (or an English-locale user) got read aloud by a Japanese voice. Both now
 * follow useI18n's current locale; this pins that behavior against
 * regression.
 */
import { useI18n } from '@/lib/i18n';

const speakMock = jest.fn((_text: string, options?: { onDone?: () => void }) => {
  options?.onDone?.();
});

jest.mock('expo-speech', () => ({
  speak: (text: string, options: unknown) => speakMock(text, options as { onDone?: () => void }),
  stop: jest.fn(),
  isSpeakingAsync: jest.fn(async () => false),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { speakText } = require('@/lib/tts');

describe('speakText locale behavior', () => {
  beforeEach(() => {
    speakMock.mockClear();
    useI18n.setState({ locale: 'en' });
  });
  afterEach(() => {
    useI18n.setState({ locale: 'en' });
  });

  it('speaks in en-US when the app locale is English', async () => {
    useI18n.setState({ locale: 'en' });
    await speakText('hello there');
    expect(speakMock).toHaveBeenCalledTimes(1);
    const [, options] = speakMock.mock.calls[0] as [string, { language: string }];
    expect(options.language).toBe('en-US');
  });

  it('speaks in ja-JP when the app locale is Japanese', async () => {
    useI18n.setState({ locale: 'ja' });
    await speakText('こんにちは');
    expect(speakMock).toHaveBeenCalledTimes(1);
    const [, options] = speakMock.mock.calls[0] as [string, { language: string }];
    expect(options.language).toBe('ja-JP');
  });

  it('replaces a code block with the English placeholder under the English locale', async () => {
    useI18n.setState({ locale: 'en' });
    await speakText('before\n```\nconst x = 1;\n```\nafter');
    const [text] = speakMock.mock.calls[0] as [string, unknown];
    expect(text).toContain('Code block omitted.');
    expect(text).not.toContain('コードブロック省略');
  });

  it('replaces a code block with the Japanese placeholder under the Japanese locale', async () => {
    useI18n.setState({ locale: 'ja' });
    await speakText('before\n```\nconst x = 1;\n```\nafter');
    const [text] = speakMock.mock.calls[0] as [string, unknown];
    expect(text).toContain('コードブロック省略');
    expect(text).not.toContain('Code block omitted');
  });
});
