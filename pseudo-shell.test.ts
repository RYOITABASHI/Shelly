import { describe, it, expect } from 'vitest';
import { executeCommand } from '../lib/pseudo-shell';

const defaultState = {
  cwd: '/home/user',
  env: {},
  history: [],
};

describe('pseudo-shell executeCommand', () => {
  it('pwd returns current directory', () => {
    const result = executeCommand('pwd', defaultState);
    expect(result.lines[0].text).toBe('/home/user');
    expect(result.lines[0].type).toBe('stdout');
  });

  it('ls returns file list', () => {
    const result = executeCommand('ls', defaultState);
    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.lines[0].text).toContain('Documents');
  });

  it('cd changes directory', () => {
    const result = executeCommand('cd Documents', defaultState);
    expect(result.newState.cwd).toBe('/home/user/Documents');
  });

  it('cd to non-existent directory returns error', () => {
    const result = executeCommand('cd nonexistent', defaultState);
    expect(result.lines[0].type).toBe('stderr');
  });

  it('echo outputs text', () => {
    const result = executeCommand('echo hello world', defaultState);
    expect(result.lines[0].text).toBe('hello world');
  });

  it('cat reads file content', () => {
    const result = executeCommand('cat README.md', defaultState);
    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.lines.some(l => l.text.includes('Shelly'))).toBe(true);
  });

  it('cat non-existent file returns error', () => {
    const result = executeCommand('cat nonexistent.txt', defaultState);
    expect(result.lines[0].type).toBe('stderr');
  });

  it('whoami returns user', () => {
    const result = executeCommand('whoami', defaultState);
    expect(result.lines[0].text).toBe('user');
  });

  it('clear returns __CLEAR__ signal', () => {
    const result = executeCommand('clear', defaultState);
    expect(result.lines[0].text).toBe('__CLEAR__');
  });

  it('unknown command returns error', () => {
    const result = executeCommand('unknowncmd', defaultState);
    expect(result.lines[0].type).toBe('stderr');
    expect(result.lines[0].text).toContain('command not found');
  });

  it('empty command returns empty lines', () => {
    const result = executeCommand('', defaultState);
    expect(result.lines).toHaveLength(0);
  });

  it('git status returns branch info', () => {
    const result = executeCommand('git status', defaultState);
    expect(result.lines.some(l => l.text.includes('main'))).toBe(true);
  });

  it('ls -la returns long format', () => {
    // Note: args are split by whitespace, so '-la' is a single arg
    // The pseudo-shell checks for args.includes('-la')
    const result = executeCommand('ls -la', defaultState);
    // Should return multiple lines (one per entry)
    expect(result.lines.length).toBeGreaterThan(1);
    // Each line should contain 'user' (the owner field)
    expect(result.lines.some(l => l.text.includes('user'))).toBe(true);
  });

  it('date returns date string', () => {
    const result = executeCommand('date', defaultState);
    expect(result.lines[0].text).toBeTruthy();
  });

  it('help returns command list', () => {
    const result = executeCommand('help', defaultState);
    expect(result.lines.some(l => l.text.includes('ls'))).toBe(true);
  });
});
