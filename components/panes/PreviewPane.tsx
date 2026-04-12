/**
 * components/panes/PreviewPane.tsx
 *
 * Standalone preview pane wrapper. Hosts the existing PreviewTabs (Web /
 * Code / Files) so it can live anywhere in the multi-pane layout — e.g.
 * "2 Col" with terminal on the left and live preview on the right.
 *
 * This is intentionally a thin shim. PreviewTabs already manages its own
 * state via preview-store; the only reason it needs an onClose handler is
 * because it was originally an overlay inside TerminalPane. As a real
 * pane, "close" means "switch to a different pane type" via the header
 * pill, so onClose is a no-op.
 */

import React from 'react';
import { PreviewTabs } from '@/components/preview/PreviewTabs';

export default function PreviewPane() {
  // No onClose: PreviewTabs hides its own tab-bar close button when this is
  // omitted, so the user doesn't see a dead button next to the pane header's
  // close icon.
  return <PreviewTabs />;
}
