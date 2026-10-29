'use strict';
/**
 * shelly-device.js — `shelly device <command>`: phone features for scripts,
 * agents and Codex without a separate add-on app (a built-in subset of the
 * most-used Termux:API commands).
 *
 * Extracted to $HOME/.shelly-device.js on every launch (HomeInitializer.kt)
 * and loaded by the generated `shelly` helper (SHELLY_HELPER_SHIM v23+):
 *   require($HOME/.shelly-device.js).main(argv)
 *
 * IPC — the same file bridge every other `shelly` subcommand uses (CLAUDE.md:
 * Knox denies `am start` from the app uid, so there is no intent route):
 *   1. this script writes ONE request file per call,
 *      $HOME/.shelly-device-req-<reqId> (tmp + rename), holding a single JSON
 *      line {"v":1,"reqId","ts","op","args"};
 *   2. DeviceApi.kt (native, FileObserver + poll, started by
 *      TerminalSessionService and the Expo module, so it also works while
 *      Shelly is in the background) claims it, re-validates everything,
 *      applies its rate limits and answers with
 *      $HOME/.shelly-device-result-<reqId>.json {"ok","code","message","data"};
 *   3. this script prints the result and exits.
 *
 * Arg parsing lives here (testable with jest, __tests__/shelly-device.test.ts);
 * the native side NEVER trusts it and checks every field again.
 */
const fs = require('fs');
const path = require('path');

const PROTOCOL_VERSION = 1;
const REQ_PREFIX = '.shelly-device-req-';
const RESULT_PREFIX = '.shelly-device-result-';

const MAX_TEXT_CHARS = 100000; // clipboard set
const MAX_NOTIFY_TITLE_CHARS = 100;
const MAX_NOTIFY_TEXT_CHARS = 2000;
const MAX_TOAST_CHARS = 500;
const MAX_TTS_CHARS = 3900; // below TextToSpeech.getMaxSpeechInputLength() (4000)
const MAX_SHARE_TEXT_CHARS = 20000;
const MAX_NOTIFY_ID = 9999;
const DEFAULT_VIBRATE_MS = 300;
const MAX_VIBRATE_MS = 2000;
const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

const EXIT = { ok: 0, error: 1, usage: 2, unavailable: 3, rateLimited: 4, timeout: 124 };
const CODE_TO_EXIT = {
  usage: EXIT.usage,
  permission: EXIT.unavailable,
  unavailable: EXIT.unavailable,
  background: EXIT.unavailable,
  rate_limited: EXIT.rateLimited,
};

const MAIN_HELP = [
  'Usage: shelly device <command> [options]',
  '',
  'Phone features for scripts, agents and Codex (built in, no add-on app).',
  '',
  '  battery                          Battery level, charging state, temperature (JSON)',
  '  info                             Model, Android version, screen, locale, network (JSON)',
  '  clipboard get [--json]           Print the clipboard text (Shelly must be the focused app)',
  '  clipboard set [--sensitive] <text...>   Set the clipboard ("-" or a pipe: read stdin)',
  '  notify [--title T] [--id N] <text...>   Post a notification on Shelly\'s "Scripts" channel',
  '  notify --remove N                Remove notification N',
  '  toast <text...>                  Show a short toast',
  '  vibrate [ms]                     Vibrate (default 300 ms, capped at 2000 ms)',
  '  tts [--lang TAG] <text...>       Speak with Android text-to-speech (default: phone language)',
  '  share [--text|--file] <file|text...>    Open the Android share sheet',
  '',
  '  shelly device <command> --help   Details for one command',
  '',
  'battery and info print JSON. Exit codes: 0 ok, 1 failed, 2 usage error,',
  '3 permission missing / not available right now, 4 rate limited',
  '(notify 30/min, toast, vibrate and tts 10/min, share 5/min), 124 Shelly did not answer.',
  '',
  'Privacy: "clipboard get" hands whatever is on the clipboard (passwords, one-time',
  'codes) to the program that ran it. Agents need approval for it.',
];

const HELP = {
  battery: [
    'Usage: shelly device battery',
    '',
    'Prints JSON: level (0-100), charging, plugged (ac|usb|wireless|dock|none),',
    'status, health, temperatureC, voltageMv.',
  ],
  info: [
    'Usage: shelly device info',
    '',
    'Prints JSON: manufacturer, model, Android release / SDK, screen size and density,',
    'locale, time zone, network (connected + wifi|cellular|other|none) and the Shelly version.',
    'No identifiers (IMEI, serial, Android ID, IP or MAC addresses) are included.',
  ],
  clipboard: [
    'Usage: shelly device clipboard get [--json]',
    '       shelly device clipboard set [--sensitive] <text...>',
    '       shelly device clipboard set [--sensitive] -      (or pipe text in)',
    '',
    'get prints the clipboard text as-is (--json: {"text": "..."}). Android lets only the',
    'focused app read the clipboard, so get works while Shelly is on screen; otherwise it',
    'exits 3. Android may show "Shelly pasted from your clipboard".',
    'set reads stdin when the text is "-" or missing and stdin is not a terminal; one',
    'trailing newline is dropped. --sensitive hides the content from clipboard previews.',
    '',
    'Privacy: get hands the clipboard (passwords, one-time codes) to whatever ran it.',
  ],
  notify: [
    'Usage: shelly device notify [--title T] [--id N] <text...>',
    '       shelly device notify --remove N',
    '',
    'Posts a notification on Shelly\'s "Scripts" channel (you can mute it in Android',
    'settings). N is 0-9999 (default 0): posting with the same id replaces it.',
    'Tapping the notification opens Shelly. At most 30 per minute.',
  ],
  toast: ['Usage: shelly device toast <text...>', '', 'Shows a short toast. At most 10 per minute.'],
  vibrate: [
    'Usage: shelly device vibrate [ms]',
    '',
    'Vibrates for ms milliseconds (default 300, capped at 2000). At most 10 per minute.',
    'Android may ignore it while Shelly is in the background.',
  ],
  tts: [
    'Usage: shelly device tts [--lang TAG] <text...>',
    '',
    'Speaks the text with Android text-to-speech, in the phone language unless --lang',
    'gives a BCP-47 tag (e.g. en-US, ja-JP). Returns once the speech is queued.',
    'At most 10 per minute.',
  ],
  share: [
    'Usage: shelly device share [--text|--file] <file|text...>',
    '',
    'Opens the Android share sheet for a file (when the argument is an existing file) or',
    'for text. Files must be inside Shelly\'s home or /sdcard/Download; credential',
    'locations (~/.ssh, ~/.codex, ~/.shelly, .env, keys) are refused. You choose the',
    'target app on the screen. If Shelly is in the background it posts a "tap to share"',
    'notification instead. At most 5 per minute.',
  ],
};

class UsageError extends Error {
  constructor(message, help) {
    super(message);
    this.help = help;
  }
}

function codePointLength(s) {
  return Array.from(s).length;
}

/** Splits options from words. `spec` maps option -> 'flag' | 'value'. */
function splitOptions(argv, spec, cmd) {
  const opts = {};
  const words = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      i++;
      break;
    }
    if (a === '--help' || a === '-h') {
      opts.help = true;
      continue;
    }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const kind = spec[name];
      if (!kind) throw new UsageError('unknown option --' + name, cmd);
      if (kind === 'flag') {
        if (eq > 0) throw new UsageError('--' + name + ' takes no value', cmd);
        opts[name] = true;
        continue;
      }
      let value;
      if (eq > 0) value = a.slice(eq + 1);
      else {
        if (i + 1 >= argv.length) throw new UsageError('--' + name + ' needs a value', cmd);
        value = argv[++i];
      }
      opts[name] = value;
      continue;
    }
    if (a.length > 1 && a.startsWith('-') && a !== '-' && !/^-[0-9]/.test(a)) {
      throw new UsageError('unknown option ' + a + ' (use -- before text that starts with "-")', cmd);
    }
    words.push(a);
  }
  for (; i < argv.length; i++) words.push(argv[i]);
  return { opts, words };
}

function requireText(words, cmd, max) {
  const text = words.join(' ');
  if (!text.trim()) throw new UsageError('missing text', cmd);
  if (codePointLength(text) > max) throw new UsageError('text is longer than ' + max + ' characters', cmd);
  return text;
}

function parseId(raw, cmd) {
  if (!/^[0-9]{1,4}$/.test(String(raw)) || Number(raw) > MAX_NOTIFY_ID) {
    throw new UsageError('notification id must be a number from 0 to ' + MAX_NOTIFY_ID, cmd);
  }
  return Number(raw);
}

/**
 * Parses argv (after `device`). Returns
 *   { help: string[] }                                  -- print, exit 0
 *   { op, args, output: 'json'|'clipboard'|'clipboard-json'|'message'|'none',
 *     timeoutMs, readStdin?: boolean, sensitive?: boolean, notes?: string[] }
 * Throws UsageError. `io` = { stdinIsTty: boolean, cwd: string, fileExists(p) }.
 */
function parse(argv, io) {
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return { help: MAIN_HELP };
  if (!Object.prototype.hasOwnProperty.call(HELP, cmd)) {
    throw new UsageError("unknown command '" + cmd + "'", null);
  }
  if (rest[0] === 'help' && cmd !== 'toast' && cmd !== 'tts' && cmd !== 'notify' && cmd !== 'share') {
    return { help: HELP[cmd] };
  }

  if (cmd === 'battery' || cmd === 'info') {
    const { opts, words } = splitOptions(rest, {}, cmd);
    if (opts.help) return { help: HELP[cmd] };
    if (words.length) throw new UsageError('unexpected argument ' + words[0], cmd);
    return { op: cmd, args: {}, output: 'json', timeoutMs: 10000 };
  }

  if (cmd === 'clipboard') {
    const sub = rest[0];
    if (sub === undefined || sub === '--help' || sub === '-h') return { help: HELP.clipboard };
    if (sub === 'get') {
      const { opts, words } = splitOptions(rest.slice(1), { json: 'flag' }, cmd);
      if (opts.help) return { help: HELP.clipboard };
      if (words.length) throw new UsageError('unexpected argument ' + words[0], cmd);
      return { op: 'clipboard.get', args: {}, output: opts.json ? 'clipboard-json' : 'clipboard', timeoutMs: 10000 };
    }
    if (sub === 'set') {
      const { opts, words } = splitOptions(rest.slice(1), { sensitive: 'flag' }, cmd);
      if (opts.help) return { help: HELP.clipboard };
      const fromStdin = (words.length === 1 && words[0] === '-') || (words.length === 0 && !io.stdinIsTty);
      if (fromStdin) {
        return {
          op: 'clipboard.set',
          args: { sensitive: Boolean(opts.sensitive) },
          readStdin: true,
          output: 'none',
          timeoutMs: 10000,
        };
      }
      if (words.length === 0) throw new UsageError('missing text (pass it as arguments, "-" or a pipe)', cmd);
      const text = words.join(' ');
      if (codePointLength(text) > MAX_TEXT_CHARS) throw new UsageError('text is longer than ' + MAX_TEXT_CHARS + ' characters', cmd);
      return { op: 'clipboard.set', args: { text, sensitive: Boolean(opts.sensitive) }, output: 'none', timeoutMs: 10000 };
    }
    throw new UsageError("unknown clipboard command '" + sub + "' (get or set)", cmd);
  }

  if (cmd === 'notify') {
    const { opts, words } = splitOptions(rest, { title: 'value', id: 'value', remove: 'value' }, cmd);
    if (opts.help) return { help: HELP.notify };
    if (opts.remove !== undefined) {
      if (words.length || opts.title !== undefined || opts.id !== undefined) {
        throw new UsageError('--remove takes only the notification id', cmd);
      }
      return { op: 'notify.remove', args: { id: parseId(opts.remove, cmd) }, output: 'none', timeoutMs: 10000 };
    }
    const text = requireText(words, cmd, MAX_NOTIFY_TEXT_CHARS);
    const title = opts.title === undefined ? '' : String(opts.title);
    if (codePointLength(title) > MAX_NOTIFY_TITLE_CHARS) {
      throw new UsageError('title is longer than ' + MAX_NOTIFY_TITLE_CHARS + ' characters', cmd);
    }
    const id = opts.id === undefined ? 0 : parseId(opts.id, cmd);
    return { op: 'notify', args: { title, text, id }, output: 'none', timeoutMs: 10000 };
  }

  if (cmd === 'toast') {
    const { opts, words } = splitOptions(rest, {}, cmd);
    if (opts.help) return { help: HELP.toast };
    return { op: 'toast', args: { text: requireText(words, cmd, MAX_TOAST_CHARS) }, output: 'none', timeoutMs: 10000 };
  }

  if (cmd === 'vibrate') {
    const { opts, words } = splitOptions(rest, {}, cmd);
    if (opts.help) return { help: HELP.vibrate };
    if (words.length > 1) throw new UsageError('unexpected argument ' + words[1], cmd);
    let ms = DEFAULT_VIBRATE_MS;
    const notes = [];
    if (words.length === 1) {
      if (!/^[0-9]{1,7}$/.test(words[0]) || Number(words[0]) < 1) {
        throw new UsageError('duration must be a whole number of milliseconds (1-' + MAX_VIBRATE_MS + ')', cmd);
      }
      ms = Number(words[0]);
      if (ms > MAX_VIBRATE_MS) {
        notes.push('shelly device vibrate: capped at ' + MAX_VIBRATE_MS + ' ms');
        ms = MAX_VIBRATE_MS;
      }
    }
    return { op: 'vibrate', args: { ms }, output: 'none', timeoutMs: 10000, notes };
  }

  if (cmd === 'tts') {
    const { opts, words } = splitOptions(rest, { lang: 'value' }, cmd);
    if (opts.help) return { help: HELP.tts };
    const args = { text: requireText(words, cmd, MAX_TTS_CHARS) };
    if (opts.lang !== undefined) {
      if (!LANG_RE.test(String(opts.lang)) || String(opts.lang).length > 35) {
        throw new UsageError('--lang takes a language tag such as en-US or ja-JP', cmd);
      }
      args.lang = String(opts.lang);
    }
    // First use starts the TTS engine (a few seconds on some phones).
    return { op: 'tts', args, output: 'none', timeoutMs: 20000 };
  }

  // share
  const { opts, words } = splitOptions(rest, { text: 'flag', file: 'flag', title: 'value' }, cmd);
  if (opts.help) return { help: HELP.share };
  if (opts.text && opts.file) throw new UsageError('use either --text or --file', cmd);
  if (!words.length) throw new UsageError('missing file or text', cmd);
  let kind = opts.text ? 'text' : opts.file ? 'file' : null;
  const candidate = words.length === 1 ? path.resolve(io.cwd, words[0]) : null;
  if (!kind) kind = candidate && io.fileExists(candidate) ? 'file' : 'text';
  if (kind === 'file') {
    if (words.length !== 1) throw new UsageError('--file takes exactly one path', cmd);
    if (!io.fileExists(candidate)) throw new UsageError('no such file: ' + words[0], cmd);
    return { op: 'share', args: { kind: 'file', path: candidate }, output: 'message', timeoutMs: 10000 };
  }
  return {
    op: 'share',
    args: { kind: 'text', text: requireText(words, cmd, MAX_SHARE_TEXT_CHARS) },
    output: 'message',
    timeoutMs: 10000,
  };
}

function isTty(fd) {
  try {
    return require('tty').isatty(fd);
  } catch (e) {
    return false;
  }
}

/** Strips terminal control characters (keeps \n and \t) for TTY output. */
function cleanForTerminal(s) {
  return String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

function cleanMessage(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim();
}

function writeOut(fd, s) {
  try {
    fs.writeSync(fd, s);
  } catch (e) {
    /* EPIPE etc. */
  }
}

function readStdinText(fd) {
  if (isTty(fd)) throw new UsageError('stdin is a terminal: pipe text in, or pass it as arguments', 'clipboard');
  let text = fs.readFileSync(fd, 'utf8');
  text = text.replace(/\r?\n$/, '');
  if (codePointLength(text) > MAX_TEXT_CHARS) {
    throw new UsageError('stdin text is longer than ' + MAX_TEXT_CHARS + ' characters', 'clipboard');
  }
  return text;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Entry point. Never returns: always calls process.exit.
 * opts (tests): { home, env, cwd, stdinFd, stdoutIsTty }
 */
function main(argv, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const home = o.home || env.HOME || '';
  const stdinFd = o.stdinFd !== undefined ? o.stdinFd : env.SHELLY_DEVICE_STDIN_FD === '3' ? 3 : 0;
  const stdoutIsTty = o.stdoutIsTty !== undefined ? o.stdoutIsTty : isTty(1);
  const err = (s) => writeOut(2, s + '\n');

  let req;
  try {
    req = parse(argv, {
      stdinIsTty: isTty(stdinFd),
      cwd: o.cwd || process.cwd(),
      fileExists: (p) => {
        try {
          return fs.statSync(p).isFile();
        } catch (e) {
          return false;
        }
      },
    });
    if (req.help) {
      writeOut(1, req.help.join('\n') + '\n');
      process.exit(EXIT.ok);
    }
    if (req.readStdin) req.args.text = readStdinText(stdinFd);
  } catch (e) {
    if (!(e instanceof UsageError)) {
      err('shelly device: ' + (e && e.message ? e.message : e));
      process.exit(EXIT.error);
    }
    err('shelly device: ' + e.message);
    err(e.help ? 'Run "shelly device ' + e.help + ' --help" for usage.' : 'Run "shelly device --help" for usage.');
    process.exit(EXIT.usage);
  }
  (req.notes || []).forEach(err);

  if (!home) {
    err('shelly device: HOME is not set; open a fresh Shelly shell');
    process.exit(EXIT.error);
  }
  const reqId = Date.now() + '-' + require('crypto').randomBytes(4).toString('hex');
  const reqFile = path.join(home, REQ_PREFIX + reqId);
  const resultFile = path.join(home, RESULT_PREFIX + reqId + '.json');
  const line = JSON.stringify({ v: PROTOCOL_VERSION, reqId, ts: Date.now(), op: req.op, args: req.args }) + '\n';
  try {
    fs.writeFileSync(reqFile + '.tmp', line, { mode: 0o600 });
    fs.renameSync(reqFile + '.tmp', reqFile);
  } catch (e) {
    try {
      fs.unlinkSync(reqFile + '.tmp');
    } catch (e2) {
      /* ignore */
    }
    err('shelly device: failed to queue the request: ' + (e && e.message ? e.message : e));
    process.exit(EXIT.error);
  }

  const envTimeout = Number(env.SHELLY_DEVICE_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(envTimeout) && envTimeout >= 100 ? Math.min(envTimeout, 60000) : req.timeoutMs;
  const deadline = Date.now() + timeoutMs;
  let result = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultFile)) {
      try {
        result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      } catch (e) {
        sleepMs(50);
        continue;
      }
      try {
        fs.unlinkSync(resultFile);
      } catch (e) {
        /* ignore */
      }
      break;
    }
    sleepMs(50);
  }
  if (!result) {
    try {
      fs.unlinkSync(reqFile);
    } catch (e) {
      /* already claimed */
    }
    err('shelly device ' + argv[0] + ': Shelly did not answer within ' + Math.round(timeoutMs / 1000) + 's (is the app running? open it and retry)');
    process.exit(EXIT.timeout);
  }

  if (!result.ok) {
    err('shelly device ' + argv[0] + ': ' + (cleanMessage(result.message) || 'failed'));
    process.exit(CODE_TO_EXIT[result.code] !== undefined ? CODE_TO_EXIT[result.code] : EXIT.error);
  }
  const data = result.data && typeof result.data === 'object' ? result.data : {};
  if (req.output === 'json') {
    writeOut(1, JSON.stringify(data, null, 2) + '\n');
  } else if (req.output === 'clipboard') {
    const text = typeof data.text === 'string' ? data.text : '';
    if (stdoutIsTty) {
      const shown = cleanForTerminal(text);
      writeOut(1, shown && !shown.endsWith('\n') ? shown + '\n' : shown);
    } else {
      writeOut(1, text);
    }
  } else if (req.output === 'clipboard-json') {
    writeOut(1, JSON.stringify({ text: typeof data.text === 'string' ? data.text : '' }, null, 2) + '\n');
  } else if (req.output === 'message') {
    const msg = cleanMessage(result.message);
    if (msg) writeOut(1, msg + '\n');
  }
  process.exit(EXIT.ok);
}

module.exports = {
  main,
  parse,
  UsageError,
  EXIT,
  CODE_TO_EXIT,
  PROTOCOL_VERSION,
  REQ_PREFIX,
  RESULT_PREFIX,
  MAX_VIBRATE_MS,
};

if (require.main === module) main(process.argv.slice(2));
