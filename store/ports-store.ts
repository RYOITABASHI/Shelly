// store/ports-store.ts
//
// Active localhost ports poller. On Plan B (no Termux, no iproute2) the
// `ss` / `netstat` / `lsof` binaries are not bundled, so we read
// `/proc/net/tcp` and `/proc/net/tcp6` directly and decode the hex
// `local_address` / `st` columns. The Sidebar is the single writer —
// it owns the 15 s interval and publishes into this store, same
// pattern as git-status-store, so the list stays stable across
// renders without multiple components racing each other.

import { create } from 'zustand';

export type PortEntry = {
  port: number;
  /** '127.0.0.1' | '0.0.0.0' | '::1' | '::' — wildcard/loopback only. */
  address: string;
  /** Process label if we could resolve it; '' otherwise. */
  name: string;
};

type PortsState = {
  entries: PortEntry[];
  setEntries: (entries: PortEntry[]) => void;
};

export const usePortsStore = create<PortsState>((set) => ({
  entries: [],
  setEntries: (entries) => set({ entries }),
}));

// ── /proc/net/tcp parser ────────────────────────────────────────────
// Format (one line per socket, whitespace separated):
//
//   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid ...
//    0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 ...
//
// `local_address` for IPv4 is 8 hex chars (little-endian IP) + ':' + 4
// hex chars (big-endian port). For IPv6 the IP portion is 32 hex chars
// (four 32-bit little-endian words). `st == 0A` means LISTEN.
//
// We keep only wildcard / loopback binds because anything else is a
// remote interface the user can't usefully open from the pane.

const STATE_LISTEN = '0A';

function decodePort(hex: string): number {
  const n = parseInt(hex, 16);
  return Number.isFinite(n) ? n : -1;
}

function decodeIPv4(hex: string): string {
  // 8 hex chars, little-endian byte order.
  if (hex.length !== 8) return '';
  const b0 = parseInt(hex.slice(6, 8), 16);
  const b1 = parseInt(hex.slice(4, 6), 16);
  const b2 = parseInt(hex.slice(2, 4), 16);
  const b3 = parseInt(hex.slice(0, 2), 16);
  return `${b0}.${b1}.${b2}.${b3}`;
}

function decodeIPv6(hex: string): string {
  // 32 hex chars: four 32-bit little-endian words. We only need to
  // recognise the all-zero wildcard and the ::1 loopback, so the
  // rendering is deliberately minimal.
  if (hex.length !== 32) return '';
  // Reverse bytes inside each 4-byte word.
  const bytes: number[] = [];
  for (let w = 0; w < 4; w++) {
    const word = hex.slice(w * 8, w * 8 + 8);
    for (let i = 3; i >= 0; i--) {
      bytes.push(parseInt(word.slice(i * 2, i * 2 + 2), 16));
    }
  }
  const allZero = bytes.every((b) => b === 0);
  if (allZero) return '::';
  // IPv4-mapped ::ffff:a.b.c.d
  const isV4Mapped =
    bytes.slice(0, 10).every((b) => b === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (isV4Mapped) return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  // ::1
  const isLoopback =
    bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1;
  if (isLoopback) return '::1';
  // Full expansion, good enough for debug listings.
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    parts.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  }
  return parts.join(':');
}

function isWildcardOrLoopback(addr: string): boolean {
  return (
    addr === '0.0.0.0' ||
    addr === '127.0.0.1' ||
    addr.startsWith('127.') ||
    addr === '::' ||
    addr === '::1'
  );
}

type ParseOpts = { family: 'v4' | 'v6' };

function parseProcNetTcp(raw: string, opts: ParseOpts): PortEntry[] {
  if (!raw) return [];
  const out: PortEntry[] = [];
  const lines = raw.split('\n');
  // First line is the header ("  sl  local_address ..."), skip it.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    // sl local rem st ... — need at least 4 cols.
    if (cols.length < 4) continue;
    const local = cols[1];
    const state = cols[3];
    if (state !== STATE_LISTEN) continue;
    const colon = local.indexOf(':');
    if (colon === -1) continue;
    const ipHex = local.slice(0, colon);
    const portHex = local.slice(colon + 1);
    const port = decodePort(portHex);
    if (port <= 0) continue;
    const address = opts.family === 'v4' ? decodeIPv4(ipHex) : decodeIPv6(ipHex);
    if (!address) continue;
    if (!isWildcardOrLoopback(address)) continue;
    out.push({ port, address, name: '' });
  }
  return out;
}

/**
 * Parse both /proc/net/tcp and /proc/net/tcp6, merge, dedupe by port
 * (preferring wildcard over loopback when both exist — same listener),
 * and sort ascending.
 */
export function parseProcNet(rawV4: string, rawV6: string): PortEntry[] {
  const all = [...parseProcNetTcp(rawV4, { family: 'v4' }), ...parseProcNetTcp(rawV6, { family: 'v6' })];
  const byPort = new Map<number, PortEntry>();
  for (const e of all) {
    const prev = byPort.get(e.port);
    if (!prev) {
      byPort.set(e.port, e);
      continue;
    }
    // Prefer 0.0.0.0 / :: (wildcard) over loopback for display clarity.
    const prevWild = prev.address === '0.0.0.0' || prev.address === '::';
    const curWild = e.address === '0.0.0.0' || e.address === '::';
    if (!prevWild && curWild) byPort.set(e.port, e);
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

// ── Well-known port → friendly label ────────────────────────────────
// Falls back to the process name (if we ever resolve it) then to the
// numeric port.
const WELL_KNOWN: Record<number, string> = {
  80:    'HTTP',
  443:   'HTTPS',
  3000:  'NEXT.JS',
  3001:  'DEV',
  4000:  'DEV',
  4200:  'ANGULAR',
  5000:  'FLASK',
  5173:  'VITE',
  5174:  'VITE',
  6006:  'STORYBOOK',
  8000:  'DEV',
  8080:  'HTTP',
  8081:  'EXPO',
  8787:  'WRANGLER',
  8888:  'JUPYTER',
  9999:  'NETCAT',
  11434: 'OLLAMA',
  19000: 'EXPO',
  19001: 'EXPO',
  19002: 'EXPO',
};

export function portLabel(entry: PortEntry): string {
  const well = WELL_KNOWN[entry.port];
  if (well) return well;
  if (entry.name) return entry.name.toUpperCase();
  return '';
}
