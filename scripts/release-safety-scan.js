#!/usr/bin/env node
/**
 * Release-safety secret scan.
 *
 * Usage: node scripts/release-safety-scan.js [--allowlist FILE] <file|dir>...
 *
 * Scans files, directories, and zip-like archives (.apk/.aab/.zip/.jar, read
 * in memory via a minimal central-directory reader) plus .gz/.tgz for
 * recognizable secrets and signing material. Node built-ins only; needs no
 * secrets. Findings print file, entry, line/offset, and a REDACTED match
 * (never the full secret). Exit 1 on findings, 0 when clean, 2 on usage error.
 *
 * Allowlist (scripts/release-safety-allowlist.txt), one rule per line:
 *   # comment
 *   <path-glob> :: <substring-of-match | *>   (glob: * and ** supported,
 *                                              matched against "file!entry")
 *   <exact string>                            (suppresses any finding whose
 *                                              raw match equals it)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SKIP_DIRS = new Set(['node_modules', '.git', '.gradle', '.expo', '.cxx', 'Pods', '.claude']);
const SKIP_PATH_FRAGMENTS = ['android/build/', 'android/app/build/', 'android/.gradle/'];
const MAX_FILE_BYTES = 64 * 1024 * 1024;
// Release APKs and the Codex runtime tarball are hundreds of MB; they are the
// whole point of the scan, so archives get a much higher ceiling.
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024 - 1;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const ARCHIVE_EXT = new Set(['.apk', '.aab', '.zip', '.jar']);
const KEYSTORE_EXT = new Set(['.jks', '.keystore', '.p12', '.pfx']);

function entropy(s) {
  const f = new Map();
  for (const c of s) f.set(c, (f.get(c) || 0) + 1);
  let h = 0;
  for (const n of f.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const PLACEHOLDER_RE =
  /(\$\{|\$[A-Za-z_(]|<[^>]*>|\{\{|your[-_ ]|example|xxxx|changeme|change[-_]me|placeholder|process\.env|secrets\.|\*{3,}|dummy|fake|redacted|sample|null$|undefined$|^true$|^false$|^none$|todo)/i;

function isPlaceholder(v) {
  return PLACEHOLDER_RE.test(v) || /^(.)\1+$/.test(v);
}

// Token-format rules: precise prefixes, safe to run on binary content.
const TOKEN_RULES = [
  // Marker must be followed by a key body (base64 or PEM headers), so bare marker
  // strings embedded in SSH/TLS libraries do not trip the scan.
  { id: 'private-key-block', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?=(?:\\r|\\n|\s)*(?:[A-Za-z0-9+/]{32,}|Proc-Type|DEK-Info))/g },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})\b/g },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'slack-token', re: /\bxox[abpr]-[0-9A-Za-z-]{10,}/g },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'groq-key', re: /\bgsk_[A-Za-z0-9]{40,}/g },
  { id: 'perplexity-key', re: /\bpplx-[A-Za-z0-9]{32,}/g },
];

// Text-oriented rules (false-positive prone in binaries): text content only.
const TEXT_RULES = [
  {
    id: 'bearer-token',
    re: /\bBearer\s+([A-Za-z0-9._~+/-]{32,}=*)/g,
    group: 1,
    accept: (v) => !isPlaceholder(v) && entropy(v) >= 3.8,
  },
  {
    id: 'env-secret-assignment',
    re: /(?:^|[\s,{;])(?:export\s+)?["']?([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY)[A-Z0-9_]*)["']?[ \t]*[=:][ \t]*["']?([^\s"'#,;)}]{12,})/g,
    group: 2,
    accept: (v) => !isPlaceholder(v) && !/^(?:https?:\/\/|\/|\\)/.test(v) && !/^[A-Za-z_.]+\(/.test(v) && entropy(v) >= 3.0 && /\d/.test(v),
  },
  {
    id: 'signing-password',
    re: /\b(?:storePassword|keyPassword|KEYSTORE_PASSWORD|KEY_PASSWORD|STORE_PASSWORD)\b["']?\s*[=:]\s*["']([^"'\s]{4,})["']/g,
    group: 1,
    accept: (v) => !isPlaceholder(v),
  },
];

function redact(s) {
  const head = s.slice(0, 4).replace(/[^\x20-\x7e]/g, '?');
  return `${head}...[${s.length} chars redacted]`;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function lineOf(text, idx) {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < idx; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

function scanBuffer(buf, label, entryName, findings) {
  const text = buf.toString('latin1');
  const binary = looksBinary(buf);
  const rules = binary ? TOKEN_RULES : TOKEN_RULES.concat(TEXT_RULES);
  const display = entryName ? `${label}!${entryName}` : label;
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0].length === 0) { rule.re.lastIndex++; continue; }
      const secret = rule.group ? m[rule.group] : m[0];
      if (rule.accept && !rule.accept(secret)) continue;
      const offset = rule.group ? m.index + m[0].indexOf(secret) : m.index;
      findings.push({
        rule: rule.id,
        file: label,
        entry: entryName || '',
        display,
        line: binary ? null : lineOf(text, offset),
        offset,
        raw: secret,
        redacted: redact(secret),
      });
    }
  }
}

function checkKeystoreName(name, label, entryName, findings) {
  if (KEYSTORE_EXT.has(path.extname(name).toLowerCase())) {
    findings.push({
      rule: 'keystore-file',
      file: label,
      entry: entryName || '',
      display: entryName ? `${label}!${entryName}` : label,
      line: null,
      offset: 0,
      raw: name,
      redacted: path.basename(name),
    });
  }
}

// Minimal zip reader: central directory only, stored + deflate entries.
function* zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip end-of-central-directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    yield {
      name,
      read() {
        if (usize > MAX_ENTRY_BYTES) return null;
        const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
        const data = buf.subarray(start, start + csize);
        if (method === 0) return data;
        if (method === 8) return zlib.inflateRawSync(data);
        return null;
      },
    };
  }
}

function scanFile(file, findings, stats) {
  const st = fs.statSync(file);
  const ext = path.extname(file).toLowerCase();
  const isArchive = ARCHIVE_EXT.has(ext) || ext === '.gz' || ext === '.tgz';
  if (st.size > (isArchive ? MAX_ARCHIVE_BYTES : MAX_FILE_BYTES)) {
    stats.skipped.push(`${file} (too large)`);
    return;
  }
  stats.files++;
  checkKeystoreName(file, file, '', findings);
  const buf = fs.readFileSync(file);
  if (ARCHIVE_EXT.has(ext)) {
    try {
      for (const e of zipEntries(buf)) {
        stats.entries++;
        checkKeystoreName(e.name, file, e.name, findings);
        const data = e.read();
        if (data) scanBuffer(data, file, e.name, findings);
        else stats.skipped.push(`${file}!${e.name} (entry too large or unsupported compression)`);
      }
    } catch (err) {
      console.error(`WARN: could not read archive ${file}: ${err.message}; scanning raw bytes`);
      scanBuffer(buf, file, '', findings);
    }
    return;
  }
  if (ext === '.gz' || ext === '.tgz') {
    try {
      scanBuffer(zlib.gunzipSync(buf), file, '(gunzipped)', findings);
      return;
    } catch (_) { /* fall through to raw scan */ }
  }
  scanBuffer(buf, file, '', findings);
}

let skipFile = null;

function walk(target, findings, stats, explicit = false) {
  const norm = target.split(path.sep).join('/');
  // Build-output fragments are only skipped while walking the source tree; a
  // path passed on the command line (e.g. the release APK dir) is always scanned.
  if (!explicit && SKIP_PATH_FRAGMENTS.some((f) => (norm + '/').includes(f))) return;
  let st;
  try { st = fs.lstatSync(target); } catch (_) { return; }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(target))) return;
    for (const name of fs.readdirSync(target)) walk(path.join(target, name), findings, stats);
  } else if (st.isFile()) {
    if (skipFile && path.resolve(target) === skipFile) return;
    scanFile(target, findings, stats);
  }
}

function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = esc.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp('^' + body + '$');
}

function loadAllowlist(file) {
  const rules = [];
  if (!file || !fs.existsSync(file)) return rules;
  for (const lineRaw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(' :: ');
    if (idx >= 0) rules.push({ pathRe: globToRe(line.slice(0, idx).trim()), sub: line.slice(idx + 4).trim() });
    else rules.push({ exact: line });
  }
  return rules;
}

function isAllowed(f, rules) {
  const disp = f.display.split(path.sep).join('/').replace(/^\.\//, '');
  for (const r of rules) {
    if (r.exact !== undefined) {
      if (f.raw === r.exact) return true;
    } else if (r.pathRe.test(disp) && (r.sub === '*' || f.raw.includes(r.sub))) {
      return true;
    }
  }
  return false;
}

function run(targets, allowlistFile) {
  // The allowlist legitimately contains fake token substrings; never scan it.
  skipFile = allowlistFile ? path.resolve(allowlistFile) : null;
  const findings = [];
  const stats = { files: 0, entries: 0, skipped: [] };
  for (const t of targets) {
    if (!fs.existsSync(t)) {
      console.error(`ERROR: path not found: ${t}`);
      return { code: 2, findings, stats, allowed: 0 };
    }
    const before = { files: stats.files, skipped: stats.skipped.length };
    walk(t, findings, stats, true);
    // Fail closed: an explicit target that scanned nothing, or whose own files
    // were skipped, would otherwise pass silently.
    if (stats.files === before.files || stats.skipped.length > before.skipped) {
      for (const s of stats.skipped.slice(before.skipped)) console.error(`ERROR: not scanned: ${s}`);
      if (stats.files === before.files) console.error(`ERROR: nothing scanned under: ${t}`);
      return { code: 2, findings, stats, allowed: 0 };
    }
  }
  const rules = loadAllowlist(allowlistFile);
  const kept = findings.filter((f) => !isAllowed(f, rules));
  return { code: kept.length ? 1 : 0, findings: kept, stats, allowed: findings.length - kept.length };
}

function main(argv) {
  let allowlist = path.join(__dirname, 'release-safety-allowlist.txt');
  const targets = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--allowlist') allowlist = argv[++i];
    else targets.push(argv[i]);
  }
  if (!targets.length) {
    console.error('usage: release-safety-scan.js [--allowlist FILE] <file|dir>...');
    return 2;
  }
  const r = run(targets, allowlist);
  for (const f of r.findings) {
    const where = f.line ? `line ${f.line}` : `offset ${f.offset}`;
    console.log(`[${f.rule}] ${f.file}${f.entry ? ` entry=${f.entry}` : ''} ${where}: ${f.redacted}`);
  }
  console.log(
    `release-safety-scan: files=${r.stats.files} archive-entries=${r.stats.entries} ` +
      `findings=${r.findings.length} allowlisted=${r.allowed} skipped=${r.stats.skipped.length}`,
  );
  for (const s of r.stats.skipped) console.log(`  skipped: ${s}`);
  if (r.findings.length) console.log('FAIL: potential secrets found (values redacted above).');
  return r.code;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { run, scanBuffer, zipEntries, entropy };
