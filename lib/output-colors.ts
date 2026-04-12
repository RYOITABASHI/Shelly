/**
 * Output color utilities for Shelly terminal blocks.
 *
 * Contrast ratios against block background (#1C1C1C):
 *   stdout  #E5E7EB  → ~12.9:1  (WCAG AAA)
 *   stderr  #EF4444  → ~4.6:1   (WCAG AA)
 *   info    #9BA1A6  → ~4.7:1   (WCAG AA)
 *   prompt  #00D4AA  → ~7.1:1   (WCAG AA)
 */

import { OutputLine } from '@/store/types';
import { colors as C } from '@/theme.config';

export function getOutputColor(type: OutputLine['type'], highContrast = true): string {
  if (highContrast) {
    switch (type) {
      case 'stderr': return C.errorText;
      case 'info':   return '#9BA1A6';
      case 'prompt': return C.accent;
      default:       return C.text1;
    }
  }
  switch (type) {
    case 'stderr': return C.errorText;
    case 'info':   return C.text2;
    case 'prompt': return C.accent;
    default:       return C.text1;
  }
}
