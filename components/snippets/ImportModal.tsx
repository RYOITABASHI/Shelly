/**
 * components/snippets/ImportModal.tsx
 *
 * Modal for importing snippets from a JSON file.
 *
 * Flow:
 *  1. User taps "Import" → modal opens
 *  2. User picks a .json file via DocumentPicker
 *  3. JSON is validated; errors shown inline
 *  4. User chooses duplicate strategy (Skip / Overwrite / Keep both)
 *  5. Preview shows counts (new / duplicate)
 *  6. User confirms → merge applied → summary shown
 */

import React, { useState, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import {
  validateSnippetJson,
  mergeSnippets,
  importSummaryText,
  validationErrorLabel,
  DuplicateStrategy,
  SnippetExportPayload,
  ImportResult,
  ValidationError,
} from '@/lib/snippet-io';
import { useSnippetStore } from '@/store/snippet-store';

// ─── Types ────────────────────────────────────────────────────────────────────

type Step =
  | 'idle'
  | 'validating'
  | 'preview'
  | 'importing'
  | 'done'
  | 'error';

type Props = {
  visible: boolean;
  onClose: () => void;
};

// ─── Component ────────────────────────────────────────────────────────────────

export function ImportModal({ visible, onClose }: Props) {
  const { snippets, setSnippets } = useSnippetStore();

  const [step, setStep] = useState<Step>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [payload, setPayload] = useState<SnippetExportPayload | null>(null);
  const [strategy, setStrategy] = useState<DuplicateStrategy>('skip');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const duplicateCount = payload
    ? payload.snippets.filter((inc) =>
        snippets.some(
          (e) => e.command === inc.command.trim() && e.scope === inc.scope
        )
      ).length
    : 0;
  const newCount = payload ? payload.snippets.length - duplicateCount : 0;

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handlePickFile = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/json',
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;

      setStep('validating');
      const uri = result.assets[0].uri;
      const raw = await FileSystem.readAsStringAsync(uri);
      const validation = validateSnippetJson(raw);

      if (!validation.ok) {
        setErrorMsg(validationErrorLabel((validation as { ok: false; error: ValidationError }).error));
        setStep('error');
        return;
      }

      setPayload(validation.payload);
      setStep('preview');
    } catch (_e) {
      setErrorMsg('ファイルの読み込みに失敗しました');
      setStep('error');
    }
  }, [snippets]);

  const handleImport = useCallback(async () => {
    if (!payload) return;
    setStep('importing');
    const result = mergeSnippets(snippets, payload.snippets, strategy);
    setSnippets(result.mergedSnippets);
    setImportResult(result);
    setStep('done');
  }, [payload, snippets, strategy]);

  const handleClose = useCallback(() => {
    setStep('idle');
    setErrorMsg('');
    setPayload(null);
    setStrategy('skip');
    setImportResult(null);
    onClose();
  }, [onClose]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>スニペットをインポート</Text>
            <Pressable onPress={handleClose} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>✕</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>

            {/* idle */}
            {step === 'idle' && (
              <View style={styles.center}>
                <Text style={styles.desc}>
                  Shelly形式のJSONファイルを選択してください。
                </Text>
                <Pressable style={styles.primaryBtn} onPress={handlePickFile}>
                  <Text style={styles.primaryBtnText}>ファイルを選択</Text>
                </Pressable>
              </View>
            )}

            {/* validating */}
            {step === 'validating' && (
              <View style={styles.center}>
                <ActivityIndicator color="#00D4AA" />
                <Text style={styles.desc}>検証中...</Text>
              </View>
            )}

            {/* error */}
            {step === 'error' && (
              <View style={styles.center}>
                <Text style={styles.errorText}>{errorMsg}</Text>
                <Pressable style={styles.secondaryBtn} onPress={() => setStep('idle')}>
                  <Text style={styles.secondaryBtnText}>やり直す</Text>
                </Pressable>
              </View>
            )}

            {/* preview */}
            {step === 'preview' && payload && (
              <>
                <Text style={styles.sectionLabel}>プレビュー</Text>
                <View style={styles.previewBox}>
                  <Text style={styles.previewRow}>📦 合計: {payload.snippets.length} 件</Text>
                  <Text style={styles.previewRow}>✅ 新規: {newCount} 件</Text>
                  <Text style={styles.previewRow}>⚠️ 重複: {duplicateCount} 件</Text>
                </View>

                {duplicateCount > 0 && (
                  <>
                    <Text style={styles.sectionLabel}>重複の処理</Text>
                    {(['skip', 'overwrite', 'keepBoth'] as DuplicateStrategy[]).map((s) => (
                      <Pressable
                        key={s}
                        style={[styles.strategyBtn, strategy === s && styles.strategyBtnActive]}
                        onPress={() => setStrategy(s)}
                      >
                        <Text style={[styles.strategyBtnText, strategy === s && styles.strategyBtnTextActive]}>
                          {s === 'skip' ? 'スキップ（既存を保持）' :
                           s === 'overwrite' ? '上書き（新しいデータで更新）' :
                           '両方を保持'}
                        </Text>
                      </Pressable>
                    ))}
                  </>
                )}

                <Pressable style={styles.primaryBtn} onPress={handleImport}>
                  <Text style={styles.primaryBtnText}>インポート実行</Text>
                </Pressable>
              </>
            )}

            {/* importing */}
            {step === 'importing' && (
              <View style={styles.center}>
                <ActivityIndicator color="#00D4AA" />
                <Text style={styles.desc}>インポート中...</Text>
              </View>
            )}

            {/* done */}
            {step === 'done' && importResult && (
              <View style={styles.center}>
                <Text style={styles.doneIcon}>✅</Text>
                <Text style={styles.doneText}>完了</Text>
                <Text style={styles.desc}>{importSummaryText(importResult)}</Text>
                <Pressable style={styles.primaryBtn} onPress={handleClose}>
                  <Text style={styles.primaryBtnText}>閉じる</Text>
                </Pressable>
              </View>
            )}

          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#111111',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '80%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  title: {
    color: '#E8E8E8',
    fontSize: 15,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  closeBtn: { padding: 4 },
  closeBtnText: { color: '#6B7280', fontSize: 16 },
  body: { flex: 1 },
  bodyContent: { padding: 16, paddingBottom: 32 },
  center: { alignItems: 'center', paddingVertical: 24, gap: 12 },
  desc: { color: '#9CA3AF', fontSize: 13, fontFamily: 'monospace', textAlign: 'center' },
  errorText: { color: '#F87171', fontSize: 13, fontFamily: 'monospace', textAlign: 'center' },
  sectionLabel: {
    color: '#00D4AA',
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 16,
    marginBottom: 8,
  },
  previewBox: {
    backgroundColor: '#1A1A1A',
    borderRadius: 8,
    padding: 12,
    gap: 4,
  },
  previewRow: { color: '#E8E8E8', fontSize: 13, fontFamily: 'monospace' },
  strategyBtn: {
    backgroundColor: '#1A1A1A',
    borderRadius: 8,
    padding: 12,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#2D2D2D',
  },
  strategyBtnActive: { borderColor: '#00D4AA', backgroundColor: '#00D4AA15' },
  strategyBtnText: { color: '#9CA3AF', fontSize: 13, fontFamily: 'monospace' },
  strategyBtnTextActive: { color: '#00D4AA' },
  primaryBtn: {
    backgroundColor: '#00D4AA',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
    marginTop: 16,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#0A0A0A', fontSize: 14, fontWeight: '700', fontFamily: 'monospace' },
  secondaryBtn: {
    backgroundColor: '#1A1A1A',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: '#2D2D2D',
  },
  secondaryBtnText: { color: '#E8E8E8', fontSize: 13, fontFamily: 'monospace' },
  doneIcon: { fontSize: 40 },
  doneText: { color: '#00D4AA', fontSize: 18, fontWeight: '700', fontFamily: 'monospace' },
});
