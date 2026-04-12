import React, { memo, useState } from 'react';
import { View, Image, ScrollView, StyleSheet, Text, useWindowDimensions } from 'react-native';
import { useTheme } from '@/hooks/use-theme';

type Props = { uri: string; filename: string };

export const ImageRenderer = memo(function ImageRenderer({ uri, filename }: Props) {
  const { colors } = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const [error, setError] = useState(false);

  if (error) {
    return (
      <View style={styles.errorContainer}>
        <Text style={[styles.errorText, { color: colors.muted }]}>Cannot load image: {filename}</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      maximumZoomScale={5}
      minimumZoomScale={1}
      bouncesZoom
    >
      <Image
        source={{ uri }}
        style={{ width: screenWidth - 32, height: screenWidth - 32 }}
        resizeMode="contain"
        onError={() => setError(true)}
      />
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { alignItems: 'center', padding: 16 },
  errorContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorText: { fontFamily: 'Silkscreen', fontSize: 13 },
});
