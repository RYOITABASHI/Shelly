/**
 * SaveBadge — animated save icon in ChatHeader.
 * Shows for 2 seconds after a savepoint is created, then fades out.
 */
import React, { useEffect, useRef } from 'react';
import { Animated } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSavepointStore } from '@/store/savepoint-store';
import { colors as C } from '@/theme.config';

export function SaveBadge() {
  const showBadge = useSavepointStore((s) => s.showBadge);
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (showBadge) {
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.delay(1600),
        Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [showBadge, opacity]);

  return (
    <Animated.View style={{ opacity, marginLeft: 6 }}>
      <MaterialIcons name="save" size={14} color={C.text2} />
    </Animated.View>
  );
}
