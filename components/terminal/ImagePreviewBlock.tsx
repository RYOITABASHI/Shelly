import React, { memo } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { Image } from 'expo-image';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';

type Props = {
  output: string;
  cwd: string;
};

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp)$/i;
const URL_PATTERN = /^https?:\/\//i;

function extractImagePaths(output: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const line of output.split('\n')) {
    // Match quoted paths: "path/to/file.png" or 'path/to/file.png'
    const quotedMatches = line.matchAll(/["']([^"'\s]+\.(png|jpe?g|gif|svg|webp))["']/gi);
    for (const m of quotedMatches) {
      const p = m[1];
      if (!seen.has(p)) { seen.add(p); results.push(p); }
    }

    // Match bare paths (no spaces): path/to/file.png or https://...png
    const bareMatches = line.matchAll(/(?:^|\s)((?:https?:\/\/|\/|\.\/|\.\.\/|[\w])[^\s"'<>]*\.(png|jpe?g|gif|svg|webp))(?:\s|$)/gi);
    for (const m of bareMatches) {
      const p = m[1];
      if (!seen.has(p)) { seen.add(p); results.push(p); }
    }
  }

  return results;
}

function resolveImageUri(path: string, cwd: string): string {
  if (URL_PATTERN.test(path)) {
    return path;
  }
  if (path.startsWith('file://')) {
    return path;
  }
  if (path.startsWith('/')) {
    return `file://${path}`;
  }
  // Relative path — resolve against cwd
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return `file://${base}${path}`;
}

function getFilename(path: string): string {
  return path.split('/').pop() ?? path;
}

const ImagePreviewBlock = memo(function ImagePreviewBlock({ output, cwd }: Props) {
  const paths = extractImagePaths(output);

  if (paths.length === 0) {
    return null;
  }

  return (
    <View style={styles.wrapper}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {paths.map((path, index) => {
          const uri = resolveImageUri(path, cwd);
          const filename = getFilename(path);
          return (
            <View key={`${path}-${index}`} style={styles.imageCard}>
              <Image
                source={{ uri }}
                style={styles.image}
                contentFit="contain"
                transition={200}
              />
              <Text style={styles.caption} numberOfLines={1}>
                {filename}
              </Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: {
    backgroundColor: C.bgSidebar,
    marginVertical: 8,
    marginHorizontal: 8,
    borderRadius: 8,
    overflow: 'hidden',
    paddingVertical: 8,
  },
  scroll: {
    paddingHorizontal: 8,
    gap: 12,
    alignItems: 'center',
  },
  imageCard: {
    alignItems: 'center',
    gap: 4,
    maxWidth: 260,
  },
  image: {
    width: 240,
    height: 200,
    borderRadius: 6,
    backgroundColor: C.border,
  },
  caption: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: '#666666',
    maxWidth: 240,
    textAlign: 'center',
  },
});

export { ImagePreviewBlock };
export default ImagePreviewBlock;
