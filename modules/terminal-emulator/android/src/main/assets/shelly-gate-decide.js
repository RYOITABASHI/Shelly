// GENERATED from scripts/gate-decide-entry.ts — do not edit. Regenerate: pnpm build:gate

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
function checkCommandSafety(command) {
  if (!command || !command.trim()) {
    return { level: "SAFE", message: "", reason: "" };
  }
  const cleaned = command.replace(/#[^\n]*/g, "").trim();
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
function isWithinRoot(root, target) {
  if (target.startsWith("~")) return false;
  const r = normalizePath(root).replace(/\/$/, "");
  const t = normalizePath(target.startsWith("/") ? target : `${r}/${target}`);
  return t === r || t.startsWith(`${r}/`);
}
function extractPaths(command) {
  return command.split(/\s+/).map((t) => t.replace(/^[<>|&]+/, "").replace(/[;,]+$/, "")).filter(
    (t) => t.length > 0 && !t.startsWith("-") && (t.includes("/") || t.startsWith("~") || t === "." || t.startsWith("./") || t.startsWith("../"))
  );
}
var NETWORK_RE = /\b(curl|wget|nc|ncat|netcat|scp|sftp|ssh|rsync|telnet)\b/;
var READ_ONLY_RE = /^\s*(cat|less|more|head|tail|grep|rg|ls|find|stat|file|wc|diff|git\s+(status|log|diff|show))\b/;
function classifyProposedCommand(command, ctx) {
  const signals = [];
  const secretPaths = ctx.secretPaths ?? DEFAULT_SECRET_PATHS;
  const safety = checkCommandSafety(command);
  if (ctx.policyPath && new RegExp(`>\\s*\\S*${escapeRe(ctx.policyPath)}|\\b(tee|cp|mv)\\b[^|]*${escapeRe(ctx.policyPath)}`).test(command)) {
    return { decision: "deny", signals: ["policy-write"], reason: "agent attempted to write the policy/autonomy file", dangerLevel: safety.level };
  }
  if (safety.level === "CRITICAL") {
    return { decision: "deny", signals: ["destructive"], reason: safety.reason, dangerLevel: safety.level };
  }
  if (safety.level === "HIGH") signals.push("destructive");
  const paths = extractPaths(command);
  if (paths.some((p) => secretPaths.some((s) => normalizePath(p).includes(s)))) signals.push("secret-read");
  if (paths.some((p) => !isWithinRoot(ctx.workspaceRoot, p))) signals.push("leaves-root");
  if (NETWORK_RE.test(command)) signals.push("network-send");
  const isPureRead = READ_ONLY_RE.test(command) && !signals.includes("network-send");
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
    case "L3":
      return { decision: "allow", signals, reason: signals.length ? `L3 (audited): ${reason}` : "L3", dangerLevel: safety.level };
  }
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// lib/agent-policy.ts
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
  return {
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
    policyPath: policy.policyPath
  };
  let verdict = classifyProposedCommand(command, ctx);
  if (policy.denyPatterns.some((p) => safeRegex(p)?.test(command))) {
    verdict = { ...verdict, decision: "deny", reason: `operator deny-pattern \xB7 ${verdict.reason}` };
  } else if (verdict.decision === "gray" && policy.allowPatterns.some((p) => safeRegex(p)?.test(command))) {
    verdict = { ...verdict, decision: "allow", reason: `operator allow-pattern \xB7 ${verdict.reason}` };
  }
  const answer = verdict.decision === "allow" ? "y" : verdict.decision === "deny" ? "n" : "escalate";
  const audit = {
    command: String(redactSecrets(command)),
    decision: verdict.decision,
    answer,
    signals: verdict.signals,
    reason: verdict.reason,
    level: policy.level
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
