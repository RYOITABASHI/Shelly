/**
 * LinkContextMenu — modal context menu that appears on long-press of a
 * detected link (URL or file path) in terminal output.
 */

import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  StyleSheet,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as Linking from 'expo-linking';

export type LinkInfo = {
  text: string;
  type: 'url' | 'filepath' | 'error';
  filePath?: string;
  line?: number;
  col?: number;
  url?: string;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  link: LinkInfo;
  position: { x: number; y: number };
  onOpenInSidebar?: (filePath: string, line?: number, col?: number) => void;
  onOpenInBrowser?: (url: string) => void;
  onCopied?: (msg: string) => void;
};

export function LinkContextMenu({
  visible,
  onClose,
  link,
  position,
  onOpenInSidebar,
  onOpenInBrowser,
  onCopied,
}: Props) {
  const isUrl = link.type === 'url';
  const isFile = link.type === 'filepath' || link.type === 'error';
  const filePath = link.filePath ?? (isFile ? link.text : undefined);
  const url = link.url ?? (isUrl ? link.text : undefined);

  const handleCopy = async () => {
    await Clipboard.setStringAsync(link.text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onCopied?.(isUrl ? 'URL copied' : 'Path copied');
    onClose();
  };

  const handleOpenInSidebar = () => {
    if (filePath && onOpenInSidebar) {
      onOpenInSidebar(filePath, link.line, link.col);
    }
    onClose();
  };

  const handleOpenInBrowser = () => {
    const target = url ?? link.text;
    if (onOpenInBrowser) {
      onOpenInBrowser(target);
    } else {
      const href = target.startsWith('www.') ? `https://${target}` : target;
      Linking.openURL(href).catch(() => {});
    }
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View style={styles.menu}>
              {/* Link preview */}
              <View style={styles.header}>
                <MaterialIcons
                  name={isUrl ? 'link' : 'insert-drive-file'}
                  size={13}
                  color="#888"
                  style={styles.headerIcon}
                />
                <Text style={styles.headerText} numberOfLines={2}>
                  {link.line != null
                    ? `${link.text} :${link.line}${link.col != null ? `:${link.col}` : ''}`
                    : link.text}
                </Text>
              </View>

              <View style={styles.divider} />

              {/* Copy action */}
              <TouchableOpacity style={styles.row} onPress={handleCopy}>
                <MaterialIcons name="content-copy" size={16} color="#AAA" />
                <Text style={styles.rowLabel}>
                  {isUrl ? 'Copy URL' : 'Copy Path'}
                </Text>
              </TouchableOpacity>

              {/* Open in Sidebar — file paths only */}
              {isFile && (
                <TouchableOpacity style={styles.row} onPress={handleOpenInSidebar}>
                  <MaterialIcons name="open-in-new" size={16} color="#00D4AA" />
                  <Text style={[styles.rowLabel, { color: '#00D4AA' }]}>
                    Open in Sidebar
                    {link.line != null ? ` (line ${link.line})` : ''}
                  </Text>
                </TouchableOpacity>
              )}

              {/* Open in Browser — URLs only */}
              {isUrl && (
                <TouchableOpacity style={styles.row} onPress={handleOpenInBrowser}>
                  <MaterialIcons name="open-in-browser" size={16} color="#4EA8DE" />
                  <Text style={[styles.rowLabel, { color: '#4EA8DE' }]}>
                    Open in Browser
                  </Text>
                </TouchableOpacity>
              )}

              <View style={styles.divider} />

              <TouchableOpacity style={styles.cancelRow} onPress={onClose}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  menu: {
    backgroundColor: '#1A1A1A',
    borderColor: '#333',
    borderWidth: 1,
    borderRadius: 12,
    width: 280,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 6,
  },
  headerIcon: {
    marginTop: 2,
  },
  headerText: {
    flex: 1,
    color: '#888',
    fontSize: 11,
    fontFamily: 'monospace',
  },
  divider: {
    height: 1,
    backgroundColor: '#333',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  rowLabel: {
    color: '#DDD',
    fontSize: 14,
  },
  cancelRow: {
    alignItems: 'center',
    paddingVertical: 13,
  },
  cancelText: {
    color: '#888',
    fontSize: 14,
  },
});
