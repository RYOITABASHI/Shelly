import * as fs from 'fs';
import * as path from 'path';

const scheduler = fs.readFileSync(
  path.resolve(
    __dirname,
    '..',
    'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentAlarmScheduler.kt',
  ),
  'utf8',
);

describe('AgentAlarmScheduler request-code allocation', () => {
  it('serializes the complete SharedPreferences read-modify-write on a stable object lock', () => {
    expect(scheduler).toContain('private val requestCodeLock = Any()');

    const start = scheduler.indexOf('fun getAgentRequestCode(');
    const end = scheduler.indexOf('/** The alarm operation', start);
    const allocation = start >= 0 && end > start ? scheduler.slice(start, end) : undefined;

    expect(allocation).toBeDefined();
    expect(allocation).toMatch(
      /= synchronized\(requestCodeLock\) \{[\s\S]*getSharedPreferences[\s\S]*getInt\(agentId, -1\)[\s\S]*getInt\("_next_id", 1000\)[\s\S]*putInt\(agentId, nextId\)[\s\S]*putInt\("_next_id", nextId \+ 1\)[\s\S]*\.apply\(\)[\s\S]*\n    }/,
    );
    expect(allocation).toContain('return@synchronized existing');
  });
});
