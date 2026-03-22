/**
 * SaveBadge — Animated 💾 icon in ChatHeader.
 * Shows for 2 seconds after a savepoint is created, then fades out.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet } from 'react-native';
import { useSavepointStore } from '@/store/savepoint-store';

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
  }, [showBadge]);

  return (
    <Animated.Text style={[styles.badge, { opacity }]}>
      💾
    </Animated.Text>
  );
}

const styles = StyleSheet.create({
  badge: {
    fontSize: 14,
    marginLeft: 6,
  },
});
