/**
 * Offline guard for memory text that may carry personally sensitive
 * information broader than lib/secret-guard.ts's credential/secret patterns
 * (see DEFERRED.md MEMORY-001, Track C — 2026-07-16 plan).
 *
 * Same shape and design constraints as secret-guard.ts: pure rule-based
 * regex/keyword matching, no ML, no network calls. It records only match
 * KINDS, never the matched value, so classifier output itself never becomes
 * a new leak surface.
 *
 * Scope note: secret-guard.ts's 'email-and-phone' kind only fires when BOTH
 * an email AND a phone number appear together in the same text. This guard
 * is deliberately broader and catches categories secret-guard never looks
 * for at all — standalone phone numbers, physical addresses, government-ID
 * shapes, health/employment/financial disclosures, and name self-disclosure
 * — i.e. "non-secret-pattern sensitive prose" that would slip past
 * secret-guard entirely. The two scanners stay separate and are NOT merged:
 * secret-guard's job is "would leaking this hand someone a credential",
 * pii-guard's job is "would leaking this expose something personal about a
 * human". A text can trip one, both, or neither.
 *
 * This is a coarse taint SIGNAL for routing decisions (MODEL-001
 * RunRequirements.touchesPii), not a redaction/DLP engine — false positives
 * are expected and acceptable (fail toward flagging), false negatives are
 * inherent to any pure-regex approach and are not a goal to eliminate here.
 */

export type PiiGuardKind =
  | 'physical-address'
  | 'phone-number'
  | 'government-id'
  | 'health-condition'
  | 'financial-detail'
  | 'employment-sensitive'
  | 'full-name-disclosure';

export interface PiiGuardResult {
  hasPii: boolean;
  kinds: PiiGuardKind[];
}

type PiiPattern = {
  kind: PiiGuardKind;
  pattern: RegExp;
};

const PII_PATTERNS: PiiPattern[] = [
  {
    // e.g. "742 Evergreen Terrace" / "1600 Pennsylvania Avenue Apt 4".
    kind: 'physical-address',
    pattern:
      /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,3}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Circle|Cir|Highway|Hwy|Parkway|Pkwy|Apt|Suite)\b\.?/i,
  },
  {
    // e.g. "東京都渋谷区1-2-3" — prefecture/city + block-number shape.
    kind: 'physical-address',
    pattern: /[都道府県].{0,15}?[市区町村].{0,15}?[0-9]{1,4}[-‐−][0-9]{1,4}/,
  },
  {
    // Standalone phone number (secret-guard only flags this when paired with
    // an email in the same text; here it stands on its own). Deliberately
    // NOT secret-guard's bare PHONE_RE (\+?\d[\d .()_-]{7,}\d): that shape
    // matches ANY 9+ char run of digit-ish characters with no separator
    // requirement, including a solid digit run embedded inside an unrelated
    // alphanumeric token (an API key, hash, or id — e.g.
    // "sk-abcdef0123456789ghjklmno"), which would wrongly tag a secret-only
    // string as PII too. Real phone numbers are conventionally grouped, so
    // this requires at least two separator-delimited digit groups (space,
    // dot, parens, hyphen, or underscore between them) — a solid, ungrouped
    // digit blob no longer matches.
    kind: 'phone-number',
    pattern: /\+?\d{1,4}(?:[ .()_-]+\d{2,4}){2,}/,
  },
  {
    // US SSN shape.
    kind: 'government-id',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/,
  },
  {
    // JP My Number / generic 12-digit national-ID grouping shape.
    kind: 'government-id',
    pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/,
  },
  {
    kind: 'health-condition',
    pattern:
      /\b(?:diagnos(?:ed|is)|prescri(?:bed|ption)|medication|chemotherapy|therapy session|mental health|depression|anxiety disorder|bipolar|schizophrenia|HIV[- ]positive|pregnan(?:t|cy))\b/i,
  },
  {
    kind: 'health-condition',
    pattern: /(?:通院してい|診断され|うつ病|精神疾患|持病があ|障害者手帳)/,
  },
  {
    kind: 'financial-detail',
    pattern: /\b(?:annual salary|take-home pay|net worth|bank balance|credit score)\b\s*(?:is|of|:)?\s*[$¥€]?[\d,]{3,}/i,
  },
  {
    kind: 'financial-detail',
    pattern: /(?:年収|手取り|貯金残高).{0,10}[0-9,，]{3,}/,
  },
  {
    kind: 'employment-sensitive',
    pattern: /\b(?:was fired|got fired|laid off|being terminated|performance improvement plan|forced resignation)\b/i,
  },
  {
    kind: 'employment-sensitive',
    pattern: /(?:解雇され|懲戒処分|退職勧奨)/,
  },
  {
    kind: 'full-name-disclosure',
    pattern: /\b(?:my (?:full )?name is|my legal name is)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/,
  },
  {
    kind: 'full-name-disclosure',
    pattern: /私(?:の)?名前は.{1,10}(?:です|といいます)/,
  },
];

export function scanForPii(text: string): PiiGuardResult {
  const kinds = new Set<PiiGuardKind>();
  for (const { kind, pattern } of PII_PATTERNS) {
    if (pattern.test(text)) {
      kinds.add(kind);
    }
  }
  return {
    hasPii: kinds.size > 0,
    kinds: [...kinds],
  };
}
