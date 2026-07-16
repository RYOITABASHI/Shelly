// MEMORY-001 memory layer — pure base64 codec for Track A envelope encryption.
//
// Deliberately dependency-free (no Buffer, no atob/btoa): Buffer is a Node
// global that RN/Hermes does not provide, and atob/btoa availability is not
// guaranteed either. This tiny codec runs identically in host tests and on
// device, and is the ONLY string encoding encryption-key.ts / crypto-expo.ts
// use for DEK bytes and envelope iv/ciphertext fields.

const BASE64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const hasB1 = i + 1 < bytes.length;
    const hasB2 = i + 2 < bytes.length;
    const b1 = hasB1 ? bytes[i + 1] : 0;
    const b2 = hasB2 ? bytes[i + 2] : 0;
    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += hasB1 ? BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += hasB2 ? BASE64_CHARS[b2 & 0x3f] : '=';
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of b64) {
    if (ch === '=' || ch === '\n' || ch === '\r') continue;
    const val = BASE64_CHARS.indexOf(ch);
    if (val === -1) continue; // ignore stray whitespace defensively
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}
