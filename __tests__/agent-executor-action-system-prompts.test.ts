jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));

import { generateRunScript } from '@/lib/agent-executor';
import type { Agent, AgentAction, ToolChoice } from '@/store/types';

function agent(tool: ToolChoice, action: AgentAction): Agent {
  return {
    id: 'system-prompt-test',
    name: 'System Prompt Test',
    description: '',
    prompt: 'Produce the requested result',
    schedule: null,
    tool,
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
    action,
  };
}

const OPENAI_SYSTEM_THEN_USER =
  '\\"messages\\":[{\\"role\\":\\"system\\",\\"content\\":%s},{\\"role\\":\\"user\\",\\"content\\":%s}]';

describe('agent action output system prompts', () => {
  it('frames local draft output as the requested content with no preamble or meta-commentary', () => {
    const script = generateRunScript(agent({ type: 'local' }, { type: 'draft' }));

    expect(script).toContain(OPENAI_SYSTEM_THEN_USER);
    expect(script).toContain('Write the requested document or content directly.');
    expect(script).toContain('Do not add a preamble saying that a draft was created.');
    expect(script).toContain('Follow explicit user instructions for content, format, length, and tone.');
    expect(script).toContain('Never add meta-commentary about your reasoning or interpretation of the request.');
  });

  it('frames a Cerebras notify result as a short notification message', () => {
    const script = generateRunScript(agent({ type: 'cerebras' }, { type: 'notify' }));

    expect(script).toContain(OPENAI_SYSTEM_THEN_USER);
    expect(script).toContain('Write the notification message itself.');
    expect(script).toContain('keep it to a few words or one sentence.');
  });

  it('frames a Groq dm-reply result as a natural short conversational reply', () => {
    const script = generateRunScript(agent(
      { type: 'groq' },
      { type: 'dm-reply', dmPairingId: 'pair-1', dmReplyText: '{{result}}' },
    ));

    expect(script).toContain(OPENAI_SYSTEM_THEN_USER);
    expect(script).toContain('Write the reply message itself as a natural, short conversational response');
    expect(script).toContain('unless explicit user instructions request otherwise.');
  });

  it('uses the same action prompt in Perplexity, Gemini native system instructions, and article evaluation', () => {
    const perplexity = generateRunScript(agent({ type: 'perplexity' }, { type: 'webhook', webhookUrl: 'https://hooks.example.com/x' }));
    expect(perplexity).toContain(OPENAI_SYSTEM_THEN_USER);
    expect(perplexity).toContain('Produce exactly the payload content requested for the webhook.');

    const gemini = generateRunScript(agent({ type: 'gemini-api' }, { type: 'intent', intentMode: 'share', intentShareText: '{{result}}' }));
    expect(gemini).toContain('\\"systemInstruction\\":{\\"parts\\":[{\\"text\\":%s}]}');
    expect(gemini).toContain('Produce exactly the text or content needed for the requested app or share action.');

    const articleEval = generateRunScript(agent({ type: 'ab-article-eval' }, { type: 'draft' }));
    expect(articleEval).toContain(OPENAI_SYSTEM_THEN_USER);
    expect(articleEval).toContain('LOCAL_REQUEST_FILE="$RUN_DIR/local-request.json"');
  });
});
