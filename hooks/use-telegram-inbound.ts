/**
 * hooks/use-telegram-inbound.ts — Phase 3 inbound gateway poller.
 *
 * Long-polls Telegram getUpdates and, for messages from the SINGLE authorized
 * chat, enqueues a sanitized @agent utterance (store/inbound-store) and fires a
 * notification. It NEVER creates or runs an agent — a focused AI pane drains the
 * queue into the existing confirm-card pipeline, where the human taps Confirm and
 * the usual secret-guard / command-safety / approval checks apply. Inbound is
 * therefore never wider than a locally typed @agent utterance.
 *
 * Gated entirely by settings (enabled + token + authorized chat id). Pure authz
 * + parsing lives in lib/telegram-inbound.ts (unit-tested).
 */
import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { useSettingsStore } from '@/store/settings-store';
import { useInboundStore } from '@/store/inbound-store';
import { getApiKey } from '@/lib/secure-store';
import {
  buildGetUpdatesUrl,
  isInboundConfigured,
  processGetUpdates,
  type TelegramGetUpdates,
} from '@/lib/telegram-inbound';
import { logInfo, logError } from '@/lib/debug-logger';

const POLL_TIMEOUT_MS = 35_000; // a touch over Telegram's 30s long-poll
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
// Floor between iterations so a misbehaving upstream that 200-returns instantly
// (or an empty long-poll that resolves immediately) can't hot-loop the CPU/radio.
const MIN_ITERATION_MS = 1_000;

// Module-level generation guard: only the newest effect instance's loop runs, so
// a config flip-flop or a StrictMode double-mount can't leave two pollers racing
// the same offset (Telegram rejects concurrent getUpdates with 409 anyway).
let activePollerGeneration = 0;

export function useTelegramInbound(): void {
  const enabled = useSettingsStore((s) => s.settings.telegramInboundEnabled);
  const authorizedChatId = useSettingsStore((s) => s.settings.telegramAuthorizedChatId);

  useEffect(() => {
    const myGeneration = ++activePollerGeneration;
    let disposed = false;
    let offset: number | null = null;
    let consecutiveFailures = 0;
    const isCurrent = () => !disposed && myGeneration === activePollerGeneration;

    const enqueueInbound = useInboundStore.getState().enqueue;

    // The notification deliberately carries NO message text: an authorized user
    // could include a secret, and the notification shade/log is a readable surface
    // the secret-guard hasn't seen yet. Surface only that a request arrived.
    const notify = async () => {
      try {
        await Notifications.scheduleNotificationAsync({
          content: {
            title: 'Telegram → @agent',
            body: 'New request — open Shelly to review and confirm.',
            data: { source: 'telegram-inbound' },
          },
          trigger: null,
        });
      } catch {
        // notifications are best-effort
      }
    };

    const loop = async () => {
      while (isCurrent()) {
        const iterationStart = Date.now();
        const token = (await getApiKey('telegramBotToken'))?.trim() || '';
        if (!isInboundConfigured({ enabled, token, authorizedChatId })) {
          // Config changed out from under us (token cleared, etc.) — stop.
          return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
        try {
          const url = buildGetUpdatesUrl(token, offset);
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok) {
            throw new Error(`getUpdates HTTP ${res.status}`);
          }
          const data = (await res.json()) as TelegramGetUpdates;
          const { utterances, nextOffset } = processGetUpdates(data, authorizedChatId, offset);
          if (nextOffset != null) offset = nextOffset;
          consecutiveFailures = 0;

          for (const u of utterances) {
            if (!isCurrent()) return;
            // Never log the message text (even authorized) at info level to keep
            // the log a non-leak surface; log only that one arrived.
            logInfo('TelegramInbound', `authorized inbound (update ${u.updateId})`);
            enqueueInbound(u.text, 'telegram');
            void notify();
          }
        } catch {
          if (!isCurrent()) return;
          consecutiveFailures += 1;
          // Don't log the error object (could include the token in the URL) — just the count.
          logError('TelegramInbound', `poll failed (x${consecutiveFailures})`);
          const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), BACKOFF_MAX_MS);
          await new Promise((r) => setTimeout(r, backoff));
        } finally {
          clearTimeout(timer);
        }
        // Floor: never iterate faster than MIN_ITERATION_MS, so an instant 200/empty
        // response can't spin the loop hot. A normal long-poll takes ~30s, so this is
        // a no-op then; the backoff above already exceeds the floor on failures.
        const elapsed = Date.now() - iterationStart;
        if (isCurrent() && elapsed < MIN_ITERATION_MS) {
          await new Promise((r) => setTimeout(r, MIN_ITERATION_MS - elapsed));
        }
      }
    };

    if (isInboundConfigured({ enabled, token: 'pending', authorizedChatId })) {
      // token presence is re-checked inside the loop (it lives in SecureStore).
      logInfo('TelegramInbound', 'inbound poller starting');
      void loop();
    }

    return () => {
      disposed = true;
    };
  }, [enabled, authorizedChatId]);
}
