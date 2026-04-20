// components/layout/ShellyModal.tsx
//
// Drop-in wrapper around React Native's Modal that guarantees the active
// terminal regains keyboard focus when the modal dismisses. On Android
// edge-to-edge (Expo 54 / RN 0.81) the activity's mCurrentFocus drops to
// null after a Modal closes — the soft keyboard stays visible but no view
// receives commitText, so the user has to tap the terminal before typing
// works again. bug #112.
//
// Earlier attempts wrapped only `onRequestClose` (Android back button)
// which left close-X buttons, backdrop taps, and "OK" buttons leaking
// the focus loss back into individual callsites. The fix here is to
// observe the `visible` prop transitioning from true to false — every
// dismiss path eventually flips that prop, so triggering refocus on
// the transition catches all of them in one place.
//
// Usage — replace `<Modal ...>` with `<ShellyModal ...>` everywhere
// that's not deliberately handing focus to a different field.

import React, { useEffect, useRef } from 'react';
import { Modal, type ModalProps } from 'react-native';
import { useFocusStore } from '@/store/focus-store';

type Props = ModalProps & {
  /** Suppress the auto-refocus on dismiss. Use only for modals that
   *  intentionally hand focus to a different field (e.g. nested sheet). */
  skipRefocus?: boolean;
};

export function ShellyModal({ skipRefocus, visible, ...rest }: Props) {
  const wasVisible = useRef(false);
  useEffect(() => {
    // Trailing-edge detection: refocus only on the true → false transition,
    // not on initial mount or repeated false → false renders.
    if (wasVisible.current && !visible && !skipRefocus) {
      useFocusStore.getState().requestTerminalRefocus();
    }
    wasVisible.current = !!visible;
  }, [visible, skipRefocus]);
  return <Modal {...rest} visible={visible} />;
}
