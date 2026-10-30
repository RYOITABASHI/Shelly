import type { MonitorText } from '@/lib/monitor-source';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Translate a source-provided message (i18n key + params); '' for none. */
export function translateMonitorText(t: Translate, text: MonitorText | null | undefined): string {
  return text ? t(text.key, text.params) : '';
}
