'use strict';
/**
 * `shelly image`: one generated header image, for a private script to use.
 *
 *   shelly image --style <name> --subject <text> --out <file.jpg under $TMPDIR>
 *
 * Prints {"path","sha256","width","height","bytes"} as one JSON line.
 * Extracted to $HOME/.shelly-image.js on every launch (with the vendored JPEG
 * codec $HOME/.shelly-image-jpeg.js), so a script can also run it with `node`.
 *
 * The image comes from the agent driver's --image-only Codex turn (no shell, no
 * file changes, no web search, no MCP; only the image tool). The prompt is built
 * in the driver from a fixed style and a sanitized subject of at most 80
 * characters; nothing else reaches it, and there is no way to add prompt text.
 *
 * The turn runs under a permission profile whose only readable root is an empty
 * private directory, and only on a Codex version whose canary passed on the
 * phone (`shelly image --canary`, see CODEX_IMAGE_CANARY_VERIFIED in the driver).
 *
 * The bytes from Codex are not trusted: magic bytes are checked, the image is
 * decoded with size limits (8000 px a side, 16 MP, 8-bit only) in plain JS,
 * cropped to 3:2, resized to 1600 px wide and encoded again as JPEG (quality 80).
 * Only pixels survive, so any metadata is gone.
 *
 * Unattended use is allowed (owner decision). It runs the Codex the agent worker
 * runs (the reviewed one, never SHELLY_CODEX_TUI_PATH), one Codex text-only or
 * image turn at a time across runs (locks/text-only-codex.slot, the executor's
 * own per-engine lock), and it holds a locks/image-<pid>.pid while it runs so the
 * agents' concurrency limit and the executor's Codex CLI slot (executor v39)
 * count it, and STOP-ALL stops it (by the starttime record, or by this file's
 * name on the command line: the `shelly` helper runs it as a child for that).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const USAGE = `Usage: shelly image --style <name> --subject <text> --out <path.jpg under $TMPDIR>
                    [--model <codex model>] [--timeout-ms <ms>] [--wait-ms <ms>]
       shelly image --canary [--model <codex model>]

Generates one header image with Codex (needs Codex signed in with a paid ChatGPT
plan) and saves it as a 1600 px wide 3:2 JPEG. Prints JSON:
  {"path": ..., "sha256": ..., "width": ..., "height": ..., "bytes": ...}

Styles: STYLES
The subject is a short theme (at most 80 characters after URLs, markup and
control characters are removed). It never carries article text.

--canary checks this Codex version once on the phone. Codex is asked to edit
$HOME/.c/x.png (outside its only readable directory; made and removed by the
run), then an image inside that directory, then to generate one image. PASS
needs the exact refusal for $HOME/.c/x.png, the inside image read with its
sha256, and the plain image. Prints IMAGE_CANARY PASS|FAIL codex=<version>.
Image generation stays off until that version is added to the driver's
verified list. A $HOME/.c that Shelly did not make is left alone (the run fails).`;

const OUT_WIDTH = 1600;
const OUT_HEIGHT = Math.round((OUT_WIDTH * 2) / 3); // 1067
const JPEG_QUALITY = 80;
const MAX_DIMENSION = 8000;
const MAX_PIXELS = 16 * 1000 * 1000;
const MIN_DIMENSION = 64;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300 * 1000;
const MAX_TIMEOUT_MS = 600 * 1000;
const DEFAULT_WAIT_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 2000;
const WORK_PREFIX = 'shelly-image-';
// Longer than a run can last (wait ≤ 1 h + timeout ≤ 10 min).
const WORK_STALE_MS = 2 * 60 * 60 * 1000;
const TEMP_FILE_RE = /^\.shelly-image-\d+-[0-9a-f]{8}\.tmp$/;
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,64}$/;
const EXIT_BUSY = 75;

class UsageError extends Error {}
class BusyError extends Error {}

// ─── Sibling assets ───────────────────────────────────────────────────────
// On the phone these live in $HOME as .shelly-image.js / .shelly-image-jpeg.js /
// .shelly-agent-driver.js; in the repo they are scripts/shelly-*.js.
function sibling(name) {
  const prefix = path.basename(__filename).startsWith('.') ? '.' : '';
  return path.join(__dirname, `${prefix}${name}`);
}

function loadDriver() {
  return require(sibling('shelly-agent-driver.js'));
}

let jpegCodec = null;
function jpeg() {
  if (!jpegCodec) jpegCodec = require(sibling('shelly-image-jpeg.js'));
  return jpegCodec;
}

// ─── Arguments ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const options = { style: null, subject: null, out: null, model: null, timeoutMs: DEFAULT_TIMEOUT_MS, waitMs: DEFAULT_WAIT_MS, help: false, canary: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new UsageError(`missing value for ${arg}`);
      i += 1;
      return argv[i];
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--style') options.style = next();
    else if (arg === '--subject') options.subject = next();
    else if (arg === '--out') options.out = next();
    else if (arg === '--canary') options.canary = true;
    else if (arg === '--model') options.model = next();
    else if (arg === '--timeout-ms') options.timeoutMs = boundedInt(next(), arg, 10 * 1000, MAX_TIMEOUT_MS);
    else if (arg === '--wait-ms') options.waitMs = boundedInt(next(), arg, 0, 60 * 60 * 1000);
    else throw new UsageError(`unknown argument: ${String(arg).slice(0, 40)}`);
  }
  if (options.help) return options;
  if (options.model !== null && !MODEL_RE.test(options.model)) throw new UsageError('invalid --model');
  if (options.canary) {
    if (options.style || options.subject !== null || options.out) throw new UsageError('--canary takes no --style, --subject or --out');
    return options;
  }
  if (!options.style) throw new UsageError('missing --style');
  if (options.subject === null) throw new UsageError('missing --subject');
  if (!options.out) throw new UsageError('missing --out');
  return options;
}

function boundedInt(value, label, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`invalid ${label}: expected ${min}..${max}`);
  return n;
}

// ─── Output path: a .jpg in $TMPDIR, no symlinks on the way ───────────────
function insideOrEqual(root, target) {
  const rel = path.relative(root, target);
  if (rel === '') return '';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

/** → {final, dir}; throws unless the file would land in $TMPDIR through real directories. */
function resolveOutPath(raw, env = process.env) {
  const tmp = env.TMPDIR;
  if (!tmp) throw new UsageError('$TMPDIR is not set');
  let root;
  try {
    root = fs.realpathSync(tmp);
    if (!fs.lstatSync(root).isDirectory()) throw new Error('not a directory');
  } catch (_) {
    throw new UsageError('$TMPDIR is not a usable directory');
  }
  if (typeof raw !== 'string' || !raw || /[\u0000-\u001f\u007f]/.test(raw)) throw new UsageError('invalid --out');
  const out = path.resolve(raw);
  const base = path.basename(out);
  if (!/\.(jpe?g)$/i.test(base) || base.startsWith('.') || base.length > 200) {
    throw new UsageError('--out must name a .jpg file (not hidden) in $TMPDIR');
  }
  const dir = path.dirname(out);
  const lexRel = [path.resolve(tmp), root].map((r) => insideOrEqual(r, dir)).find((rel) => rel !== null);
  if (lexRel === undefined) throw new UsageError('--out must be under $TMPDIR');
  let realDir;
  try {
    realDir = fs.realpathSync(dir);
  } catch (_) {
    throw new UsageError('the directory of --out does not exist');
  }
  if (path.join(root, lexRel) !== realDir || insideOrEqual(root, realDir) === null) {
    throw new UsageError('--out goes through a symlink');
  }
  if (!fs.lstatSync(realDir).isDirectory()) throw new UsageError('the directory of --out is not a directory');
  const final = path.join(realDir, base);
  let existing = null;
  try {
    existing = fs.lstatSync(final);
  } catch (_) {}
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new UsageError('--out exists and is not a regular file');
  return { final, dir: realDir };
}

// ─── Reading the raw image ────────────────────────────────────────────────
function readCapped(file, maxBytes) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('the image is not a regular file');
    if (st.size > maxBytes) throw new Error('the image is too large');
    const buf = Buffer.alloc(st.size);
    let total = 0;
    while (total < st.size) {
      const n = fs.readSync(fd, buf, total, st.size - total, null);
      if (n <= 0) break;
      total += n;
    }
    return buf.subarray(0, total);
  } finally {
    fs.closeSync(fd);
  }
}

// ─── Format checks ────────────────────────────────────────────────────────
function imageMagic(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  return null;
}

function checkDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < MIN_DIMENSION || height < MIN_DIMENSION) {
    throw new Error(`image is too small or has no size (${width}x${height})`);
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new Error(`image is too large (${width}x${height}; at most ${MAX_DIMENSION} px a side)`);
  }
}

/** Width and height from the JPEG frame header, before any decoding. */
function jpegSize(buf) {
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) throw new Error('JPEG: bad marker');
    let marker = buf[pos + 1];
    while (marker === 0xff && pos + 2 < buf.length) {
      pos += 1;
      marker = buf[pos + 1];
    }
    pos += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    if (pos + 2 > buf.length) break;
    const len = buf.readUInt16BE(pos);
    if (len < 2 || pos + len > buf.length) throw new Error('JPEG: truncated segment');
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (len < 8) throw new Error('JPEG: short frame header');
      return { height: buf.readUInt16BE(pos + 3), width: buf.readUInt16BE(pos + 5) };
    }
    pos += len;
  }
  throw new Error('JPEG: no frame header');
}

// ─── PNG decoding (node's zlib; no dependency) ────────────────────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf, start, end) {
  let c = -1;
  for (let i = start; i < end; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
// 8-bit (and smaller) only: a 16-bit image is refused, not converted.
const PNG_DEPTHS = { 0: [1, 2, 4, 8], 2: [8], 3: [1, 2, 4, 8], 4: [8], 6: [8] };

function pngHeader(buf) {
  if (buf.length < 33) throw new Error('PNG: truncated');
  if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') throw new Error('PNG: IHDR missing');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** → {width, height, data: RGBA Uint8Array}. Size-checked before inflating. */
function decodePng(buf) {
  let pos = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (len > buf.length - pos - 12) throw new Error('PNG: truncated chunk');
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (crc32(buf, pos + 4, dataEnd) !== buf.readUInt32BE(dataEnd)) throw new Error(`PNG: bad CRC in ${type.replace(/[^A-Za-z]/g, '?')}`);
    const data = buf.subarray(dataStart, dataEnd);
    pos = dataEnd + 4;
    if (type === 'IHDR') {
      if (ihdr || len !== 13) throw new Error('PNG: bad IHDR');
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
      checkDimensions(ihdr.width, ihdr.height);
      if (ihdr.depth === 16) throw new Error('PNG: 16-bit images are not supported');
      if (!PNG_DEPTHS[ihdr.colorType] || !PNG_DEPTHS[ihdr.colorType].includes(ihdr.depth)) throw new Error('PNG: unsupported colour type or depth');
      if (ihdr.compression !== 0 || ihdr.filter !== 0) throw new Error('PNG: unknown compression or filter method');
      if (ihdr.interlace !== 0) throw new Error('PNG: interlaced images are not supported');
    } else if (!ihdr) {
      throw new Error('PNG: IHDR is not first');
    } else if (type === 'PLTE') {
      if (len % 3 !== 0 || len === 0 || len > 768) throw new Error('PNG: bad palette');
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ihdr || !idat.length || !ended) throw new Error('PNG: incomplete');
  if (ihdr.colorType === 3 && !palette) throw new Error('PNG: palette missing');
  const channels = PNG_CHANNELS[ihdr.colorType];
  const bitsPerPixel = channels * ihdr.depth;
  const stride = Math.ceil((ihdr.width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const expected = ihdr.height * (stride + 1);
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch (error) {
    throw new Error(`PNG: image data does not inflate to its size (${error.code || error.message})`);
  }
  if (raw.length !== expected) throw new Error('PNG: image data has the wrong size');
  unfilter(raw, ihdr.height, stride, bpp);
  return { width: ihdr.width, height: ihdr.height, data: pngToRgba(raw, ihdr, stride, palette, trns) };
}

function unfilter(raw, height, stride, bpp) {
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const cur = rowStart + 1;
    const prev = cur - (stride + 1);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? raw[cur + x - bpp] : 0;
      const b = y > 0 ? raw[prev + x] : 0;
      const c = y > 0 && x >= bpp ? raw[prev + x - bpp] : 0;
      let v = raw[cur + x];
      if (filter === 0) continue;
      else if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else throw new Error('PNG: bad filter type');
      raw[cur + x] = v & 0xff;
    }
  }
}

function pngToRgba(raw, ihdr, stride, palette, trns) {
  const { width, height, depth, colorType } = ihdr;
  const out = new Uint8Array(width * height * 4);
  const channels = PNG_CHANNELS[colorType];
  const maxSample = (1 << depth) - 1;
  const sample = (row, index) => {
    // index-th sample in the row, scaled to 0..255; raw value for palettes.
    if (depth === 8) return raw[row + index];
    const bitPos = index * depth;
    const byte = raw[row + (bitPos >> 3)];
    return (byte >> (8 - depth - (bitPos & 7))) & maxSample;
  };
  const rawSample = sample;
  const scale = (v) => (depth >= 8 ? v : Math.round((v * 255) / maxSample));
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1) + 1;
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const i = x * channels;
      if (colorType === 3) {
        const idx = sample(row, i);
        if (idx * 3 + 2 >= palette.length) throw new Error('PNG: palette index out of range');
        out[o] = palette[idx * 3];
        out[o + 1] = palette[idx * 3 + 1];
        out[o + 2] = palette[idx * 3 + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 0 || colorType === 4) {
        const g = scale(sample(row, i));
        out[o] = g;
        out[o + 1] = g;
        out[o + 2] = g;
        if (colorType === 4) out[o + 3] = sample(row, i + 1);
        else out[o + 3] = trns && trns.length >= 2 && rawSample(row, i) === trns.readUInt16BE(0) ? 0 : 255;
      } else {
        out[o] = sample(row, i);
        out[o + 1] = sample(row, i + 1);
        out[o + 2] = sample(row, i + 2);
        if (colorType === 6) out[o + 3] = sample(row, i + 3);
        else {
          const transparent = trns && trns.length >= 6
            && rawSample(row, i) === trns.readUInt16BE(0)
            && rawSample(row, i + 1) === trns.readUInt16BE(2)
            && rawSample(row, i + 2) === trns.readUInt16BE(4);
          out[o + 3] = transparent ? 0 : 255;
        }
      }
    }
  }
  return out;
}

function decodeJpeg(buf) {
  const declared = jpegSize(buf);
  checkDimensions(declared.width, declared.height);
  const img = jpeg().decode(buf, {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: MAX_PIXELS / 1e6,
    maxMemoryUsageInMB: 256,
  });
  if (img.width !== declared.width || img.height !== declared.height) throw new Error('JPEG: decoded size does not match its header');
  return { width: img.width, height: img.height, data: img.data };
}

// ─── Crop, resize, encode ─────────────────────────────────────────────────
/** Centre crop to 3:2. → {x, y, w, h} */
function cropTo3x2(width, height) {
  if (width * 2 > height * 3) {
    const w = Math.round((height * 3) / 2);
    return { x: Math.floor((width - w) / 2), y: 0, w, h: height };
  }
  const h = Math.round((width * 2) / 3);
  return { x: 0, y: Math.floor((height - h) / 2), w: width, h };
}

// Triangle filter, widened when shrinking (an area average), bilinear when growing.
function filterWeights(srcLen, dstLen) {
  const scale = srcLen / dstLen;
  const support = Math.max(1, scale);
  const out = [];
  for (let i = 0; i < dstLen; i += 1) {
    const center = (i + 0.5) * scale - 0.5;
    const lo = Math.max(0, Math.ceil(center - support));
    const hi = Math.min(srcLen - 1, Math.floor(center + support));
    const idx = [];
    const w = [];
    let sum = 0;
    for (let s = lo; s <= hi; s += 1) {
      const weight = Math.max(0, 1 - Math.abs(s - center) / support);
      if (weight > 0) {
        idx.push(s);
        w.push(weight);
        sum += weight;
      }
    }
    if (sum === 0) {
      idx.push(Math.min(srcLen - 1, Math.max(0, Math.round(center))));
      w.push(1);
      sum = 1;
    }
    out.push({ idx, w: w.map((v) => v / sum) });
  }
  return out;
}

/** RGBA in, alpha flattened onto white, cropped and resized; → RGBA (alpha 255). */
function resizeRgba(img, crop, outW, outH) {
  const hx = filterWeights(crop.w, outW);
  const vy = filterWeights(crop.h, outH);
  const tmp = new Uint8ClampedArray(outW * crop.h * 3);
  for (let y = 0; y < crop.h; y += 1) {
    const srcRow = ((crop.y + y) * img.width + crop.x) * 4;
    for (let x = 0; x < outW; x += 1) {
      const { idx, w } = hx[x];
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < idx.length; k += 1) {
        const p = srcRow + idx[k] * 4;
        const a = img.data[p + 3] / 255;
        const white = 255 * (1 - a);
        r += (img.data[p] * a + white) * w[k];
        g += (img.data[p + 1] * a + white) * w[k];
        b += (img.data[p + 2] * a + white) * w[k];
      }
      const t = (y * outW + x) * 3;
      tmp[t] = r;
      tmp[t + 1] = g;
      tmp[t + 2] = b;
    }
  }
  const out = Buffer.alloc(outW * outH * 4);
  for (let y = 0; y < outH; y += 1) {
    const { idx, w } = vy[y];
    for (let x = 0; x < outW; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < idx.length; k += 1) {
        const t = (idx[k] * outW + x) * 3;
        r += tmp[t] * w[k];
        g += tmp[t + 1] * w[k];
        b += tmp[t + 2] * w[k];
      }
      const o = (y * outW + x) * 4;
      out[o] = Math.min(255, Math.max(0, Math.round(r)));
      out[o + 1] = Math.min(255, Math.max(0, Math.round(g)));
      out[o + 2] = Math.min(255, Math.max(0, Math.round(b)));
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Untrusted image bytes → {jpeg: Buffer, width, height, source: {format, width, height}}. */
function normalizeImage(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length > MAX_INPUT_BYTES) throw new Error('image is too large');
  const format = imageMagic(buf);
  if (!format) throw new Error('not a PNG or JPEG (magic bytes)');
  if (format === 'png') {
    const { width, height } = pngHeader(buf);
    checkDimensions(width, height);
  }
  const img = format === 'png' ? decodePng(buf) : decodeJpeg(buf);
  const crop = cropTo3x2(img.width, img.height);
  const rgba = resizeRgba(img, crop, OUT_WIDTH, OUT_HEIGHT);
  // Encoded from pixels only: no EXIF, comments or ICC profile can survive.
  const encoded = jpeg().encode({ data: rgba, width: OUT_WIDTH, height: OUT_HEIGHT }, JPEG_QUALITY).data;
  const jpegBuf = Buffer.from(encoded);
  if (imageMagic(jpegBuf) !== 'jpeg' || jpegBuf[jpegBuf.length - 2] !== 0xff || jpegBuf[jpegBuf.length - 1] !== 0xd9) {
    throw new Error('JPEG encoding failed');
  }
  return { jpeg: jpegBuf, width: OUT_WIDTH, height: OUT_HEIGHT, source: { format, width: img.width, height: img.height } };
}

// ─── Locks (shared with shelly-plan-executor.js) ──────────────────────────
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function procStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return /^\d+$/.test(fields[19] || '') ? fields[19] : '';
  } catch (_) {
    return '';
  }
}

function lockHolderAlive(file) {
  let holder;
  try {
    holder = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    try {
      return Date.now() - fs.lstatSync(file).mtimeMs < 10 * 1000;
    } catch (__) {
      return false;
    }
  }
  if (!holder || !Number.isInteger(holder.pid) || holder.pid <= 1) return false;
  try {
    process.kill(holder.pid, 0);
  } catch (_) {
    return false;
  }
  const start = procStartTime(holder.pid);
  return !start || !holder.start || start === holder.start;
}

function tryTakeEngineLock(file) {
  const record = JSON.stringify({ pid: process.pid, start: procStartTime(process.pid) || '' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, record, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    if (lockHolderAlive(file)) return false;
    // Dead holder: move it aside (see removeDeadTextOnlyEngineLock in the executor).
    const aside = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`;
    try {
      fs.renameSync(file, aside);
    } catch (_) {
      continue;
    }
    if (lockHolderAlive(aside)) {
      try {
        fs.renameSync(aside, file);
      } catch (_) {}
      return false;
    }
    try {
      fs.unlinkSync(aside);
    } catch (_) {}
  }
  return false;
}

function releaseEngineLock(file) {
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file);
  } catch (_) {}
}

/** Takes the Codex engine lock and publishes a pid lock. → release(). Throws BusyError. */
function acquireLocks(home, waitMs) {
  const agentsDir = path.join(home, '.shelly', 'agents');
  const locksDir = path.join(agentsDir, 'locks');
  const halted = () => fs.existsSync(path.join(agentsDir, '.halted'));
  if (halted()) throw new BusyError('agents are stopped (STOP-ALL); resume them in Shelly first');
  fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  const engineLock = path.join(locksDir, 'text-only-codex.slot');
  const giveUpAt = Date.now() + waitMs;
  while (!tryTakeEngineLock(engineLock)) {
    if (Date.now() >= giveUpAt) throw new BusyError('Codex is busy with another agent step; try again later');
    if (halted()) throw new BusyError('agents were stopped (STOP-ALL)');
    sleepMs(Math.min(LOCK_POLL_MS, Math.max(1, giveUpAt - Date.now())));
  }
  const pidLock = path.join(locksDir, `image-${process.pid}.pid`);
  try {
    const start = procStartTime(process.pid);
    if (start) {
      fs.mkdirSync(`${pidLock}.lockdir`, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(`${pidLock}.lockdir`, 'starttime'), `${start}\n`, { mode: 0o600 });
    }
    fs.writeFileSync(pidLock, `${process.pid}\n`, { mode: 0o600 });
  } catch (_) {}
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (fs.readFileSync(pidLock, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidLock);
    } catch (_) {}
    try {
      fs.rmSync(`${pidLock}.lockdir`, { recursive: true, force: true });
    } catch (_) {}
    releaseEngineLock(engineLock);
  };
  process.once('exit', release);
  return release;
}

// ─── Work directory ───────────────────────────────────────────────────────
function makeWorkDir(tmpRoot) {
  try {
    for (const name of fs.readdirSync(tmpRoot)) {
      if (!name.startsWith(WORK_PREFIX) || !/^shelly-image-[A-Za-z0-9]{6}$/.test(name)) continue;
      const dir = path.join(tmpRoot, name);
      const st = fs.lstatSync(dir);
      if (st.isDirectory() && !st.isSymbolicLink() && Date.now() - st.mtimeMs > WORK_STALE_MS) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (_) {}
  sweepTempFiles(tmpRoot);
  const dir = fs.mkdtempSync(path.join(tmpRoot, WORK_PREFIX));
  fs.chmodSync(dir, 0o700);
  return fs.realpathSync(dir);
}

/** Removes our own `.shelly-image-<pid>-<hex>.tmp` files left by a killed run. */
function sweepTempFiles(dir) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!TEMP_FILE_RE.test(name)) continue;
      const file = path.join(dir, name);
      const st = fs.lstatSync(file);
      if (st.isFile() && !st.isSymbolicLink() && Date.now() - st.mtimeMs > WORK_STALE_MS) fs.unlinkSync(file);
    }
  } catch (_) {}
}

// ─── Running the driver ───────────────────────────────────────────────────
function driverInvocation(driverPath, args, env) {
  const libDir = env.SHELLY_LIB_DIR || '';
  const androidNode = libDir ? path.join(libDir, 'node') : '';
  if (androidNode && fs.existsSync(androidNode) && fs.existsSync('/system/bin/linker64')) {
    return { file: '/system/bin/linker64', args: [androidNode, driverPath, ...args] };
  }
  return { file: process.execPath, args: [driverPath, ...args] };
}

function driverEnv(env) {
  const out = { ...env };
  // The worker's Codex is the reviewed one: no path override.
  delete out.SHELLY_CODEX_TUI_PATH;
  // Breaks node's OpenSSL config load on the phone (see the executor's childEnv).
  delete out.LD_PRELOAD;
  return out;
}

function runImageDriver({ style, subject, model, timeoutMs, rawPath, workDir, env, canary = false }) {
  const driverPath = sibling('shelly-agent-driver.js');
  if (!fs.existsSync(driverPath)) throw new Error(`${driverPath} is missing; restart Shelly to reinstall it`);
  const args = [
    ...(canary ? ['--image-canary'] : ['--image-only', '--image-style', style, '--image-subject', subject, '--image-out', rawPath]),
    '--cwd', workDir,
    '--agent-id', 'shelly-image',
    '--run-id', crypto.randomUUID(),
    '--timeout-ms', String(timeoutMs),
    ...(model ? ['--text-only-model', model] : []),
  ];
  const inv = driverInvocation(driverPath, args, env);
  // Host tests only: the driver's stand-in app-server is a node script.
  if (inv.file === process.execPath && env.SHELLY_TEST_CODEX_SCRIPT) inv.args.push('--codex-bin', process.execPath);
  const r = spawnSync(inv.file, inv.args, {
    env: driverEnv(env),
    cwd: workDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs + 30 * 1000,
    killSignal: 'SIGTERM',
    maxBuffer: 16 * 1024 * 1024,
  });
  const lines = String(r.stdout || '').split('\n');
  const errors = lines.filter((l) => l.startsWith('CODEX_ERROR ')).map((l) => l.slice(12).slice(0, 300)).slice(0, 5);
  const canaryLine = lines.filter((l) => l.startsWith('IMAGE_CANARY ')).map((l) => l.slice(0, 300)).pop() || null;
  const stderr = String(r.stderr || '').trim().split('\n').filter(Boolean).slice(-3).map((l) => l.slice(0, 300));
  return { status: r.status, signal: r.signal, error: r.error, errors, stderr, canaryLine };
}

/** The canary run: → the driver's IMAGE_CANARY line (PASS or FAIL). */
function canary(options, env = process.env) {
  const home = env.HOME;
  if (!home) throw new Error('HOME is not set');
  if (!env.TMPDIR) throw new UsageError('$TMPDIR is not set');
  const release = acquireLocks(home, options.waitMs);
  const workDir = makeWorkDir(fs.realpathSync(env.TMPDIR));
  try {
    const run = runImageDriver({ model: options.model, timeoutMs: options.timeoutMs, workDir, env, canary: true });
    const line = run.canaryLine || `IMAGE_CANARY FAIL ${run.errors.join(' / ') || run.stderr.join(' / ') || `driver exit ${run.status}`}`;
    return { pass: run.status === 0 && line.startsWith('IMAGE_CANARY PASS'), line };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (_) {}
    release();
  }
}

function generate(options, env = process.env) {
  const driver = loadDriver();
  if (!Object.prototype.hasOwnProperty.call(driver.IMAGE_STYLES, options.style)) {
    throw new UsageError(`unknown --style: expected one of ${Object.keys(driver.IMAGE_STYLES).join(', ')}`);
  }
  const subject = driver.sanitizeImageSubject(options.subject);
  if (!subject) throw new UsageError('--subject is empty after removing URLs, markup and control characters');
  const out = resolveOutPath(options.out, env);
  sweepTempFiles(out.dir);
  const home = env.HOME;
  if (!home) throw new Error('HOME is not set');
  const release = acquireLocks(home, options.waitMs);
  const workDir = makeWorkDir(fs.realpathSync(env.TMPDIR));
  try {
    const rawPath = path.join(workDir, 'raw.img');
    const run = runImageDriver({ style: options.style, subject, model: options.model, timeoutMs: options.timeoutMs, rawPath, workDir, env });
    if (run.status !== 0 || !fs.existsSync(rawPath)) {
      const why = run.errors.length ? run.errors.join(' / ') : run.error ? run.error.message : run.stderr.join(' / ') || `driver exit ${run.status === null ? run.signal : run.status}`;
      throw new Error(`no image: ${why}`);
    }
    const normalized = normalizeImage(readCapped(rawPath, MAX_INPUT_BYTES));
    const temp = path.join(out.dir, `.shelly-image-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeSync(fd, normalized.jpeg);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, out.final);
    return {
      path: out.final,
      sha256: crypto.createHash('sha256').update(normalized.jpeg).digest('hex'),
      width: normalized.width,
      height: normalized.height,
      bytes: normalized.jpeg.length,
    };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (_) {}
    release();
  }
}

/** Always exits: 0 done, 1 failed, 2 usage, 75 busy. */
function main(argv, env = process.env) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log(USAGE.replace('STYLES', Object.keys(loadDriver().IMAGE_STYLES).join(', ')));
      process.exit(0);
    }
    if (options.canary) {
      const result = canary(options, env);
      process.stdout.write(`${result.line}\n`);
      process.exit(result.pass ? 0 : 1);
    }
    const result = generate(options, env);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (e) {
    console.error(`shelly image: ${e && e.message ? e.message : e}`);
    process.exit(e instanceof UsageError ? 2 : e instanceof BusyError ? EXIT_BUSY : 1);
  }
}

module.exports = {
  OUT_WIDTH,
  OUT_HEIGHT,
  JPEG_QUALITY,
  MAX_DIMENSION,
  MAX_PIXELS,
  MAX_INPUT_BYTES,
  EXIT_BUSY,
  parseArgs,
  resolveOutPath,
  imageMagic,
  jpegSize,
  decodePng,
  decodeJpeg,
  cropTo3x2,
  normalizeImage,
  acquireLocks,
  driverEnv,
  generate,
  canary,
  main,
};

if (require.main === module) main(process.argv.slice(2));
