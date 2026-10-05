#!/usr/bin/env node
/*
 * shelly-gemini-live-client.js — Gemini Live API bridge for full-duplex voice.
 *
 * Bridges the RN app's mic/speaker audio to Google's Gemini Live API
 * (BidiGenerateContent over WebSocket) so the model can be interrupted
 * mid-response instead of the old record -> Whisper -> LLM text -> TTS
 * turn-based flow (hooks/use-speech-input.ts, lib/tts.ts). Spawned as a
 * child process the same way the Codex runtime is (see HomeInitializer.kt /
 * AgentRuntime.kt) rather than trying to speak raw WebSocket audio framing
 * from inside React Native's JS engine, which has no reliable binary
 * WebSocket support (RN's `binaryType` is non-standard — see
 * https://github.com/facebook/react-native/issues/34989). The Live API's
 * actual wire format is JSON text frames with base64-encoded PCM payloads,
 * so this script — not the RN app — is the one that speaks WebSocket.
 *
 * No npm dependencies on purpose: every other bundled on-device script
 * (shelly-capability-broker.js, shelly-plan-executor.js) uses only Node
 * built-ins, because the device's bundled Node runtime ships as a bare
 * interpreter binary with no node_modules alongside it — `require('ws')`
 * would fail on-device even though it resolves fine in this repo's own
 * node_modules during development. The WebSocket client below is a minimal
 * RFC 6455 implementation (handshake via http(s).request's 'upgrade' event,
 * hand-rolled frame encode/decode) built on net/tls/http/crypto only.
 *
 * I/O contract with the native side (kept binary-clean by putting every
 * text/control message on stderr, never stdout):
 *   stdin  (binary) — raw PCM16, 16kHz, mono, little-endian audio from the
 *                      mic, streamed continuously in whatever chunk sizes
 *                      the native recorder produces. No framing: every byte
 *                      read is audio.
 *   stdout (binary) — raw PCM16, 24kHz, mono, little-endian audio to play
 *                      back to the speaker. Same no-framing contract.
 *   stderr (text)   — one JSON object per line (control/event channel):
 *       {"type":"ready"}                          connected, setup acked
 *       {"type":"turn_complete"}                  model finished a turn
 *       {"type":"interrupted"}                    server detected the user
 *                                                  talking over the model
 *                                                  and cancelled its turn
 *       {"type":"input_transcript","text":"..."}  live transcript of what
 *                                                  the user said (partial or
 *                                                  final per Live API events)
 *       {"type":"output_transcript","text":"..."} live transcript of the
 *                                                  model's spoken response
 *       {"type":"error","message":"..."}          fatal — process exits
 *                                                  after emitting this
 *
 * Auth: the API key is read from GEMINI_API_KEY in the environment, never
 * argv (argv is visible via `ps`/`/proc` on Android same as anywhere else —
 * same reasoning as the capability broker's SECRET-001 auth-ref handling in
 * scripts/shelly-capability-broker.js, just simpler since there's only ever
 * one key here).
 *
 * Exit codes:
 *   0   clean shutdown (stdin closed / parent sent SIGTERM)
 *   1   usage error (no API key)
 *   2   WebSocket connect/handshake failure
 *   3   fatal protocol error reported by the server
 */

'use strict';

const https = require('https');
const crypto = require('crypto');

const MODEL = process.env.GEMINI_LIVE_MODEL || 'models/gemini-2.5-flash-native-audio-preview-09-2025';
const HOST = 'generativelanguage.googleapis.com';
const PATH_PREFIX = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

function emit(event) {
  process.stderr.write(JSON.stringify(event) + '\n');
}

function fail(code, message) {
  emit({ type: 'error', message });
  process.exit(code);
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey || apiKey.trim().length === 0) {
  fail(1, 'GEMINI_API_KEY not set');
}

// ---------------------------------------------------------------------------
// Minimal RFC 6455 WebSocket client (client -> server frames MUST be masked;
// server -> client frames arrive unmasked). Handles text + binary frames,
// continuation-frame reassembly, ping/pong, and close. No compression
// (Sec-WebSocket-Extensions is not offered), which the Live API doesn't
// require.
// ---------------------------------------------------------------------------

const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function encodeFrame(opcode, payload) {
  const payloadLen = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (payloadLen < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payloadLen;
  } else if (payloadLen < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payloadLen, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payloadLen), 2);
  }
  header[0] = 0x80 | opcode; // FIN=1, opcode
  const masked = Buffer.alloc(payloadLen);
  for (let i = 0; i < payloadLen; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

// Streaming frame parser: feed it socket bytes, it calls onFrame(opcode, payload)
// for each COMPLETE (already-reassembled-across-continuations) message.
function createFrameParser(onFrame) {
  let buf = Buffer.alloc(0);
  let fragments = null; // Buffer[] while reassembling a fragmented message
  let fragmentOpcode = null;

  function tryParseOne() {
    if (buf.length < 2) return false;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0; // server frames must NOT be masked, but tolerate it
    let payloadLen = buf[1] & 0x7f;
    let offset = 2;
    if (payloadLen === 126) {
      if (buf.length < offset + 2) return false;
      payloadLen = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (buf.length < offset + 8) return false;
      payloadLen = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }
    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return false;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + payloadLen) return false;
    let payload = buf.subarray(offset, offset + payloadLen);
    if (masked) {
      const unmasked = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }
    buf = buf.subarray(offset + payloadLen);

    if (opcode === OPCODE.CONTINUATION) {
      if (fragments) fragments.push(Buffer.from(payload));
      if (fin && fragments) {
        const full = Buffer.concat(fragments);
        const finishedOpcode = fragmentOpcode;
        fragments = null;
        fragmentOpcode = null;
        onFrame(finishedOpcode, full);
      }
    } else if (!fin && (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY)) {
      fragments = [Buffer.from(payload)];
      fragmentOpcode = opcode;
    } else {
      onFrame(opcode, payload);
    }
    return true;
  }

  return {
    push(chunk) {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      while (tryParseOne()) {
        /* drain all complete frames currently buffered */
      }
    },
  };
}

const wsKey = crypto.randomBytes(16).toString('base64');
const req = https.request({
  host: HOST,
  path: `${PATH_PREFIX}?key=${encodeURIComponent(apiKey)}`,
  method: 'GET',
  headers: {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Key': wsKey,
    'Sec-WebSocket-Version': '13',
  },
});

req.on('error', (err) => fail(2, `Connect failed: ${err.message}`));

req.on('upgrade', (res, socket) => {
  if (res.statusCode !== 101) {
    fail(2, `Unexpected upgrade status ${res.statusCode}`);
    return;
  }

  let setupAcked = false;
  const pendingAudioChunks = [];

  function send(opcode, payload) {
    socket.write(encodeFrame(opcode, payload));
  }
  function sendJson(obj) {
    send(OPCODE.TEXT, Buffer.from(JSON.stringify(obj), 'utf8'));
  }
  function sendAudioChunk(chunk) {
    sendJson({
      realtimeInput: {
        audio: { mimeType: 'audio/pcm;rate=16000', data: chunk.toString('base64') },
      },
    });
  }

  sendJson({
    setup: {
      model: MODEL,
      generationConfig: { responseModalities: ['AUDIO'] },
      // Server-side automatic VAD (the default) is exactly what makes
      // "interrupted" events happen without this script needing its own
      // voice-activity detection — see the file header.
      realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  });

  const parser = createFrameParser((opcode, payload) => {
    if (opcode === OPCODE.PING) {
      send(OPCODE.PONG, payload);
      return;
    }
    if (opcode === OPCODE.CLOSE) {
      socket.end();
      process.exit(setupAcked ? 0 : 2);
      return;
    }
    if (opcode !== OPCODE.TEXT) return; // Live API never sends binary frames

    let msg;
    try {
      msg = JSON.parse(payload.toString('utf8'));
    } catch {
      return;
    }

    if (msg.setupComplete) {
      setupAcked = true;
      emit({ type: 'ready' });
      for (const chunk of pendingAudioChunks) sendAudioChunk(chunk);
      pendingAudioChunks.length = 0;
      return;
    }

    if (msg.serverContent) {
      const sc = msg.serverContent;
      if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
        for (const part of sc.modelTurn.parts) {
          const inline = part.inlineData;
          if (inline && typeof inline.data === 'string' && (inline.mimeType || '').startsWith('audio/')) {
            process.stdout.write(Buffer.from(inline.data, 'base64'));
          }
        }
      }
      if (sc.inputTranscription && typeof sc.inputTranscription.text === 'string') {
        emit({ type: 'input_transcript', text: sc.inputTranscription.text });
      }
      if (sc.outputTranscription && typeof sc.outputTranscription.text === 'string') {
        emit({ type: 'output_transcript', text: sc.outputTranscription.text });
      }
      if (sc.interrupted) emit({ type: 'interrupted' });
      if (sc.turnComplete) emit({ type: 'turn_complete' });
      return;
    }

    if (msg.error) {
      fail(3, typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error));
    }
  });

  socket.on('data', (chunk) => parser.push(chunk));
  socket.on('error', (err) => fail(2, `Socket error: ${err.message}`));
  socket.on('close', () => process.exit(setupAcked ? 0 : 2));

  process.stdin.on('data', (chunk) => {
    if (!setupAcked) {
      pendingAudioChunks.push(chunk);
      return;
    }
    sendAudioChunk(chunk);
  });

  // Parent closes stdin (EOF) to end the conversation cleanly.
  process.stdin.on('end', () => {
    try {
      send(OPCODE.CLOSE, Buffer.alloc(0));
    } catch {
      // ignore
    }
    socket.end();
  });

  process.on('SIGTERM', () => {
    try {
      send(OPCODE.CLOSE, Buffer.alloc(0));
      socket.end();
    } catch {
      // ignore
    }
    process.exit(0);
  });
});

req.end();
