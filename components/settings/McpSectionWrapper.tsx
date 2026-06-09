// components/settings/McpSectionWrapper.tsx
//
// Adapter that lets the existing McpSection (designed for the Termux
// bridge era with isConnected + onRunCommand props) run on Plan B's
// in-process JNI execCommand. Keeps McpSection.tsx untouched.

import React, { useCallback } from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import { colors as C } from '@/theme.config';
import { McpSection } from './McpSection';
import { ModalHeader } from './ModalHeader';
import { execCommand } from '@/hooks/use-native-exec';
import { useTranslation } from '@/lib/i18n';

type Props = {
  onClose: () => void;
};

export function McpSectionWrapper({ onClose }: Props) {
  const { t } = useTranslation();
  // onRunCommand mirror that used to route through the Termux bridge.
  // Now it calls execCommand directly and adapts the result shape to
  // whatever McpSection expects: { success, output }.
  const handleRun = useCallback(
    async (command: string, _label: string) => {
      const r = await execCommand(command, 120_000);
      return {
        success: r.exitCode === 0,
        output: (r.stdout ?? '') + (r.stderr ?? ''),
      };
    },
    [],
  );

  return (
    <View style={styles.root}>
      <ModalHeader title={t('mcp.title')} onClose={onClose} />
      <ScrollView style={styles.body}>
        <McpSection isConnected={true} onRunCommand={handleRun} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bgDeep,
  },
  body: {
    flex: 1,
  },
});
