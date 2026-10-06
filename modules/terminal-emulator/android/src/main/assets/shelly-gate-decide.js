// lib/redact-secrets.ts
var SECRET_PATTERNS = [
  { label: "OpenAI API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: "OpenAI project key", pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g },
  { label: "Anthropic token", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{25,}\b/g },
  { label: "Groq API key", pattern: /\bgsk_[A-Za-z0-9_-]{20,}\b/g },
  { label: "Cerebras API key", pattern: /\bcsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { label: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    label: "named secret",
    pattern: /\b([A-Z0-9_]*(?:API[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|SECRET)[A-Z0-9_]*)\s*=\s*(['"]?)[^\s'"]{8,}\2/gi
  }
];
function redactString(input) {
  let out = input;
  for (const { label, pattern } of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, name) => {
      if (label === "named secret" && typeof name === "string") {
        return `${name}=<redacted>`;
      }
      const tail = match.length >= 4 ? match.slice(-4) : "";
      return `<redacted:${label}${tail ? `:...${tail}` : ""}>`;
    });
  }
  return out;
}
function redactSecrets(value) {
  if (typeof value === "string") return redactString(value);
  if (value == null) return value;
  if (value instanceof Error) {
    const redacted = new Error(redactString(value.message));
    redacted.name = value.name;
    if (value.stack) redacted.stack = redactString(value.stack);
    return redacted;
  }
  try {
    return redactString(JSON.stringify(value));
  } catch {
    return "<redacted:unserializable>";
  }
}

// lib/command-safety.ts
var DANGER_PATTERNS = [
  // ── CRITICAL: システム破壊・データ全損 ──────────────────────────────────────
  {
    pattern: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|~\/?\s*$|\/\*|~\/\*)/i,
    // NOTE: `rm -r -f ...` / `rm -f -r ...` (flags split across separate
    // tokens) are normalized to a single combined flag token by
    // mergeSeparatedRmFlags() before this pattern runs — see below.
    level: "CRITICAL",
    reason: "\u30EB\u30FC\u30C8\u30C7\u30A3\u30EC\u30AF\u30C8\u30EA\u307E\u305F\u306F\u30DB\u30FC\u30E0\u30C7\u30A3\u30EC\u30AF\u30C8\u30EA\u3092\u518D\u5E30\u7684\u306B\u524A\u9664\u3057\u307E\u3059\u3002\u30B7\u30B9\u30C6\u30E0\u304C\u8D77\u52D5\u4E0D\u80FD\u306B\u306A\u308B\u53EF\u80FD\u6027\u304C\u3042\u308A\u307E\u3059\u3002"
  },
  {
    pattern: /rm\s+-rf\s+\/(?:usr|bin|lib|etc|boot|sys|proc|dev|sbin)/i,
    level: "CRITICAL",
    reason: "\u30B7\u30B9\u30C6\u30E0\u30C7\u30A3\u30EC\u30AF\u30C8\u30EA\u3092\u524A\u9664\u3057\u307E\u3059\u3002OS\u304C\u7834\u58CA\u3055\u308C\u307E\u3059\u3002"
  },
  {
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/,
    level: "CRITICAL",
    reason: "\u30D5\u30A9\u30FC\u30AF\u7206\u5F3E\u3067\u3059\u3002\u30B7\u30B9\u30C6\u30E0\u304C\u30D5\u30EA\u30FC\u30BA\u3057\u307E\u3059\u3002"
  },
  {
    pattern: /dd\s+if=\/dev\/(?:zero|random|urandom)\s+of=\/dev\/(?:sd[a-z]|nvme|mmcblk)/i,
    level: "CRITICAL",
    reason: "\u30B9\u30C8\u30EC\u30FC\u30B8\u30C7\u30D0\u30A4\u30B9\u3092\u4E0A\u66F8\u304D\u3057\u307E\u3059\u3002\u5168\u30C7\u30FC\u30BF\u304C\u6D88\u53BB\u3055\u308C\u307E\u3059\u3002"
  },
  {
    pattern: /mkfs\s+.*\/dev\/(?:sd[a-z]|nvme|mmcblk)/i,
    level: "CRITICAL",
    reason: "\u30B9\u30C8\u30EC\u30FC\u30B8\u30C7\u30D0\u30A4\u30B9\u3092\u30D5\u30A9\u30FC\u30DE\u30C3\u30C8\u3057\u307E\u3059\u3002\u5168\u30C7\u30FC\u30BF\u304C\u6D88\u53BB\u3055\u308C\u307E\u3059\u3002"
  },
  {
    pattern: />\s*\/dev\/(?:sd[a-z]|nvme|mmcblk)/i,
    level: "CRITICAL",
    reason: "\u30B9\u30C8\u30EC\u30FC\u30B8\u30C7\u30D0\u30A4\u30B9\u306B\u76F4\u63A5\u66F8\u304D\u8FBC\u307F\u307E\u3059\u3002\u30C7\u30FC\u30BF\u304C\u7834\u58CA\u3055\u308C\u307E\u3059\u3002"
  },
  {
    pattern: /shred\s+.*\/dev\//i,
    level: "CRITICAL",
    reason: "\u30C7\u30D0\u30A4\u30B9\u3092\u5B8C\u5168\u6D88\u53BB\u3057\u307E\u3059\u3002"
  },
  // ── HIGH: データ損失・権限昇格・外部スクリプト実行 ──────────────────────────
  {
    pattern: /curl\s+.*\|\s*(?:bash|sh|zsh|fish|python3?|node|ruby|perl)/i,
    level: "HIGH",
    reason: "\u5916\u90E8\u304B\u3089\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u3057\u305F\u30B9\u30AF\u30EA\u30D7\u30C8\u3092\u76F4\u63A5\u5B9F\u884C\u3057\u307E\u3059\u3002\u60AA\u610F\u3042\u308B\u30B3\u30FC\u30C9\u304C\u542B\u307E\u308C\u3066\u3044\u308B\u53EF\u80FD\u6027\u304C\u3042\u308A\u307E\u3059\u3002"
  },
  {
    pattern: /wget\s+.*-O\s*-\s*\|\s*(?:bash|sh|zsh|fish)/i,
    level: "HIGH",
    reason: "\u5916\u90E8\u30B9\u30AF\u30EA\u30D7\u30C8\u3092\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u3057\u3066\u5B9F\u884C\u3057\u307E\u3059\u3002\u5185\u5BB9\u3092\u78BA\u8A8D\u3057\u3066\u304B\u3089\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002"
  },
  {
    pattern: /chmod\s+(?:-R\s+)?(?:777|a\+rwx|o\+w)\s+(?:\/|~\/?\s*$|\/\*)/i,
    level: "HIGH",
    reason: "\u30EB\u30FC\u30C8\u307E\u305F\u306F\u30DB\u30FC\u30E0\u30C7\u30A3\u30EC\u30AF\u30C8\u30EA\u306E\u5168\u30D5\u30A1\u30A4\u30EB\u306B\u5168\u6A29\u9650\u3092\u4ED8\u4E0E\u3057\u307E\u3059\u3002\u30BB\u30AD\u30E5\u30EA\u30C6\u30A3\u30EA\u30B9\u30AF\u304C\u3042\u308A\u307E\u3059\u3002"
  },
  {
    pattern: /sudo\s+(?:rm|chmod|chown|dd|mkfs|shred|passwd|visudo)/i,
    level: "HIGH",
    reason: "\u7BA1\u7406\u8005\u6A29\u9650\u3067\u5371\u967A\u306A\u64CD\u4F5C\u3092\u5B9F\u884C\u3057\u307E\u3059\u3002"
  },
  {
    pattern: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+/i,
    level: "HIGH",
    reason: "\u30D5\u30A1\u30A4\u30EB\u3092\u518D\u5E30\u7684\u306B\u5F37\u5236\u524A\u9664\u3057\u307E\u3059\u3002\u524A\u9664\u5F8C\u306F\u5FA9\u5143\u3067\u304D\u307E\u305B\u3093\u3002"
  },
  {
    pattern: /passwd\s*(?:\w+)?$/i,
    level: "HIGH",
    reason: "\u30D1\u30B9\u30EF\u30FC\u30C9\u3092\u5909\u66F4\u3057\u307E\u3059\u3002"
  },
  {
    pattern: /pkill\s+-9\s+|kill\s+-9\s+/i,
    level: "HIGH",
    reason: "\u30D7\u30ED\u30BB\u30B9\u3092\u5F37\u5236\u7D42\u4E86\u3057\u307E\u3059\u3002\u4FDD\u5B58\u3055\u308C\u3066\u3044\u306A\u3044\u30C7\u30FC\u30BF\u304C\u5931\u308F\u308C\u308B\u53EF\u80FD\u6027\u304C\u3042\u308A\u307E\u3059\u3002"
  },
  {
    pattern: /git\s+(?:push\s+.*--force|push\s+-f)\b/i,
    level: "HIGH",
    reason: "\u30EA\u30E2\u30FC\u30C8\u30EA\u30DD\u30B8\u30C8\u30EA\u3092\u5F37\u5236\u4E0A\u66F8\u304D\u3057\u307E\u3059\u3002\u4ED6\u306E\u4EBA\u306E\u5909\u66F4\u304C\u5931\u308F\u308C\u308B\u53EF\u80FD\u6027\u304C\u3042\u308A\u307E\u3059\u3002"
  },
  {
    pattern: /git\s+reset\s+--hard/i,
    level: "HIGH",
    reason: "\u30B3\u30DF\u30C3\u30C8\u3055\u308C\u3066\u3044\u306A\u3044\u5909\u66F4\u304C\u5168\u3066\u5931\u308F\u308C\u307E\u3059\u3002"
  },
  {
    pattern: /DROP\s+(?:TABLE|DATABASE|SCHEMA)/i,
    level: "HIGH",
    reason: "\u30C7\u30FC\u30BF\u30D9\u30FC\u30B9\u306E\u30C6\u30FC\u30D6\u30EB\u307E\u305F\u306F\u30C7\u30FC\u30BF\u30D9\u30FC\u30B9\u5168\u4F53\u3092\u524A\u9664\u3057\u307E\u3059\u3002"
  },
  {
    pattern: /TRUNCATE\s+TABLE/i,
    level: "HIGH",
    reason: "\u30C6\u30FC\u30D6\u30EB\u306E\u5168\u30C7\u30FC\u30BF\u3092\u524A\u9664\u3057\u307E\u3059\u3002"
  },
  // ── MEDIUM: 副作用あり・要注意 ──────────────────────────────────────────────
  {
    pattern: /rm\s+(?!.*-[rf])/i,
    level: "MEDIUM",
    reason: "\u30D5\u30A1\u30A4\u30EB\u3092\u524A\u9664\u3057\u307E\u3059\u3002\u524A\u9664\u5F8C\u306F\u5FA9\u5143\u3067\u304D\u307E\u305B\u3093\u3002"
  },
  {
    pattern: /sudo\s+/i,
    level: "MEDIUM",
    reason: "\u7BA1\u7406\u8005\u6A29\u9650\u3067\u30B3\u30DE\u30F3\u30C9\u3092\u5B9F\u884C\u3057\u307E\u3059\u3002"
  },
  {
    pattern: /npm\s+install\s+.*--global|pip\s+install\s+.*--user|pip3\s+install/i,
    level: "MEDIUM",
    reason: "\u30B0\u30ED\u30FC\u30D0\u30EB\u306B\u30D1\u30C3\u30B1\u30FC\u30B8\u3092\u30A4\u30F3\u30B9\u30C8\u30FC\u30EB\u3057\u307E\u3059\u3002"
  },
  {
    pattern: /crontab\s+-[er]/i,
    level: "MEDIUM",
    reason: "\u30B9\u30B1\u30B8\u30E5\u30FC\u30EB\u30BF\u30B9\u30AF\u3092\u5909\u66F4\u307E\u305F\u306F\u524A\u9664\u3057\u307E\u3059\u3002"
  },
  {
    pattern: /iptables\s+|ufw\s+/i,
    level: "MEDIUM",
    reason: "\u30D5\u30A1\u30A4\u30A2\u30A6\u30A9\u30FC\u30EB\u8A2D\u5B9A\u3092\u5909\u66F4\u3057\u307E\u3059\u3002"
  },
  {
    pattern: /ssh-keygen|ssh-copy-id/i,
    level: "MEDIUM",
    reason: "SSH\u9375\u3092\u751F\u6210\u307E\u305F\u306F\u8EE2\u9001\u3057\u307E\u3059\u3002"
  }
];
function stripCommentsOutsideQuotes(command) {
  let result = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      result += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && i + 1 < command.length) {
        result += ch + command[i + 1];
        i++;
        continue;
      }
      result += ch;
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      result += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      result += ch;
      continue;
    }
    if (ch === "#") {
      const newlineIndex = command.indexOf("\n", i);
      if (newlineIndex === -1) {
        break;
      }
      result += "\n";
      i = newlineIndex;
      continue;
    }
    result += ch;
  }
  return result;
}
function mergeSeparatedShortFlags(command, targetCmd) {
  const re = new RegExp(`\\b${targetCmd}\\b((?:\\s+-[a-zA-Z]+)+)`, "gi");
  return command.replace(re, (fullMatch, flagsPart) => {
    const flagTokens = flagsPart.trim().split(/\s+/);
    if (flagTokens.length <= 1) return fullMatch;
    const merged = flagTokens.map((f) => f.slice(1)).join("");
    return `${targetCmd} -${merged}`;
  });
}
function checkCommandSafety(command) {
  if (!command || !command.trim()) {
    return { level: "SAFE", message: "", reason: "" };
  }
  const cleaned = mergeSeparatedShortFlags(stripCommentsOutsideQuotes(command), "rm").trim();
  let worst = { level: "SAFE", message: "", reason: "" };
  for (const { pattern, level, reason } of DANGER_PATTERNS) {
    if (pattern.test(cleaned)) {
      if (compareDanger(level, worst.level) > 0) {
        worst = {
          level,
          reason,
          matchedPattern: pattern.source,
          message: buildMessage(level, reason)
        };
      }
      if (worst.level === "CRITICAL") break;
    }
  }
  if (worst.level !== "SAFE" && worst.level !== "LOW") {
    worst.recovery = getRecoverySuggestion(command);
  }
  return worst;
}
function compareDanger(a, b) {
  const order = ["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
  return order.indexOf(a) - order.indexOf(b);
}
function buildMessage(level, reason) {
  switch (level) {
    case "CRITICAL":
      return `\u26D4 \u5371\u967A\u306A\u30B3\u30DE\u30F3\u30C9\u3067\u3059

${reason}

\u672C\u5F53\u306B\u5B9F\u884C\u3057\u307E\u3059\u304B\uFF1F`;
    case "HIGH":
      return `\u26A0\uFE0F \u6CE8\u610F\u304C\u5FC5\u8981\u306A\u30B3\u30DE\u30F3\u30C9\u3067\u3059

${reason}

\u7D9A\u884C\u3057\u307E\u3059\u304B\uFF1F`;
    case "MEDIUM":
      return `\u2139\uFE0F \u78BA\u8A8D

${reason}

\u5B9F\u884C\u3057\u307E\u3059\u304B\uFF1F`;
    default:
      return "";
  }
}
function getRecoverySuggestion(command) {
  const cmd = command.trim().toLowerCase();
  if (/rm\s/.test(cmd)) {
    return [
      "\u30D5\u30A1\u30A4\u30EB\u3092\u524A\u9664\u3057\u3066\u3057\u307E\u3063\u305F\u5834\u5408\u306E\u5FA9\u65E7\u65B9\u6CD5:",
      "  1. git\u30EA\u30DD\u30B8\u30C8\u30EA\u5185\u306A\u3089: git checkout -- <\u30D5\u30A1\u30A4\u30EB\u540D>",
      "  2. \u30B3\u30DF\u30C3\u30C8\u6E08\u307F\u306A\u3089: git log \u3067\u78BA\u8A8D \u2192 git restore --source=<\u30B3\u30DF\u30C3\u30C8ID> <\u30D5\u30A1\u30A4\u30EB>",
      "  3. git\u7BA1\u7406\u5916\u306E\u30D5\u30A1\u30A4\u30EB\u306F\u5FA9\u5143\u304C\u56F0\u96E3\u3067\u3059",
      "",
      "\u203B \u307E\u305A git status \u3067\u73FE\u5728\u5730\u304Cgit\u30EA\u30DD\u30B8\u30C8\u30EA\u304B\u3069\u3046\u304B\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002"
    ].join("\n");
  }
  if (/git\s+reset\s+--hard/.test(cmd)) {
    return [
      "git reset --hard \u306E\u5FA9\u65E7:",
      "  1. git reflog \u3067\u76F4\u524D\u306E\u72B6\u614B\u3092\u78BA\u8A8D",
      "  2. git reset --hard <reflog-ID> \u3067\u623B\u305B\u307E\u3059",
      "",
      "\u203B reflog\u306F\u901A\u5E3830\u65E5\u9593\u4FDD\u6301\u3055\u308C\u307E\u3059\u3002"
    ].join("\n");
  }
  if (/git\s+push.*(-f|--force)/.test(cmd)) {
    return [
      "force push\u306E\u5FA9\u65E7:",
      "  1. \u30C1\u30FC\u30E0\u30E1\u30F3\u30D0\u30FC\u306E\u30ED\u30FC\u30AB\u30EB\u306B\u5143\u306E\u30B3\u30DF\u30C3\u30C8\u304C\u6B8B\u3063\u3066\u3044\u308B\u5834\u5408\u3042\u308A",
      "  2. git reflog (\u30EA\u30E2\u30FC\u30C8\u30B5\u30FC\u30D0\u30FC\u5074) \u3067\u5143\u306EHEAD\u3092\u63A2\u3059",
      "  3. \u4ECA\u5F8C\u306F git push --force-with-lease \u3092\u4F7F\u3046\u3068\u5B89\u5168\u3067\u3059"
    ].join("\n");
  }
  if (/chmod\s+777/.test(cmd)) {
    return [
      "\u30D1\u30FC\u30DF\u30C3\u30B7\u30E7\u30F3\u4FEE\u6B63:",
      "  \u30C7\u30A3\u30EC\u30AF\u30C8\u30EA: chmod 755 <\u30D1\u30B9>",
      "  \u30D5\u30A1\u30A4\u30EB: chmod 644 <\u30D1\u30B9>",
      "  \u5B9F\u884C\u30D5\u30A1\u30A4\u30EB: chmod 755 <\u30D1\u30B9>"
    ].join("\n");
  }
  if (/drop\s+table|truncate\s+table/i.test(cmd)) {
    return [
      "\u30C7\u30FC\u30BF\u30D9\u30FC\u30B9\u5FA9\u65E7:",
      "  1. \u30D0\u30C3\u30AF\u30A2\u30C3\u30D7\u304C\u3042\u308C\u3070\u5FA9\u5143\u53EF\u80FD",
      "  2. PostgreSQL: pg_restore / MySQL: mysql < backup.sql",
      "  3. \u30D0\u30C3\u30AF\u30A2\u30C3\u30D7\u304C\u306A\u3044\u5834\u5408\u306F\u5FA9\u5143\u56F0\u96E3\u3067\u3059"
    ].join("\n");
  }
  return void 0;
}

// lib/sha256.ts
var K = new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
function utf8Bytes(text) {
  const out = [];
  for (const ch of text) {
    let cp = ch.codePointAt(0);
    if (cp >= 55296 && cp <= 57343) cp = 65533;
    if (cp < 128) out.push(cp);
    else if (cp < 2048) out.push(192 | cp >> 6, 128 | cp & 63);
    else if (cp < 65536) out.push(224 | cp >> 12, 128 | cp >> 6 & 63, 128 | cp & 63);
    else out.push(240 | cp >> 18, 128 | cp >> 12 & 63, 128 | cp >> 6 & 63, 128 | cp & 63);
  }
  return Uint8Array.from(out);
}
var rotr = (x, n) => x >>> n | x << 32 - n;
function sha256Hex(text) {
  const msg = utf8Bytes(text);
  const bitLen = msg.length * 8;
  const padded = new Uint8Array(msg.length + 9 + 63 >> 6 << 6);
  padded.set(msg);
  padded[msg.length] = 128;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const h = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ w[i - 15] >>> 3;
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ w[i - 2] >>> 10;
      w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = e & f ^ ~e & g;
      const t1 = hh + S1 + ch + K[i] + w[i] >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = a & b ^ a & c ^ b & c;
      const t2 = S0 + maj >>> 0;
      hh = g;
      g = f;
      f = e;
      e = d + t1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 >>> 0;
    }
    h[0] = h[0] + a >>> 0;
    h[1] = h[1] + b >>> 0;
    h[2] = h[2] + c >>> 0;
    h[3] = h[3] + d >>> 0;
    h[4] = h[4] + e >>> 0;
    h[5] = h[5] + f >>> 0;
    h[6] = h[6] + g >>> 0;
    h[7] = h[7] + hh >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

// lib/agent-action-policy.ts
var RUN_ORIGINS = Object.freeze([
  "user",
  "widget",
  "schedule",
  "notification",
  "boot",
  "event"
]);
var USER_INITIATED_ORIGINS = Object.freeze(["user", "widget"]);
function normalizeRunOrigin(raw2) {
  if (typeof raw2 !== "string") return "unknown";
  const v = raw2.trim().toLowerCase();
  return RUN_ORIGINS.includes(v) ? v : "unknown";
}
function isProactiveOrigin(raw2) {
  const origin = normalizeRunOrigin(raw2);
  return !USER_INITIATED_ORIGINS.includes(origin);
}
var POLICY_CAPABILITIES = Object.freeze([
  "read",
  "draft",
  "notify",
  "exec",
  "fs-write",
  "network",
  "post",
  "message",
  "git-push",
  "payment",
  "secret"
]);
var READ_ONLY_CAPABILITIES = Object.freeze(["read", "draft", "notify"]);
var NETWORK_SUBCAPS = Object.freeze(["post", "message", "git-push"]);
function hasSideEffect(caps) {
  return caps.some((c) => !READ_ONLY_CAPABILITIES.includes(c));
}
var POLICY_EFFECTS = Object.freeze(["ask", "deny", "draft_only"]);
var MAX_RULE_KEYWORDS = 12;
var MAX_KEYWORD_LEN = 40;
var MAX_RULE_SOURCE_LEN = 300;
var MATCH_KEYS = ["capability", "domain", "pathPrefix", "outsidePath", "keywords"];
var DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
var KEYWORD_FORBIDDEN_RE = /[\u0000-\u001f\u007f"\\|`$]/;
function normalizeDomain(raw2) {
  let v = String(raw2 || "").trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  v = v.split(/[/?#:]/)[0] || "";
  v = v.replace(/^www\./, "").replace(/\.$/, "");
  return DOMAIN_RE.test(v) ? v : null;
}
function normalizeRulePath(raw2) {
  let v = String(raw2 || "").trim();
  if (!v || v.includes("\0") || KEYWORD_FORBIDDEN_RE.test(v)) return null;
  if (v !== "~" && !v.startsWith("~/") && !v.startsWith("/")) return null;
  if (v.split("/").some((seg) => seg === "..")) return null;
  v = v.replace(/\/{2,}/g, "/");
  if (v.length > 1) v = v.replace(/\/+$/, "");
  return v || null;
}
function validatePolicyRule(raw2) {
  if (!raw2 || typeof raw2 !== "object" || Array.isArray(raw2)) return { ok: false, reason: "rule is not an object" };
  const rec = raw2;
  for (const key of Object.keys(rec)) {
    if (key !== "effect" && key !== "match") return { ok: false, reason: `unknown rule field "${key}"` };
  }
  const effect = rec.effect;
  if (typeof effect !== "string" || !POLICY_EFFECTS.includes(effect)) {
    return { ok: false, reason: `effect must be one of ${POLICY_EFFECTS.join("/")} (rules can only tighten)` };
  }
  const m = rec.match;
  if (!m || typeof m !== "object" || Array.isArray(m)) return { ok: false, reason: "match is not an object" };
  const mrec = m;
  for (const key of Object.keys(mrec)) {
    if (!MATCH_KEYS.includes(key)) return { ok: false, reason: `unknown match field "${key}"` };
  }
  const match = {};
  if (mrec.capability !== void 0 && mrec.capability !== null) {
    if (typeof mrec.capability !== "string" || !POLICY_CAPABILITIES.includes(mrec.capability)) {
      return { ok: false, reason: "unknown capability" };
    }
    match.capability = mrec.capability;
  }
  if (mrec.domain !== void 0 && mrec.domain !== null && mrec.domain !== "") {
    if (typeof mrec.domain !== "string") return { ok: false, reason: "domain must be a string" };
    const d = normalizeDomain(mrec.domain);
    if (!d) return { ok: false, reason: "domain is not a valid hostname" };
    match.domain = d;
  }
  for (const key of ["pathPrefix", "outsidePath"]) {
    const v = mrec[key];
    if (v === void 0 || v === null || v === "") continue;
    if (typeof v !== "string") return { ok: false, reason: `${key} must be a string` };
    const p = normalizeRulePath(v);
    if (!p) return { ok: false, reason: `${key} must be an absolute or ~/ path without ".."` };
    match[key] = p;
  }
  if (match.pathPrefix && match.outsidePath) return { ok: false, reason: "pathPrefix and outsidePath are mutually exclusive" };
  if (mrec.keywords !== void 0 && mrec.keywords !== null) {
    if (!Array.isArray(mrec.keywords)) return { ok: false, reason: "keywords must be an array" };
    const kws = [];
    for (const kw of mrec.keywords) {
      if (typeof kw !== "string") return { ok: false, reason: "keyword must be a string" };
      const k = kw.trim().toLowerCase();
      if (!k) continue;
      if (k.length > MAX_KEYWORD_LEN || KEYWORD_FORBIDDEN_RE.test(k)) return { ok: false, reason: "keyword is too long or has forbidden characters" };
      if (!kws.includes(k)) kws.push(k);
    }
    if (kws.length > MAX_RULE_KEYWORDS) return { ok: false, reason: `at most ${MAX_RULE_KEYWORDS} keywords` };
    if (kws.length) match.keywords = kws;
  }
  if (!match.capability && !match.domain && !match.pathPrefix && !match.outsidePath && !match.keywords) {
    return { ok: false, reason: "rule matches nothing" };
  }
  if ((match.pathPrefix || match.outsidePath) && match.capability && !["fs-write", "exec", "read"].includes(match.capability)) {
    return { ok: false, reason: "path scopes only apply to fs-write/exec/read" };
  }
  return { ok: true, rule: { effect, match } };
}
function parseStoredRules(raw2) {
  if (!Array.isArray(raw2)) return [];
  const out = [];
  for (const entry of raw2) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry;
    const v = validatePolicyRule({ effect: e.effect, match: e.match });
    if (!v.ok) continue;
    if (typeof e.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(e.id)) continue;
    out.push({
      id: e.id,
      effect: v.rule.effect,
      match: v.rule.match,
      source: typeof e.source === "string" ? e.source.slice(0, MAX_RULE_SOURCE_LEN) : "",
      createdAt: typeof e.createdAt === "number" && Number.isFinite(e.createdAt) ? e.createdAt : 0
    });
  }
  return out;
}
var TRUST_FORBIDDEN_CHARS_RE = /[;&|`$()<>\r\n\\{}*?[\]~!]/;
var TRUST_NON_PLAIN_RE = /[^\x20-\x7e\t]/;
var TRUST_TRAMPOLINE_HEADS = /* @__PURE__ */ new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "mksh",
  "fish",
  "csh",
  "tcsh",
  "ash",
  "python",
  "python2",
  "python3",
  "pypy",
  "pypy3",
  "node",
  "nodejs",
  "deno",
  "bun",
  "npx",
  "bunx",
  "make",
  "gmake",
  "env",
  "eval",
  "exec",
  "xargs",
  "su",
  "sudo",
  "doas",
  "busybox",
  "toybox",
  "perl",
  "ruby",
  "php",
  "lua",
  "luajit",
  "tclsh",
  "awk",
  "gawk",
  "mawk",
  "nawk",
  "sed",
  "nohup",
  "timeout",
  "nice",
  "ionice",
  "time",
  "command",
  "builtin",
  "source",
  ".",
  "watch",
  "ssh",
  "script",
  "expect",
  "linker64",
  "run-as",
  "am",
  "pm",
  "cmd",
  "sh.exe",
  "osascript",
  "powershell",
  "pwsh",
  "chroot",
  "unshare",
  "nsenter",
  "setsid",
  "stdbuf",
  "strace",
  // Review R3: build tools whose every invocation runs project-defined code
  // (build scripts, plugins) that can change between approvals.
  "gradle",
  "gradlew",
  "mvn",
  "mvnw",
  "ant",
  "sbt",
  "bazel",
  "rake",
  "just",
  "task"
]);
var TRUST_TRAMPOLINE_SUBCOMMANDS = Object.freeze({
  npm: ["exec", "x", "explore", "test", "t", "run", "run-script", "start", "restart", "stop", "install-test", "it"],
  pnpm: ["dlx", "exec", "x", "test", "t", "run", "start"],
  yarn: ["dlx", "exec", "test", "run", "start", "node"],
  cargo: ["run", "test", "bench", "r", "t"],
  go: ["run", "test", "generate"],
  git: [
    "-c",
    "--config-env",
    "--exec-path",
    "config",
    "submodule",
    "filter-branch",
    "bisect",
    "commit",
    "merge",
    "rebase",
    "pull",
    "am",
    "cherry-pick",
    "revert",
    "push",
    "checkout",
    "switch",
    "worktree",
    "gc"
  ]
});
function normalizeTrustCommand(command) {
  return String(command || "").replace(/^[ \t]+|[ \t]+$/g, "").replace(/[ \t]+/g, " ");
}
function isTrustEligibleCommand(command) {
  const c = normalizeTrustCommand(command);
  if (!c || c.length > 200) return false;
  if (TRUST_NON_PLAIN_RE.test(command) || TRUST_FORBIDDEN_CHARS_RE.test(command)) return false;
  const words = c.split(" ");
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return false;
  const head = (words[0].split("/").pop() || "").toLowerCase();
  if (!head || words[0].includes("/")) return false;
  if (TRUST_TRAMPOLINE_HEADS.has(head) || /^python\d/.test(head)) return false;
  const subs = TRUST_TRAMPOLINE_SUBCOMMANDS[head];
  const isSub = (w) => w.startsWith("-") ? subs.some((s) => s.startsWith("-") && (w === s || w.startsWith(`${s}=`) || s.length === 2 && w.startsWith(s) && w.length > 2)) : subs.includes(w.toLowerCase());
  if (subs && words.slice(1).some(isSub)) return false;
  if (head === "find" && words.some((w) => /^-(?:exec|execdir|ok|okdir|delete|fprint)/.test(w))) return false;
  return true;
}
var TRUST_RAMP_EXCLUDED_CAPABILITIES = Object.freeze([
  "payment",
  "secret",
  "post",
  "message",
  "network",
  "git-push"
]);
var TRUST_SCOPE_RE = /^[A-Za-z0-9_.-]{1,200}$/;
function trustKeyForDescriptor(desc) {
  if (desc.kind !== "cli") return null;
  if (isProactiveOrigin(desc.origin)) return null;
  if (desc.dangerLevel === "CRITICAL" || desc.dangerLevel === "HIGH") return null;
  if (!hasSideEffect(desc.capabilities)) return null;
  if (desc.capabilities.some((c) => TRUST_RAMP_EXCLUDED_CAPABILITIES.includes(c))) return null;
  if (!isTrustEligibleCommand(desc.command)) return null;
  if (!TRUST_SCOPE_RE.test(desc.scope || "")) return null;
  const hash = sha256Hex(`${desc.scope}
${desc.kind}
${normalizeTrustCommand(desc.command)}`);
  return `${desc.kind}|${hash}|${desc.scope}`;
}
var PAYMENT_HINT_RE = /(?:\b(?:pay|payment|purchase|checkout|invoice|stripe|paypal|billing|transfer|wire)\b|支払|決済|購入|送金|振込|振り込|課金|お金|代金|請求)/i;
var SECRET_HINT_RE = /(?:\.env\b|auth\.json|\.ssh\/|id_rsa|keystore|\b(?:api[_-]?key|token|secret|password|passwd)\b|パスワード|秘密鍵|トークン)/i;
var GIT_PUSH_RE = /\bgit\s+(?:-[^\s]+\s+)*push\b/;
var NETWORK_CMD_RE = /\b(?:curl|wget|nc|ncat|ssh|scp|sftp|rsync|ftp|telnet)\b/;
var NETWORK_SEND_FLAG_RE = /(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|\s--data(?:-[a-z]+)?\b|\s-d\s|\s-F\s|\s--form\b|\s-T\s|\s--upload-file\b)/i;
var FS_WRITE_RE = /(?:>>?|\s-(?:delete|exec|execdir|ok)\b|\b(?:rm|rmdir|mv|cp|mkdir|touch|tee|ln|chmod|chown|truncate|dd|install|unzip|tar)\b|\bsed\s+(?:-[a-zA-Z]*i|--in-place)|\bgit\s+(?:commit|checkout|reset|merge|rebase|clean|stash|add|rm|mv|apply|pull|clone)\b|\b(?:npm|pnpm|yarn)\s+(?:install|i|add|remove|uninstall|update|ci)\b|\bpip3?\s+install\b)/;
var PURE_READ_RE = /^\s*(?:cat|ls|pwd|echo|printf|head|tail|wc|grep|rg|find|stat|file|du|df|which|type|env|printenv|date|whoami|uname|tree|less|more|sort|uniq|cut|jq|git\s+(?:status|log|diff|show|branch|remote|rev-parse|ls-files|blame)|true|false)\b/;
var URL_HOST_RE = /\bhttps?:\/\/(\[[0-9a-fA-F:]+\]|[^/\s:'"`]+)/gi;
var PATH_TOKEN_RE = /(?:^|[\s='"(])((?:~|\/)[^\s'"`;|&<>()]*)/g;
var MULTI_WORD_TOOLS = /* @__PURE__ */ new Set(["git", "npm", "pnpm", "yarn", "npx", "docker", "kubectl", "gh", "cargo", "go", "pip", "pip3", "python", "python3", "node", "make", "shelly"]);
function extractHosts(text) {
  const out = [];
  for (const m of text.matchAll(URL_HOST_RE)) {
    const h = m[1].toLowerCase().replace(/^\[|\]$/g, "");
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}
function extractPathTokens(command) {
  const out = [];
  for (const m of command.matchAll(PATH_TOKEN_RE)) {
    const p = m[1];
    if (!p || p.startsWith("//")) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
function commandClassOf(command) {
  const words = String(command || "").trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || words[i] === "sudo" || words[i] === "env" || words[i] === "command")) i += 1;
  if (i >= words.length) return "";
  const head = (words[i].split("/").pop() || "").toLowerCase();
  if (!MULTI_WORD_TOOLS.has(head)) return head;
  for (let j = i + 1; j < words.length; j += 1) {
    const w = words[j];
    if (w.startsWith("-")) {
      if (head === "git" && (w === "-C" || w === "-c") || w === "--prefix") j += 1;
      continue;
    }
    return `${head} ${w.toLowerCase().replace(/[^a-z0-9:_.-]/g, "")}`.trim();
  }
  return head;
}
function commandCapabilities(command) {
  const c = String(command || "");
  const caps = [];
  const add = (cap) => {
    if (!caps.includes(cap)) caps.push(cap);
  };
  if (!c.trim()) return ["read"];
  if (GIT_PUSH_RE.test(c)) add("git-push");
  if (NETWORK_CMD_RE.test(c)) {
    add("network");
    if (NETWORK_SEND_FLAG_RE.test(c)) add("post");
  }
  if (PAYMENT_HINT_RE.test(c)) add("payment");
  if (SECRET_HINT_RE.test(c)) add("secret");
  if (FS_WRITE_RE.test(c)) add("fs-write");
  const compound = /[;&|`]|\$\(/.test(c);
  if (!caps.length && PURE_READ_RE.test(c) && !compound) return ["read"];
  add("exec");
  return caps;
}
function lowerHaystack(...parts) {
  return parts.filter((p) => typeof p === "string" && p).join("\n").toLowerCase();
}
function describeCommandAction(opts) {
  const command = String(opts.command || "");
  const paths = extractPathTokens(command);
  if (!paths.length && opts.cwd) paths.push(opts.cwd);
  return {
    kind: "command",
    capabilities: commandCapabilities(command),
    origin: normalizeRunOrigin(opts.origin),
    hosts: extractHosts(command),
    paths,
    text: lowerHaystack(command),
    dangerLevel: checkCommandSafety(command).level,
    commandClass: commandClassOf(command),
    command,
    scope: opts.scope || opts.cwd || ""
  };
}
function expandHome(p, homeDir) {
  if (!homeDir) return p;
  if (p === "~") return homeDir;
  if (p.startsWith("~/")) return `${homeDir.replace(/\/+$/, "")}/${p.slice(2)}`;
  return p;
}
function lexicalNormalize(p) {
  const abs = p.startsWith("/");
  const out = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length) out.pop();
      continue;
    }
    out.push(seg);
  }
  return (abs ? "/" : "") + out.join("/");
}
function isUnder(target, prefix, homeDir) {
  const t = lexicalNormalize(expandHome(target, homeDir));
  const p = lexicalNormalize(expandHome(prefix, homeDir));
  if (!p || p === "/") return t.startsWith("/") || t === p;
  return t === p || t.startsWith(`${p}/`);
}
function capabilityMatches(ruleCap, caps) {
  if (caps.includes(ruleCap)) return true;
  if (ruleCap === "network") return caps.some((c) => NETWORK_SUBCAPS.includes(c));
  return false;
}
function hostMatches(domain, hosts) {
  return hosts.some((h) => h === domain || h.endsWith(`.${domain}`));
}
function ruleMatches(rule, desc, homeDir = "") {
  const m = rule.match;
  if (m.capability && !capabilityMatches(m.capability, desc.capabilities)) return false;
  if (m.domain && !hostMatches(m.domain, desc.hosts)) return false;
  if (m.pathPrefix && !desc.paths.some((p) => isUnder(p, m.pathPrefix, homeDir))) return false;
  if (m.outsidePath) {
    if (!hasSideEffect(desc.capabilities)) return false;
    if (desc.paths.length && desc.paths.every((p) => isUnder(p, m.outsidePath, homeDir))) return false;
  }
  if (m.keywords && !m.keywords.some((k) => desc.text.includes(k))) return false;
  return true;
}
function evaluateActionPolicy(desc, state) {
  if (!state.enabled) return { decision: "default", layer: "disabled", reason: "policy engine disabled" };
  const homeDir = state.homeDir || "";
  const sideEffect = hasSideEffect(desc.capabilities);
  let draftOnly = null;
  for (const rule of state.rules) {
    if (rule.effect !== "deny" && rule.effect !== "draft_only") continue;
    if (!ruleMatches(rule, desc, homeDir)) continue;
    if (rule.effect === "deny") return { decision: "deny", layer: "deny-rule", reason: `user rule: ${rule.source || rule.id}`, ruleId: rule.id };
    if (!draftOnly) draftOnly = rule;
  }
  if (draftOnly && sideEffect) {
    return { decision: "draft_only", layer: "deny-rule", reason: `user rule (draft only): ${draftOnly.source || draftOnly.id}`, ruleId: draftOnly.id };
  }
  if (sideEffect && isProactiveOrigin(desc.origin)) {
    return { decision: "ask", layer: "proactive", reason: `proactive run (origin=${desc.origin}) may only read/draft/notify` };
  }
  for (const rule of state.rules) {
    if (rule.effect !== "ask") continue;
    if (!ruleMatches(rule, desc, homeDir)) continue;
    return { decision: "ask", layer: "ask-rule", reason: `user rule: ${rule.source || rule.id}`, ruleId: rule.id };
  }
  if (state.rulesUnavailable) {
    return sideEffect ? { decision: "ask", layer: "ask-rule", reason: "user policy file unreadable \u2014 escalating (fail-closed)" } : { decision: "default", layer: "default", reason: "read-only action" };
  }
  if (sideEffect && state.trustAllows && state.trustAllows.length) {
    const key = trustKeyForDescriptor(desc);
    if (key) {
      const hit = state.trustAllows.find((a) => a.key === key);
      if (hit) return { decision: "allow", layer: "trust-allow", reason: `trust-ramp allow ${hit.id}`, ruleId: hit.id };
    }
  }
  return { decision: "default", layer: "default", reason: "no policy opinion" };
}
var SIDE_EFFECT_ACTION_TYPES = Object.freeze([
  "webhook",
  "cli",
  "intent",
  "dm-reply",
  "api-call",
  "social-post",
  "browser-pane"
]);
var ALL_POLICY_ACTION_TYPES = Object.freeze(["draft", "notify", ...SIDE_EFFECT_ACTION_TYPES]);
var CAPABILITY_ACTION_TYPES = Object.freeze({
  read: [],
  draft: ["draft"],
  notify: ["notify"],
  exec: ["cli", "intent"],
  "fs-write": ["cli"],
  network: ["webhook", "api-call", "social-post", "dm-reply", "browser-pane", "intent"],
  post: ["webhook", "api-call", "social-post", "browser-pane"],
  message: ["dm-reply", "intent"],
  "git-push": ["cli"],
  payment: SIDE_EFFECT_ACTION_TYPES,
  secret: ["cli"]
});
var PAYMENT_KEYWORDS = Object.freeze([
  "pay",
  "payment",
  "purchase",
  "checkout",
  "invoice",
  "stripe",
  "paypal",
  "billing",
  "\u652F\u6255",
  "\u6C7A\u6E08",
  "\u8CFC\u5165",
  "\u9001\u91D1",
  "\u632F\u8FBC",
  "\u8AB2\u91D1"
]);

// lib/agent-boundary-policy.ts
var DEFAULT_SECRET_PATHS = [".codex/auth.json", ".shelly/agents/.env"];
function normalizePath(p) {
  const isAbs = p.startsWith("/");
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!isAbs) out.push("..");
    } else out.push(seg);
  }
  return (isAbs ? "/" : "") + out.join("/");
}
function nodeFs() {
  if (typeof process === "undefined" || !process.versions?.node) return null;
  try {
    const runtimeModule = typeof module === "undefined" ? null : module;
    if (!runtimeModule || typeof runtimeModule.require !== "function") return null;
    return runtimeModule.require("fs");
  } catch {
    return null;
  }
}
function realpathAllowMissing(path, fs) {
  const missing = [];
  let candidate = path;
  while (true) {
    try {
      const resolved = normalizePath(fs.realpathSync(candidate).replace(/\\/g, "/"));
      return normalizePath(`${resolved}/${missing.reverse().join("/")}`);
    } catch (error) {
      if (error.code !== "ENOENT") return null;
      const slash = candidate.lastIndexOf("/");
      if (slash < 0) return null;
      missing.push(candidate.slice(slash + 1));
      const parent = candidate.slice(0, slash) || "/";
      if (parent === candidate) return null;
      candidate = parent;
    }
  }
}
function isWithinRoot(root, target) {
  if (target.startsWith("~")) return false;
  if (target.startsWith("$")) return false;
  const r = normalizePath(root).replace(/\/$/, "");
  const targetIsAbsolute = target.startsWith("/") || /^[A-Za-z]:\//.test(target);
  const t = normalizePath(targetIsAbsolute ? target : `${r}/${target}`);
  if (t !== r && !t.startsWith(`${r}/`)) return false;
  const fs = nodeFs();
  if (!fs) return true;
  let realRoot;
  try {
    realRoot = normalizePath(fs.realpathSync(r).replace(/\\/g, "/"));
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT" || code === "EACCES") return true;
    return false;
  }
  const realTarget = realpathAllowMissing(t, fs);
  if (!realTarget) return false;
  return realTarget === realRoot || realTarget.startsWith(`${realRoot}/`);
}
var SHELL_SPECIAL_PARAM_RE = /^\$(?:\$|\?|#|@|\*|[0-9])$/;
function extractPaths(command) {
  return command.split(/\s+/).map(
    (t) => t.replace(/^[<>|&]+/, "").replace(/[;,]+$/, "").replace(/^['"`]+/, "").replace(/['"`]+$/, "")
  ).filter(
    (t) => t.length > 0 && !t.startsWith("-") && (t.includes("/") || t.startsWith("~") || t === "." || t === ".." || // Fable5 review 2026-08-25: a bare `..` (no `/`) matched
    // none of the conditions below, so `cd ..` was invisible
    // to isWithinRoot entirely — see hasUnsafeCd() for the
    // companion fix (a `cd` outside root taints every
    // relative path after it, which this filter alone can't).
    t.startsWith("$") && !SHELL_SPECIAL_PARAM_RE.test(t) || // bare `$HOME` (no `/`) — see isWithinRoot's `$` guard
    t.startsWith("./") || t.startsWith("../"))
  );
}
var CD_START_RE = /(?:^|[;&|(\n'"`\s])\s*cd(?=[\s;&|)'"`]|$)/g;
function hasUnsafeCd(command, root) {
  CD_START_RE.lastIndex = 0;
  let match;
  while (match = CD_START_RE.exec(command)) {
    const afterCd = command.slice(match.index + match[0].length);
    const restMatch = afterCd.match(/^[^;&|)'"`\n]*/);
    const rest = (restMatch ? restMatch[0] : "").trim();
    if (!rest) return true;
    const tokens = rest.split(/\s+/);
    const argToken = tokens.find((t) => !t.startsWith("-"));
    if (!argToken || argToken === "-") return true;
    const arg = argToken.replace(/^['"`]+/, "").replace(/['"`]+$/, "");
    if (!isWithinRoot(root, arg)) return true;
  }
  return false;
}
var NETWORK_RE = /\b(curl|wget|nc|ncat|netcat|scp|sftp|ssh|rsync|telnet)\b/;
var SHELL_NET_DEVICE_RE = /\/dev\/(?:tcp|udp)\//;
var READ_ONLY_RE = /^\s*(cat|less|more|head|tail|grep|rg|ls|find|stat|file|wc|diff|git\s+(status|log|diff|show))\b/;
var LOOPBACK_HOST_RE = /^(127(?:\.\d{1,3}){3}|localhost|\[?::1\]?)$/i;
var OPAQUE_SCRIPT_RE = /\b(?:python\d?(?:\.\d+)*|pypy\d*|node(?:js)?|ruby|perl|php|deno|bun|lua(?:jit)?|Rscript|julia|tclsh)\b\s+\S/;
var SHELL_SCRIPT_FILE_RE = /(?:^|[\s;&|(])(?:ba|z|k|da)?sh\s+(?:-[A-Za-z]+\s+)*(?!-)[^\s;&|]*\.(?:sh|bash|zsh|ksh)\b/;
var PIPED_INTERPRETER_RE = /\|\s*(?:sudo\s+)?(?:[^\s|;&]*\/)?(?:python\d?(?:\.\d+)*|pypy\d*|node(?:js)?|ruby|perl|php|deno|bun|lua(?:jit)?|Rscript|julia|tclsh|sh|bash|zsh|ksh|dash)\b/;
var INDIRECT_EXEC_RE = /\$\(|`|\beval\b|\bxargs\b\s+\S|\benv\b\s+(?:-\S+\s+)*(?:\w+=\S*\s+)*\S/;
function isPureReadCommand(command) {
  if (command.includes(">")) return false;
  const segments = command.split(/\|\||&&|[|;&]/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((s) => READ_ONLY_RE.test(s));
}
function isLoopbackOnlyNetworkCommand(command) {
  const hosts = [...command.matchAll(/\bhttps?:\/\/(\[[0-9a-fA-F:]+\]|[^/\s:]+)/gi)].map((m) => m[1]);
  if (hosts.length === 0) return false;
  return hosts.every((h) => LOOPBACK_HOST_RE.test(h));
}
function classifyProposedCommand(command, ctx) {
  const signals = [];
  const secretPaths = ctx.secretPaths ?? DEFAULT_SECRET_PATHS;
  const safety = checkCommandSafety(command);
  if (ctx.policyPath && new RegExp(`>\\s*\\S*${escapeRe(ctx.policyPath)}|\\b(tee|cp|mv)\\b[^|]*${escapeRe(ctx.policyPath)}`).test(command)) {
    return { decision: "deny", signals: ["policy-write"], reason: "agent attempted to write the policy/autonomy file", dangerLevel: safety.level };
  }
  if (ctx.policyPath && (ctx.strictPolicyPaths ? touchesAgentsConfigDir(command) : touchesProtectedPolicyFiles(command))) {
    return { decision: "deny", signals: ["policy-write"], reason: "agent attempted to modify the agents config dir (policy file)", dangerLevel: safety.level };
  }
  if (safety.level === "CRITICAL") {
    return { decision: "deny", signals: ["destructive"], reason: safety.reason, dangerLevel: safety.level };
  }
  if (safety.level === "HIGH") signals.push("destructive");
  const paths = extractPaths(command);
  if (paths.some((p) => secretPaths.some((s) => normalizePath(p).includes(s)))) signals.push("secret-read");
  if (paths.some((p) => !isWithinRoot(ctx.workspaceRoot, p)) || hasUnsafeCd(command, ctx.workspaceRoot)) {
    signals.push("leaves-root");
  }
  if (NETWORK_RE.test(command) && !isLoopbackOnlyNetworkCommand(command) || SHELL_NET_DEVICE_RE.test(command)) {
    signals.push("network-send");
  }
  if (OPAQUE_SCRIPT_RE.test(command) || SHELL_SCRIPT_FILE_RE.test(command) || PIPED_INTERPRETER_RE.test(command)) {
    signals.push("opaque-script-exec");
  }
  if (INDIRECT_EXEC_RE.test(command)) signals.push("indirect-exec");
  const isPureRead = isPureReadCommand(command) && !signals.includes("network-send") && !signals.includes("opaque-script-exec");
  if (!isPureRead) signals.push("write-or-exec");
  const boundarySignals = signals.filter((s) => s !== "write-or-exec");
  const reason = signals.length ? `boundary: ${signals.join(", ")}` : "within policy";
  switch (ctx.level) {
    case "L1":
      if (isPureRead && boundarySignals.length === 0) {
        return { decision: "allow", signals, reason: "L1 read", dangerLevel: safety.level };
      }
      return { decision: "gray", signals, reason, dangerLevel: safety.level };
    case "L2":
      if (boundarySignals.length === 0) {
        return { decision: "allow", signals, reason: "L2 in-workspace", dangerLevel: safety.level };
      }
      return { decision: "gray", signals, reason, dangerLevel: safety.level };
    case "L3": {
      const hardDenySignals = ["secret-read", "leaves-root", "network-send"];
      if (safety.level === "HIGH" || hardDenySignals.some((s) => signals.includes(s))) {
        return { decision: "deny", signals, reason: `L3 safety boundary: ${reason}`, dangerLevel: safety.level };
      }
      if (boundarySignals.length > 0) {
        return { decision: "gray", signals, reason, dangerLevel: safety.level };
      }
      return { decision: "allow", signals, reason: "L3 in-workspace", dangerLevel: safety.level };
    }
  }
}
var AGENTS_DIR_MUTATOR_RE = /(?:>|\b(?:rm|rmdir|unlink|mv|cp|tee|truncate|dd|ln|chmod|chown|install|shred|touch|rsync|tar|unzip|zip|python\d*|node|nodejs|deno|bun|perl|ruby|php|lua|awk|gawk|find|xargs|bash|sh|zsh|dash|busybox|toybox|git|patch|ed|ex|vi|vim|nano)\b|\bsed\b[^|;&]*\s-(?:[a-zA-Z]*i|-in-place))/;
function touchesAgentsConfigDir(command) {
  const c = String(command || "");
  if (touchesProtectedPolicyFiles(c)) return true;
  if (!AGENTS_DIR_MUTATOR_RE.test(c)) return false;
  if (/\.shelly\/+agents\b/.test(c)) return true;
  if (/\.shelly\b/.test(c) && /\bagents\b/.test(c)) return true;
  if (/(?:^|[\s/'"=])policy\.json\b/.test(c) && /\.shelly\b|\bagents\b/.test(c)) return true;
  if (/\bshared_prefs\b/.test(c)) return true;
  return false;
}
var PROTECTED_POLICY_FILE_RE = /(?:\.shelly\/+agents\/+[A-Za-z0-9_.-]+\.json\b|shared_prefs\/+(?:shelly_agent_policy|SecureStore)\b|\bshelly_agent_policy\.xml\b)/;
var NARROW_MUTATOR_RE = /\b(?:rm|rmdir|unlink|mv|cp|tee|truncate|dd|ln|chmod|chown|install|shred|touch|rsync|patch)\b|\bsed\b[^|;&]*\s-(?:[a-zA-Z]*i|-in-place)|\bfind\b[^|;&]*\s-delete\b/;
var NARROW_INTERPRETER_RE = /\b(?:python\d*|node|nodejs|deno|bun|perl|ruby|php)\b/;
var REDIRECT_TO_PROTECTED_RE = />{1,2}\s*['"]?[^\s'"]*(?:\.shelly\/+agents\/+[A-Za-z0-9_.-]+\.json|shelly_agent_policy)/;
var REDIRECT_TO_POLICY_BASENAME_RE = />{1,2}\s*['"]?(?:\.\/)?policy\.json\b/;
function touchesProtectedPolicyFiles(command) {
  const c = String(command || "");
  if (REDIRECT_TO_PROTECTED_RE.test(c)) return true;
  const policyBasename = /(?:^|[\s/'"=])policy\.json\b/.test(c) && /\.shelly\b|\bagents\b/.test(c);
  const prefsSeal = /\bshelly_agent_policy\b/.test(c);
  if (policyBasename && REDIRECT_TO_POLICY_BASENAME_RE.test(c)) return true;
  if (NARROW_MUTATOR_RE.test(c) && (PROTECTED_POLICY_FILE_RE.test(c) || policyBasename)) return true;
  if (NARROW_INTERPRETER_RE.test(c) && (policyBasename || prefsSeal)) return true;
  return false;
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// lib/agent-policy.ts
function parseActionPolicyInput(raw2) {
  if (!raw2 || typeof raw2 !== "object" || Array.isArray(raw2)) return void 0;
  const r = raw2;
  if (r.enabled !== true) return void 0;
  const rules = parseStoredRules(r.rules);
  return {
    enabled: true,
    origin: typeof r.origin === "string" ? r.origin : "",
    rules,
    homeDir: typeof r.homeDir === "string" ? r.homeDir : "",
    // A rules field that is not an array, or one with ANY invalid entry
    // (security review L5: dropping a rule silently loosens), is unreadable.
    rulesUnavailable: r.rulesUnavailable === true || !Array.isArray(r.rules) || rules.length !== r.rules.length
  };
}
var DEFAULT_POLICY = {
  level: "L2",
  secretPaths: [".codex/auth.json", ".shelly/agents/.env"],
  policyPath: ".shelly/agents/policy.json",
  denyPatterns: [],
  allowPatterns: []
};
var LEVELS = ["L1", "L2", "L3"];
function parseAutonomyPolicy(raw2, workspaceRoot) {
  const r = raw2 && typeof raw2 === "object" ? raw2 : {};
  const strArr = (v, d) => Array.isArray(v) && v.every((x) => typeof x === "string") ? v : d;
  const actionPolicy = parseActionPolicyInput(r.actionPolicy);
  return {
    ...actionPolicy ? { actionPolicy } : {},
    level: LEVELS.includes(r.level) ? r.level : DEFAULT_POLICY.level,
    workspaceRoot,
    secretPaths: strArr(r.secretPaths, DEFAULT_POLICY.secretPaths),
    policyPath: typeof r.policyPath === "string" ? r.policyPath : DEFAULT_POLICY.policyPath,
    denyPatterns: strArr(r.denyPatterns, DEFAULT_POLICY.denyPatterns),
    allowPatterns: strArr(r.allowPatterns, DEFAULT_POLICY.allowPatterns),
    // Strict `=== true`: a malformed value never opts a run INTO the unattended
    // fast-decline (absent/invalid ⇒ attended behavior — the escalation wait +
    // timeout, i.e. today's semantics).
    unattended: r.unattended === true
  };
}
function decideAutoAnswer(command, policy) {
  const ctx = {
    workspaceRoot: policy.workspaceRoot,
    level: policy.level,
    secretPaths: policy.secretPaths,
    policyPath: policy.policyPath,
    // Wide agents-dir hard-deny only when the POLICY-001 flag is on.
    strictPolicyPaths: policy.actionPolicy?.enabled === true
  };
  let verdict = classifyProposedCommand(command, ctx);
  if (policy.denyPatterns.some((p) => safeRegex(p)?.test(command))) {
    verdict = { ...verdict, decision: "deny", reason: `operator deny-pattern \xB7 ${verdict.reason}` };
  } else if (verdict.decision === "gray" && policy.allowPatterns.some((p) => safeRegex(p)?.test(command))) {
    verdict = { ...verdict, decision: "allow", reason: `operator allow-pattern \xB7 ${verdict.reason}` };
  }
  let policyLayer;
  if (policy.actionPolicy?.enabled && verdict.decision !== "deny") {
    const ap = policy.actionPolicy;
    const desc = describeCommandAction({ command, origin: ap.origin, cwd: policy.workspaceRoot, scope: policy.workspaceRoot });
    const policyState = {
      enabled: true,
      rules: ap.rules,
      homeDir: ap.homeDir,
      rulesUnavailable: ap.rulesUnavailable
    };
    let pv = evaluateActionPolicy(desc, policyState);
    const boundarySideEffect = verdict.signals.length > 0;
    if (pv.layer === "proactive" && !boundarySideEffect) {
      pv = evaluateActionPolicy({ ...desc, capabilities: ["read"] }, policyState);
    }
    if (pv.decision === "deny" || pv.decision === "draft_only") {
      verdict = { ...verdict, decision: "deny", reason: `${pv.reason} \xB7 ${verdict.reason}` };
      policyLayer = pv.layer;
    } else if (pv.decision === "ask" && verdict.decision === "allow") {
      verdict = { ...verdict, decision: "gray", reason: `${pv.reason} \xB7 ${verdict.reason}` };
      policyLayer = pv.layer;
    } else if (verdict.decision === "allow" && boundarySideEffect && isProactiveOrigin(ap.origin)) {
      verdict = { ...verdict, decision: "gray", reason: `proactive run (origin=${desc.origin}) may only read \xB7 ${verdict.reason}` };
      policyLayer = "proactive";
    }
  }
  const answer = verdict.decision === "allow" ? "y" : verdict.decision === "deny" ? "n" : "escalate";
  const audit = {
    command: String(redactSecrets(command)),
    decision: verdict.decision,
    answer,
    signals: verdict.signals,
    reason: verdict.reason,
    level: policy.level,
    ...policyLayer ? { policyLayer } : {}
  };
  return { answer, verdict, audit };
}
function safeRegex(src) {
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}

// scripts/gate-decide-entry.ts
function escalate(reason) {
  process.stdout.write(JSON.stringify({ answer: "escalate", reason: `gate-decide: ${reason}` }));
  process.exit(0);
}
var raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("error", (e) => escalate(String(e)));
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(raw || "{}");
    const command = typeof input.command === "string" ? input.command : null;
    if (command === null) return escalate("missing command");
    const rawPolicy = input.policy && typeof input.policy === "object" ? input.policy : {};
    const root = typeof rawPolicy.workspaceRoot === "string" ? rawPolicy.workspaceRoot : "";
    if (!root) return escalate("missing workspaceRoot");
    const policy = parseAutonomyPolicy(rawPolicy, root);
    process.stdout.write(JSON.stringify(decideAutoAnswer(command, policy)));
  } catch (e) {
    escalate(e?.message ?? String(e));
  }
});
