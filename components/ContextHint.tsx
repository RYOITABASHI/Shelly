import React, { useEffect } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import Animated, { FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { getHint, markHintSeen } from '../lib/context-hint-manager';

interface ContextHintProps {
  hintId: string;
  onDismiss: () => void;
}

export function ContextHint({ hintId, onDismiss }: ContextHintProps) {
  const hint = getHint(hintId);
  const opacity = useSharedValue(1);

  useEffect(() => {
    markHintSeen(hintId);

    // Start fade-out after 9s, complete at 10s
    opacity.value = withDelay(9000, withTiming(0, { duration: 1000 }));

    const timer = setTimeout(() => {
      onDismiss();
    }, 10000);

    return () => clearTimeout(timer);
  }, [hintId]); // eslint-disable-line react-hooks/exhaustive-deps

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  if (!hint) return null;

  return (
    <Animated.View
      entering={FadeIn.duration(300)}
      exiting={FadeOut.duration(300)}
      style={animatedStyle}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 2 }}>
        <Text
          style={{
            fontSize: 10,
            color: '#666',
            flexShrink: 1,
          }}
          numberOfLines={1}
        >
          {hint.hint}
        </Text>
        <TouchableOpacity
          onPress={onDismiss}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={{ marginLeft: 6 }}
        >
          <Text style={{ fontFamily: 'Silkscreen', fontSize: 10, color: '#555' }}>×</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

export default ContextHint;
