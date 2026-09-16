/**
 * SaveBadge — animated save icon in ChatHeader.
 * Shows for 2 seconds after a savepoint is created, then fades out.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSavepointStore } from '@/store/savepoint-store';
import { useSettingsStore } from '@/store/settings-store';
import { colors as C } from '@/theme.config';

export function SaveBadge() {
  const showBadge = useSavepointStore((s) => s.showBadge);
  // Case File pairs the save icon with a rapidly blinking "drive access LED"
  // dot — the save itself is an instant git commit, but the disguise is a
  // floppy drive grinding away, wolf-in-sheep's-clothing style.
  const isCaseFile = useSettingsStore((s) => s.settings.uiFont === 'case-file');
  const opacity = useRef(new Animated.Value(0)).current;
  const ledOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (showBadge) {
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.delay(1600),
        Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [showBadge, opacity]);

  useEffect(() => {
    if (!showBadge || !isCaseFile) return;
    const blink = Animated.loop(
      Animated.sequence([
        Animated.timing(ledOpacity, { toValue: 0.15, duration: 90, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(ledOpacity, { toValue: 1, duration: 90, easing: Easing.linear, useNativeDriver: true }),
      ]),
    );
    blink.start();
    return () => blink.stop();
  }, [showBadge, isCaseFile, ledOpacity]);

  return (
    <Animated.View style={{ opacity, marginLeft: 6, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
      <MaterialIcons name="save" size={14} color={C.text2} />
      {isCaseFile && (
        <Animated.View
          style={{
            width: 5,
            height: 5,
            borderRadius: 2.5,
            backgroundColor: C.errorText,
            opacity: ledOpacity,
          }}
        />
      )}
    </Animated.View>
  );
}
