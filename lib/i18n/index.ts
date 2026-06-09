/**
 * lib/i18n/index.ts — Internationalization engine
 *
 * Lightweight i18n using expo-localization for locale detection.
 * Translation files are plain objects — easy for community PRs.
 */
import { getLocales } from 'expo-localization';
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useMemo } from 'react';
import en from './locales/en';
import ja from './locales/ja';

export type Locale = 'en' | 'ja';

const LOCALES: Record<Locale, Record<string, string>> = { en, ja };

const STORAGE_KEY = '@shelly/locale';

// ── Zustand store ────────────────────────────────────────────────────────────

type I18nState = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  loadLocale: () => Promise<void>;
};

export const useI18n = create<I18nState>((set) => ({
  locale: detectLocale(),
  setLocale: (locale) => {
    set({ locale });
    AsyncStorage.setItem(STORAGE_KEY, locale).catch(() => {});
  },
  loadLocale: async () => {
    try {
      const saved = await AsyncStorage.getItem(STORAGE_KEY);
      if (saved && (saved === 'en' || saved === 'ja')) {
        set({ locale: saved });
        return;
      }
    } catch {
      // AsyncStorage unavailable (SSR etc.)
    }
    // 保存値がなければ再検出（SSR→クライアント遷移時に正しい値になる）
    set({ locale: detectLocale() });
  },
}));

function detectLocale(): Locale {
  try {
    // Web: navigator.languages > navigator.language
    if (typeof navigator !== 'undefined') {
      const langs = navigator.languages ?? [navigator.language];
      if (langs.some(l => l?.startsWith('ja'))) return 'ja';
    }
    // Native: expo-localization
    const locales = getLocales();
    const lang = locales[0]?.languageCode ?? 'en';
    return lang === 'ja' ? 'ja' : 'en';
  } catch {
    // SSR(Node.js) or detection failure → English default for OSS
    return 'en';
  }
}

// ── Translation function ─────────────────────────────────────────────────────

/**
 * Get translated string by key.
 * Supports interpolation: t('hello_name', { name: 'John' }) => "Hello, John!"
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const locale = useI18n.getState().locale;
  let text = LOCALES[locale]?.[key] ?? LOCALES.en[key] ?? key;

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
    }
  }

  return text;
}

/**
 * React hook version — re-renders on locale change.
 */
export function useTranslation() {
  const locale = useI18n((s) => s.locale);

  const translate = useCallback((key: string, params?: Record<string, string | number>): string => {
    let text = LOCALES[locale]?.[key] ?? LOCALES.en[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
      }
    }
    return text;
  }, [locale]);

  return useMemo(() => ({ t: translate, locale }), [translate, locale]);
}

/**
 * Get current locale outside React components (for system prompts etc.)
 */
export function getCurrentLocale(): Locale {
  return useI18n.getState().locale;
}

export const AVAILABLE_LOCALES: Array<{ code: Locale; label: string; nativeLabel: string }> = [
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'ja', label: 'Japanese', nativeLabel: '日本語' },
];
