'use strict';
/**
 * `shelly save-draft`: queues one article for ClosePaw's fixed draft routine.
 * Native side: ClosePawDrafts.kt. Extracted to $HOME/.shelly-save-draft.js on
 * every launch, so a private script can also run it with `node`.
 *
 * This file only builds and queues. Nothing leaves the phone from here, and a
 * queued item has no authority: Shelly sends it after the owner approves the
 * batch on the phone. Same-uid processes can write the queue directly, so
 * ClosePaw's ArticleHtmlPolicy, not this file, is the check that holds for a
 * forged item.
 *
 * Article text is hostile (it may derive from web research) and the HTML lands
 * in the owner's signed-in editor. Markdown is parsed, never passed through:
 * every character of source text is escaped, and only this file emits tags. A
 * link or image ClosePaw would refuse keeps its text, so one bad URL in an
 * article costs that URL and not the whole draft.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Lockstep with ClosePaw's SaveDraftRequestParser and ClosePawDrafts.kt.
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TITLE_CHARS = 300;
const MAX_HTML_CHARS = 1024 * 1024;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_IMAGE_HOSTS = 8;

const MAX_MARKDOWN_BYTES = 1024 * 1024;
const MAX_QUEUED = 16;
const MAX_INLINE_DEPTH = 4;
const MAX_QUOTE_DEPTH = 4;
const MAX_LINK_SCAN_CHARS = 1024;
// Worst case after escaping stays under ClosePaw's 4096 characters per tag.
const MAX_URL_ATTRIBUTE_CHARS = 2048;
const MAX_ALT_CHARS = 256;

const QUEUE_PREFIX = '.shelly-draft-req-';
const QUEUE_FILE_RE = /^\.shelly-draft-req-[0-9]{10,16}-[0-9a-f]{8}$/;
const DESTINATIONS_REL_PATH = '.shelly/agents/draft-destinations.json';
const SUBDOMAIN_RE = /^[a-z0-9-]{1,63}$/;
const IMAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Keeps \t, \n and \r for the block parser; everything else in C0/C1 goes.
const SOURCE_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const TITLE_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
// What ClosePaw refuses inside an attribute value besides `<` and `>`.
const VALUE_REFUSED_RE = /[\p{Cc}\p{Cf}\p{Z}]/u;
const ALT_CLEAN_RE = /[\p{Cc}\p{Cf}\p{Z}]+/gu;

// The rest of this block is a port of ClosePaw's ArticleHtmlPolicy (8d094985).
// __tests__/fixtures/closepaw-html-policy-cases.json holds verdicts from the real
// Kotlin, so a change on either side shows up as a failing test.
const HTML_SPACE = ' \t\n\f\r';
const MAX_TAG_CHARS = 4096;
const MAX_ATTRIBUTES = 4;
const MAX_HOST_CHARS = 253;
const BARE_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i',
  'blockquote', 'pre', 'code', 'br', 'hr', 'figure', 'figcaption',
]);
const TAG_ATTRIBUTES = { a: new Set(['href']), img: new Set(['src', 'alt']) };
const SIGNED_IN_ROOTS = ['substack.com', 'note.com'];
const SUBSTACK_ARTICLE_PATH = /^\/p\/[a-z0-9-]+\/?$/;
const NOTE_ARTICLE_PATH = /^\/[A-Za-z0-9_]+\/n\/n[a-z0-9]+\/?$/;

function isAsciiLetter(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

function isAllowedInValue(c) {
  if (c === ' ') return true;
  if (c === '<' || c === '>') return false;
  return !VALUE_REFUSED_RE.test(c);
}

/** Reads one tag at the `<` at `start`. Null for anything but the strict form. */
function scanTag(html, start) {
  const limit = Math.min(html.length, start + MAX_TAG_CHARS);
  let i = start + 1;
  const closing = i < limit && html[i] === '/';
  if (closing) i += 1;
  const nameStart = i;
  while (i < limit && (isAsciiLetter(html[i]) || (html[i] >= '0' && html[i] <= '9'))) i += 1;
  if (i === nameStart || !isAsciiLetter(html[nameStart])) return null;
  const name = html.slice(nameStart, i).toLowerCase();

  const attributes = new Map();
  for (;;) {
    const beforeSpace = i;
    while (i < limit && HTML_SPACE.includes(html[i])) i += 1;
    if (i >= limit) return null;
    if (html[i] === '>') return { name, closing, attributes, end: i + 1 };
    if (html[i] === '/') return i + 1 < limit && html[i + 1] === '>' ? { name, closing, attributes, end: i + 2 } : null;
    if (i === beforeSpace || attributes.size === MAX_ATTRIBUTES) return null;

    const keyStart = i;
    while (i < limit && (isAsciiLetter(html[i]) || html[i] === '-')) i += 1;
    const key = html.slice(keyStart, i).toLowerCase();
    if (key === '' || attributes.has(key)) return null;
    if (i + 1 >= limit || html[i] !== '=' || html[i + 1] !== '"') return null;
    i += 2;

    const valueStart = i;
    while (i < limit && html[i] !== '"') {
      if (!isAllowedInValue(html[i])) return null;
      i += 1;
    }
    if (i >= limit) return null;
    attributes.set(key, html.slice(valueStart, i));
    i += 1;
  }
}

function isHostLabel(label) {
  return label !== '' && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-') && /^[a-z0-9-]+$/.test(label);
}

function isOrdinaryHost(host) {
  if (host === '' || host.length > MAX_HOST_CHARS) return false;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every(isHostLabel)) return false;
  return /[a-z]/.test(labels[labels.length - 1]);
}

function isSignedInHost(host) {
  return SIGNED_IN_ROOTS.some((root) => host === root || host.endsWith(`.${root}`));
}

function isAllowableImageHost(host) {
  return isOrdinaryHost(host) && !isSignedInHost(host);
}

/** Strict reading of an attribute value, as written in the HTML. */
function parseUrl(raw) {
  if (!raw.startsWith('https://')) return null;
  for (const c of raw.split('')) {
    if (c === '\\' || c === "'" || c === '"' || c === '`' || c < '!' || c > '~') return null;
  }
  const decoded = raw.split('&amp;').join('\u0000');
  if (decoded.includes('&')) return null;
  const rest = decoded.slice('https://'.length);
  const hostEnd = rest.search(/[/?#]/);
  const host = hostEnd < 0 ? rest : rest.slice(0, hostEnd);
  if (!isOrdinaryHost(host)) return null;
  const tail = hostEnd < 0 ? '' : rest.slice(hostEnd);
  const pathEnd = tail.search(/[?#]/);
  return {
    host,
    path: pathEnd < 0 ? tail : tail.slice(0, pathEnd),
    hasQueryOrFragment: pathEnd >= 0,
  };
}

function isPlainArticleLink(url) {
  if (url.hasQueryOrFragment) return false;
  if (url.host === 'note.com') return NOTE_ARTICLE_PATH.test(url.path);
  if (url.host.endsWith('.substack.com')) return SUBSTACK_ARTICLE_PATH.test(url.path);
  return false;
}

function isAllowedLink(url) {
  return !isSignedInHost(url.host) || isPlainArticleLink(url);
}

function isAllowedImage(url, platform, imageHosts) {
  return platform === 'substack' && imageHosts.includes(url.host) && isAllowableImageHost(url.host);
}

function tagRejection(tag, platform, imageHosts) {
  if (!BARE_TAGS.has(tag.name) && !TAG_ATTRIBUTES[tag.name]) return 'html-tag-not-allowed';
  if (tag.closing) return tag.attributes.size === 0 ? null : 'html-tag-not-allowed';
  const allowed = TAG_ATTRIBUTES[tag.name] || new Set();
  for (const key of tag.attributes.keys()) {
    if (!allowed.has(key)) return 'html-tag-not-allowed';
  }
  if (tag.name === 'img') {
    if (platform !== 'substack' || !tag.attributes.has('src')) return 'html-image-not-allowed';
    const url = parseUrl(tag.attributes.get('src'));
    return url && isAllowedImage(url, platform, imageHosts) ? null : 'html-image-not-allowed';
  }
  if (tag.name === 'a') {
    const url = tag.attributes.has('href') ? parseUrl(tag.attributes.get('href')) : null;
    return url && isAllowedLink(url) ? null : 'html-link-not-allowed';
  }
  return null;
}

/** Null when acceptable. Runs on our own output and fails closed on a bug here. */
function htmlRejection(html, platform = 'note', imageHosts = []) {
  let at = 0;
  let hasText = false;
  while (at < html.length) {
    const open = html.indexOf('<', at);
    const textEnd = open < 0 ? html.length : open;
    if (/\S|\ufeff/.test(html.slice(at, textEnd))) hasText = true;
    if (open < 0) break;
    const tag = scanTag(html, open);
    if (!tag) return 'html-unreadable-tag';
    const rejected = tagRejection(tag, platform, imageHosts);
    if (rejected) return rejected;
    at = tag.end;
  }
  return hasText ? null : 'html-no-text';
}

/** ClosePaw reads back fragments of the text and skips runs holding an entity. */
function hasReadBackSample(html) {
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf('<', at);
    const run = (open < 0 ? html.slice(at) : html.slice(at, open)).trim();
    if (run !== '' && !run.includes('&')) return true;
    if (open < 0) return false;
    const tag = scanTag(html, open);
    if (!tag) return false;
    at = tag.end;
  }
  return false;
}

// Rendering ------------------------------------------------------------------

function escapeText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(text) {
  return escapeText(text).replace(/"/g, '&quot;');
}

/** The attribute value for a URL ClosePaw can read, with its parsed form. */
function urlAttribute(raw) {
  const url = raw.replace(/^https:\/\/[^/?#]*/, (origin) => origin.toLowerCase());
  if (/[<>]/.test(url)) return null;
  const value = escapeAttribute(url);
  if (value.length > MAX_URL_ATTRIBUTE_CHARS) return null;
  const parsed = parseUrl(value);
  return parsed ? { value, parsed } : null;
}

/** `[label](url)` at `open` (the `[`), or null. The scan is bounded. */
function parseLink(text, open) {
  const limit = Math.min(text.length, open + MAX_LINK_SCAN_CHARS);
  let depth = 0;
  let close = -1;
  for (let i = open; i < limit; i += 1) {
    if (text[i] === '\\') {
      i += 1;
    } else if (text[i] === '[') {
      depth += 1;
    } else if (text[i] === ']') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0 || text[close + 1] !== '(') return null;
  const end = text.indexOf(')', close + 2);
  if (end < 0 || end - close > MAX_LINK_SCAN_CHARS) return null;
  const target = /^\s*(\S+?)(?:\s+"([^"]*)")?\s*$/.exec(text.slice(close + 2, end));
  if (!target) return null;
  return { label: text.slice(open + 1, close), url: target[1], title: target[2] || '', end: end + 1 };
}

/** Plain text of a label, for an image's alt or a link that was refused. */
function plainLabel(label) {
  return label.replace(/\\(.)/g, '$1').replace(/[*_`]/g, '');
}

function isSpace(ch) {
  return ch === undefined || /\s/.test(ch);
}

/** The `<img>` for a Markdown image, or null when this platform cannot take it. */
function imageTag(link, ctx) {
  const url = urlAttribute(link.url);
  if (!url || !isAllowedImage(url.parsed, ctx.platform, ctx.imageHosts)) return null;
  ctx.usedHosts.add(url.parsed.host);
  const alt = plainLabel(link.label).replace(ALT_CLEAN_RE, ' ').trim().slice(0, MAX_ALT_CHARS).replace(/[\ud800-\udbff]$/, '');
  return `<img src="${url.value}" alt="${escapeAttribute(alt)}">`;
}

function renderInline(text, depth, ctx) {
  if (depth > MAX_INLINE_DEPTH) return escapeText(text);
  let out = '';
  let plain = '';
  const flush = () => {
    out += escapeText(plain);
    plain = '';
  };
  const wrap = (tag, inner) => {
    flush();
    out += `<${tag}>${renderInline(inner, depth + 1, ctx)}</${tag}>`;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && /[\\`*_[\]()!#>~-]/.test(text[i + 1] || '')) {
      plain += text[i + 1];
      i += 2;
    } else if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end < 0) {
        plain += ch;
        i += 1;
      } else {
        flush();
        out += `<code>${escapeText(text.slice(i + 1, end))}</code>`;
        i = end + 1;
      }
    } else if (ch === '!' && text[i + 1] === '[') {
      const link = parseLink(text, i + 1);
      if (!link) {
        plain += ch;
        i += 1;
      } else {
        const image = imageTag(link, ctx);
        if (image) {
          flush();
          out += image;
        } else {
          ctx.droppedImages += 1;
          plain += plainLabel(link.label);
        }
        i = link.end;
      }
    } else if (ch === '[') {
      const link = parseLink(text, i);
      if (!link) {
        plain += ch;
        i += 1;
      } else {
        const url = urlAttribute(link.url);
        if (url && isAllowedLink(url.parsed)) {
          flush();
          out += `<a href="${url.value}">${renderInline(link.label, depth + 1, ctx)}</a>`;
        } else {
          ctx.droppedLinks += 1;
          plain += plainLabel(link.label);
        }
        i = link.end;
      }
    } else if ((ch === '*' || ch === '_') && text[i + 1] === ch) {
      const marker = ch + ch;
      const end = text.indexOf(marker, i + 2);
      if (end > i + 2 && !isSpace(text[i + 2]) && !isSpace(text[end - 1])) {
        wrap('strong', text.slice(i + 2, end));
        i = end + 2;
      } else {
        plain += marker;
        i += 2;
      }
    } else if (ch === '*' || ch === '_') {
      const end = text.indexOf(ch, i + 1);
      const opens = !isSpace(text[i + 1]) && (ch === '*' || i === 0 || !/[A-Za-z0-9]/.test(text[i - 1]));
      const closes = end > i + 1 && !isSpace(text[end - 1]) &&
        (ch === '*' || !/[A-Za-z0-9]/.test(text[end + 1] || ''));
      if (opens && closes) {
        wrap('em', text.slice(i + 1, end));
        i = end + 1;
      } else {
        plain += ch;
        i += 1;
      }
    } else {
      plain += ch;
      i += 1;
    }
  }
  flush();
  return out;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const RULE_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}>[ ]?/;
const LIST_RE = /^[ \t]*(?:([-*+])|(\d{1,9})[.)])[ \t]+(.*)$/;

/**
 * By hand: the obvious regex backtracks cubically over trailing spaces. Returns
 * `{ level, text }`, or null when the line is not a heading.
 */
function parseHeading(line) {
  let at = 0;
  while (at < 3 && line[at] === ' ') at += 1;
  let level = 0;
  while (line[at + level] === '#') level += 1;
  if (level < 1 || level > 6) return null;
  const isBlank = (c) => c === ' ' || c === '\t';
  if (!isBlank(line[at + level])) return null;
  let start = at + level;
  while (isBlank(line[start])) start += 1;
  let end = line.length;
  while (end > start && isBlank(line[end - 1])) end -= 1;
  while (end > start && line[end - 1] === '#') end -= 1;
  while (end > start && isBlank(line[end - 1])) end -= 1;
  return { level, text: line.slice(start, end) };
}

function startsBlock(line) {
  return FENCE_RE.test(line) || parseHeading(line) !== null || RULE_RE.test(line) ||
    QUOTE_RE.test(line) || LIST_RE.test(line);
}

function renderLoneImage(line, ctx) {
  if (!line.startsWith('![')) return null;
  const link = parseLink(line, 1);
  if (!link || link.end !== line.length) return null;
  const image = imageTag(link, ctx);
  if (!image) return null;
  const caption = link.title ? `<figcaption>${escapeText(link.title)}</figcaption>` : '';
  return `<figure>${image}${caption}</figure>`;
}

/** One paragraph's lines. A line ending in two spaces is a hard break. */
function renderParagraph(lines, ctx) {
  const figure = lines.length === 1 ? renderLoneImage(lines[0].trim(), ctx) : null;
  if (figure) return figure;
  const rendered = lines.map((line, index) => {
    const hardBreak = index < lines.length - 1 && line.endsWith('  ');
    return renderInline(line.trim(), 0, ctx) + (hardBreak ? '<br>' : '');
  }).join('\n');
  return rendered === '' ? '' : `<p>${rendered}</p>`;
}

function renderList(lines, start, ctx) {
  const ordered = LIST_RE.exec(lines[start])[2] !== undefined;
  const tag = ordered ? 'ol' : 'ul';
  const items = [];
  let i = start;
  while (i < lines.length) {
    const item = LIST_RE.exec(lines[i]);
    if (item) {
      // Deeper levels join this list: the output never needs nesting to be safe.
      if ((item[2] !== undefined) !== ordered) break;
      items.push([item[3]]);
      i += 1;
    } else if (lines[i].trim() === '' || startsBlock(lines[i])) {
      break;
    } else {
      items[items.length - 1].push(lines[i]);
      i += 1;
    }
  }
  const body = items.map((parts) => `<li>${renderInline(parts.map((p) => p.trim()).join(' '), 0, ctx)}</li>`).join('');
  return { html: `<${tag}>${body}</${tag}>`, next: i };
}

function renderBlocks(lines, quoteDepth, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);
    const heading = parseHeading(line);
    if (line.trim() === '') {
      i += 1;
    } else if (fence) {
      const marker = fence[1];
      const closeRe = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}[ \\t]*$`);
      const body = [];
      i += 1;
      while (i < lines.length && !closeRe.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(`<pre><code>${escapeText(body.join('\n'))}</code></pre>`);
    } else if (RULE_RE.test(line)) {
      out.push('<hr>');
      i += 1;
    } else if (heading) {
      const level = Math.min(heading.level, 4);
      out.push(`<h${level}>${renderInline(heading.text, 0, ctx)}</h${level}>`);
      i += 1;
    } else if (QUOTE_RE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        inner.push(lines[i].replace(QUOTE_RE, ''));
        i += 1;
      }
      out.push(quoteDepth < MAX_QUOTE_DEPTH
        ? `<blockquote>${renderBlocks(inner, quoteDepth + 1, ctx)}</blockquote>`
        : `<blockquote><p>${escapeText(inner.join(' '))}</p></blockquote>`);
    } else if (LIST_RE.test(line)) {
      const list = renderList(lines, i, ctx);
      out.push(list.html);
      i = list.next;
    } else {
      const paragraph = [];
      while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i])) {
        paragraph.push(lines[i]);
        i += 1;
      }
      const html = renderParagraph(paragraph, ctx);
      if (html !== '') out.push(html);
    }
  }
  return out.join('\n');
}

/**
 * `imageHosts` come from the device file, never from the article. Without one
 * (always on note) an image keeps only its alt text.
 */
function renderMarkdown(markdown, { platform = 'note', imageHosts = [] } = {}) {
  const ctx = { platform, imageHosts, usedHosts: new Set(), droppedImages: 0, droppedLinks: 0 };
  const source = String(markdown).replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(SOURCE_CONTROL_RE, '');
  const html = renderBlocks(source.split('\n'), 0, ctx);
  return { html, usedHosts: [...ctx.usedHosts], droppedImages: ctx.droppedImages, droppedLinks: ctx.droppedLinks };
}

function markdownToHtml(markdown, options) {
  return renderMarkdown(markdown, options).html;
}

function normalizeTitle(raw) {
  const title = String(raw).replace(/^﻿/, '').trim();
  if (title === '') throw new Error('the title is empty');
  if (title.length > MAX_TITLE_CHARS) throw new Error(`the title is longer than ${MAX_TITLE_CHARS} characters`);
  if (TITLE_CONTROL_RE.test(title)) throw new Error('the title must be one line with no control characters');
  return title;
}

function imageMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function imageName(filePath, index) {
  const base = path.basename(filePath).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64);
  return IMAGE_NAME_RE.test(base) ? base : `image-${index + 1}`;
}

function readLimited(filePath, maxBytes, label) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${filePath}`);
  if (stat.size > maxBytes) throw new Error(`${label} is larger than ${maxBytes} bytes: ${filePath}`);
  return fs.readFileSync(filePath);
}

function buildRequest({ title, markdown, images = [], platform = 'note', imageHosts = [] }) {
  const rendered = renderMarkdown(markdown, { platform, imageHosts });
  const { html } = rendered;
  if (html.length > MAX_HTML_CHARS) throw new Error(`the article is longer than ${MAX_HTML_CHARS} characters of HTML`);
  const rejected = htmlRejection(html, platform, rendered.usedHosts);
  if (rejected) throw new Error(`the article cannot be saved (${rejected})`);
  if (!hasReadBackSample(html)) throw new Error('the article has no plain text run ClosePaw can check after saving');
  const request = { version: 1, title: normalizeTitle(title), html };
  if (images.length > 0) request.images = images;
  if (rendered.usedHosts.length > 0) request.image_hosts = rendered.usedHosts;
  const text = JSON.stringify(request);
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new Error(`the request is larger than ${MAX_FILE_BYTES} bytes`);
  return { text, droppedImages: rendered.droppedImages, droppedLinks: rendered.droppedLinks };
}

function loadImages(paths) {
  if (paths.length > MAX_IMAGES) throw new Error(`at most ${MAX_IMAGES} images`);
  return paths.map((filePath, index) => {
    const bytes = readLimited(filePath, MAX_IMAGE_BYTES, 'the image');
    if (bytes.length === 0) throw new Error(`the image is empty: ${filePath}`);
    const mime = imageMime(bytes);
    if (!mime) throw new Error(`not a JPEG, PNG, WebP or GIF image: ${filePath}`);
    return { name: imageName(filePath, index), mime, base64: bytes.toString('base64') };
  });
}

/**
 * `{"version":1,"substack_subdomains":["name"],"image_hosts":["host"]}`. Written
 * by the owner; the gate refuses agent workers. The lists decide, a queue item
 * only selects. An `img` is fetched with cookies as soon as the editor parses it,
 * which is why its hosts live here and not on the command line.
 */
function parseDestinations(text) {
  const root = JSON.parse(text);
  const known = ['version', 'substack_subdomains', 'image_hosts'];
  const keys = root && typeof root === 'object' ? Object.keys(root) : [];
  if (!keys.every((key) => known.includes(key)) || root.version !== 1) throw new Error('unsupported format');
  const subdomains = root.substack_subdomains === undefined ? [] : root.substack_subdomains;
  if (!Array.isArray(subdomains) || !subdomains.every((name) => typeof name === 'string' && SUBDOMAIN_RE.test(name))) {
    throw new Error('substack_subdomains must be a list of subdomains');
  }
  const imageHosts = root.image_hosts === undefined ? [] : root.image_hosts;
  if (!Array.isArray(imageHosts) || imageHosts.length > MAX_IMAGE_HOSTS ||
      !imageHosts.every((host) => typeof host === 'string' && isAllowableImageHost(host))) {
    throw new Error(`image_hosts must be up to ${MAX_IMAGE_HOSTS} exact hosts, none of them a signed-in site`);
  }
  return { subdomains, imageHosts };
}

/** Every component is checked, as ClosePawDrafts.kt does; a linked parent is refused. */
function loadDestinations(home) {
  const file = path.join(home, DESTINATIONS_REL_PATH);
  const parts = DESTINATIONS_REL_PATH.split('/');
  try {
    let at = home;
    parts.forEach((part, index) => {
      at = path.join(at, part);
      const stat = fs.lstatSync(at);
      const expected = index === parts.length - 1 ? stat.isFile() : stat.isDirectory();
      if (!expected) throw new Error(`${DESTINATIONS_REL_PATH} must not go through a link`);
    });
  } catch (e) {
    if (e && e.code === 'ENOENT') return { subdomains: [], imageHosts: [] };
    throw e;
  }
  try {
    return parseDestinations(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${DESTINATIONS_REL_PATH}: ${e.message}`);
  }
}

/** The selector if allowed, null when the one allowed subdomain applies. */
function checkSubdomain(selector, allowed) {
  if (selector) {
    if (!allowed.includes(selector)) throw new Error(`"${selector}" is not in ${DESTINATIONS_REL_PATH}`);
    return selector;
  }
  if (allowed.length !== 1) throw new Error(`name one of the subdomains in ${DESTINATIONS_REL_PATH} with --substack`);
  return null;
}

function queuedCount(home) {
  return fs.readdirSync(home).filter((name) => QUEUE_FILE_RE.test(name)).length;
}

/** One file per draft: a meta line, then the request ClosePaw reads. */
function writeQueueItem(home, meta, requestText) {
  const target = path.join(home, QUEUE_PREFIX + meta.reqId);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(meta)}\n${requestText}`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, target);
}

function queueDraft({ home, platform, substack, title, markdown, imagePaths = [], now = Date.now() }) {
  if (platform !== 'note' && platform !== 'substack') throw new Error('--platform must be note or substack');
  const meta = { version: 1, reqId: `${now}-${crypto.randomBytes(4).toString('hex')}`, platform };
  let imageHosts = [];
  if (platform === 'substack') {
    if (imagePaths.length > 0) throw new Error(`--image is for note; on Substack use image URLs from image_hosts in ${DESTINATIONS_REL_PATH}`);
    const destinations = loadDestinations(home);
    const selector = checkSubdomain(substack, destinations.subdomains);
    if (selector) meta.substack = selector;
    imageHosts = destinations.imageHosts;
  } else if (substack) {
    throw new Error('--substack applies to --platform substack only');
  }
  const request = buildRequest({ title, markdown, images: loadImages(imagePaths), platform, imageHosts });
  if (queuedCount(home) >= MAX_QUEUED) throw new Error(`${MAX_QUEUED} drafts are already waiting`);
  writeQueueItem(home, meta, request.text);
  return { reqId: meta.reqId, droppedImages: request.droppedImages, droppedLinks: request.droppedLinks };
}

const USAGE = `Usage: shelly save-draft --platform note|substack --title-file FILE --markdown-file FILE
                         [--substack SUBDOMAIN] [--image FILE]...

Queues one article. After the next unlock Shelly asks you to approve the waiting
drafts on the phone; once approved, ClosePaw saves each one as a draft. Nothing
is published. HTML in the Markdown is shown as text.

  --platform       note or substack
  --title-file     UTF-8 file with the title on one line (300 characters at most)
  --markdown-file  UTF-8 Markdown file
  --substack       which subdomain, when ${DESTINATIONS_REL_PATH} lists several
  --image          image for note, up to 4, 6 MiB each (repeat the flag)

Images written in the Markdown are kept on Substack only, from image_hosts in that
file. Other images, and links ClosePaw refuses, keep their text. The command says
how many it changed.

Follow a request with: shelly closepaw status <requestId>`;

function parseArgs(argv) {
  const options = { imagePaths: [] };
  const single = { '--platform': 'platform', '--title-file': 'titleFile', '--markdown-file': 'markdownFile', '--substack': 'substack' };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag !== '--image' && !single[flag]) throw new Error(`unknown option ${flag}`);
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--image') {
      options.imagePaths.push(value);
    } else if (options[single[flag]] !== undefined) {
      throw new Error(`${flag} was given twice`);
    } else {
      options[single[flag]] = value;
    }
  }
  if (!options.platform || !options.titleFile || !options.markdownFile) {
    throw new Error('--platform, --title-file and --markdown-file are required');
  }
  return options;
}

function main(argv, env = process.env) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log(USAGE);
      process.exit(0);
    }
    const home = env.HOME;
    if (!home) throw new Error('HOME is not set');
    const queued = queueDraft({
      home,
      platform: options.platform,
      substack: options.substack,
      title: readLimited(options.titleFile, MAX_TITLE_CHARS * 4 + 8, 'the title file').toString('utf8'),
      markdown: readLimited(options.markdownFile, MAX_MARKDOWN_BYTES, 'the Markdown file').toString('utf8'),
      imagePaths: options.imagePaths,
    });
    console.log(`Queued draft ${queued.reqId}. Shelly asks you to approve it on the phone after the next unlock.`);
    if (queued.droppedImages > 0 || queued.droppedLinks > 0) {
      console.log(`Kept as text only: ${queued.droppedImages} image(s) and ${queued.droppedLinks} link(s) ClosePaw would refuse.`);
    }
    process.exit(0);
  } catch (e) {
    console.error(`shelly save-draft: ${e && e.message ? e.message : e}`);
    process.exit(1);
  }
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_HTML_CHARS,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_HOSTS,
  MAX_QUEUED,
  MAX_TITLE_CHARS,
  QUEUE_PREFIX,
  buildRequest,
  checkSubdomain,
  htmlRejection,
  hasReadBackSample,
  imageMime,
  imageName,
  isAllowableImageHost,
  loadDestinations,
  loadImages,
  main,
  markdownToHtml,
  normalizeTitle,
  parseArgs,
  parseDestinations,
  queueDraft,
  renderMarkdown,
};

if (require.main === module) main(process.argv.slice(2));
