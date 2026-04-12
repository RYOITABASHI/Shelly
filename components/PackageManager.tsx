/**
 * PackageManager.tsx — Bundled Tools status panel
 *
 * Shows version info for tools bundled inside the APK.
 * No Termux pkg dependency. Additional packages can be
 * installed via npm/pip/etc. as guided in the panel.
 */
import React, { useState, useCallback, useEffect } from 'react';
import { colors as C } from '@/theme.config';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Modal,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { execCommand } from '@/hooks/use-native-exec';



const BUNDLED_TOOLS = [
  { name: 'bash',     cmd: 'bash --version | head -1' },
  { name: 'Node.js',  cmd: 'node --version' },
  { name: 'Python',   cmd: 'python3 --version' },
  { name: 'git',      cmd: 'git --version' },
  { name: 'curl',     cmd: 'curl --version | head -1' },
  { name: 'sqlite3',  cmd: 'sqlite3 --version | head -1' },
] as const;

type ToolStatus = {
  name: string;
  version: string | null;
  checking: boolean;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Kept for API compatibility — not used in this panel */
  onRunCommand: (command: string) => void;
  isConnected: boolean;
};

export function PackageManager({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [tools, setTools] = useState<ToolStatus[]>(
    BUNDLED_TOOLS.map((t) => ({ name: t.name, version: null, checking: false })),
  );
  const [checked, setChecked] = useState(false);

  const runChecks = useCallback(async () => {
    // Mark all as checking
    setTools(BUNDLED_TOOLS.map((t) => ({ name: t.name, version: null, checking: true })));
    setChecked(false);

    const results = await Promise.all(
      BUNDLED_TOOLS.map(async (tool) => {
        try {
          const res = await execCommand(tool.cmd, 5_000);
          const raw = (res.stdout || res.stderr || '').trim();
          return { name: tool.name, version: raw || null, checking: false };
        } catch {
          return { name: tool.name, version: null, checking: false };
        }
      }),
    );

    setTools(results);
    setChecked(true);
  }, []);

  // Run checks each time the modal opens
  useEffect(() => {
    if (visible) {
      runChecks();
    }
  }, [visible, runChecks]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={styles.header}>
          <MaterialIcons name="build-circle" size={20} color={C.accent} />
          <Text style={styles.headerTitle}>Bundled Tools</Text>
          <View style={styles.headerActions}>
            <Pressable style={styles.headerBtn} onPress={runChecks}>
              <MaterialIcons name="refresh" size={18} color="#6B7280" />
            </Pressable>
            <Pressable style={styles.headerBtn} onPress={onClose}>
              <MaterialIcons name="close" size={18} color="#6B7280" />
            </Pressable>
          </View>
        </View>

        <ScrollView
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 16 }]}
          keyboardShouldPersistTaps="handled"
        >
          {/* Tool rows */}
          {tools.map((tool) => (
            <View key={tool.name} style={styles.toolRow}>
              <View style={styles.toolStatus}>
                {tool.checking ? (
                  <ActivityIndicator size="small" color={C.accent} />
                ) : tool.version ? (
                  <MaterialIcons name="check-circle" size={18} color={C.accent} />
                ) : (
                  <MaterialIcons name="cancel" size={18} color="#F87171" />
                )}
              </View>
              <View style={styles.toolInfo}>
                <Text style={styles.toolName}>{tool.name}</Text>
                {tool.checking ? (
                  <Text style={styles.toolVersion}>checking…</Text>
                ) : tool.version ? (
                  <Text style={styles.toolVersion} numberOfLines={1}>
                    {tool.version}
                  </Text>
                ) : (
                  <Text style={styles.toolMissing}>not found</Text>
                )}
              </View>
            </View>
          ))}

          {/* Additional tools guidance */}
          {checked && (
            <View style={styles.guidanceBox}>
              <MaterialIcons name="info-outline" size={16} color="#6B7280" />
              <View style={styles.guidanceText}>
                <Text style={styles.guidanceTitle}>Need more tools?</Text>
                <Text style={styles.guidanceBody}>
                  Install Node packages:{'\n'}
                  <Text style={styles.codeSnippet}>npm install -g {'<package>'}</Text>
                </Text>
                <Text style={styles.guidanceBody}>
                  Install Python packages:{'\n'}
                  <Text style={styles.codeSnippet}>pip install {'<package>'}</Text>
                </Text>
              </View>
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1E1E1E',
    gap: 8,
  },
  headerTitle: {
    color: '#ECEDEE',
    fontSize: 16,
    fontWeight: '700',
    fontFamily: 'monospace',
    flex: 1,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerBtn: {
    padding: 6,
    borderRadius: 6,
    backgroundColor: '#1A1A1A',
  },
  listContent: {
    paddingHorizontal: 14,
    paddingTop: 12,
    gap: 6,
  },
  toolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#141414',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1E1E1E',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
    marginBottom: 4,
  },
  toolStatus: {
    width: 22,
    alignItems: 'center',
  },
  toolInfo: {
    flex: 1,
    gap: 2,
  },
  toolName: {
    color: '#ECEDEE',
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  toolVersion: {
    color: '#4B5563',
    fontSize: 10,
    fontFamily: 'monospace',
  },
  toolMissing: {
    color: '#F87171',
    fontSize: 10,
    fontFamily: 'monospace',
  },
  guidanceBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#141414',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1E1E1E',
    padding: 12,
    gap: 10,
    marginTop: 8,
  },
  guidanceText: {
    flex: 1,
    gap: 6,
  },
  guidanceTitle: {
    color: '#9BA1A6',
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '700',
    marginBottom: 4,
  },
  guidanceBody: {
    color: '#6B7280',
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 18,
  },
  codeSnippet: {
    color: C.accent,
    fontFamily: 'monospace',
    fontSize: 11,
  },
});
