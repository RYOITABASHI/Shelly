import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const driver = require('../scripts/shelly-agent-driver.js');

describe('shelly-agent-driver completed agent answer extraction', () => {
  it('reads the authoritative item/completed agentMessage.text shape', () => {
    const params = {
      threadId: 'thr_1',
      turnId: 'turn_1',
      item: {
        type: 'agentMessage',
        id: 'msg_1',
        text: 'First line\nSecond line',
      },
    };

    expect(driver.completedAgentMessageText(params)).toBe('First line\nSecond line');
  });

  it('ignores completed non-answer items and malformed agent messages', () => {
    expect(driver.completedAgentMessageText({
      item: { type: 'commandExecution', id: 'cmd_1', aggregatedOutput: 'not the answer' },
    })).toBeNull();
    expect(driver.completedAgentMessageText({
      item: { type: 'agentMessage', id: 'msg_1' },
    })).toBeNull();
    expect(driver.completedAgentMessageText(null)).toBeNull();
  });

  it('accumulates multiple completed agent messages in protocol order', () => {
    let answer = '';
    answer = driver.appendCompletedAgentMessage(answer, {
      item: { type: 'agentMessage', id: 'msg_1', text: 'Alpha' },
    });
    answer = driver.appendCompletedAgentMessage(answer, {
      item: { type: 'commandExecution', id: 'cmd_1', aggregatedOutput: 'ignored' },
    });
    answer = driver.appendCompletedAgentMessage(answer, {
      item: { type: 'agentMessage', id: 'msg_2', text: 'Beta' },
    });

    expect(answer).toBe('Alpha\nBeta');
  });

  it('writes the accumulated answer exactly and refuses whitespace-only output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-driver-answer-'));
    try {
      const answerFile = path.join(dir, 'result.answer');
      expect(driver.writeAnswerFile(answerFile, 'Alpha\nBeta')).toBe(true);
      expect(fs.readFileSync(answerFile, 'utf8')).toBe('Alpha\nBeta');

      const emptyFile = path.join(dir, 'empty.answer');
      expect(driver.writeAnswerFile(emptyFile, '  \n\t')).toBe(false);
      expect(fs.existsSync(emptyFile)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
