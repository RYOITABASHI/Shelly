/**
 * components/creator/ImportProjectsModal.tsx
 *
 * Modal for importing Creator projects from a JSON file.
 *
 * Flow:
 *  1. User taps "Import" → modal opens (idle)
 *  2. User picks a .json file via DocumentPicker
 *  3. JSON is validated; errors shown inline
 *  4. User chooses duplicate strategy (Skip / Overwrite / Keep both)
 *  5. Preview shows counts (new / duplicate)
 *  6. User confirms → merge applied → summary shown
 *
 * Mirrors ImportModal.tsx (Snippets) for UX consistency.
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
  Platform,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import {
  parseProjectExportPayload,
  resolveProjectImport,
  applyProjectImport,
  ProjectExportPayload,
  ProjectImportResult,
  DuplicateAction,
} from '@/lib/project-io';
import { useCreatorStore } from '@/store/creator-store';
import { useTranslation } from '@/lib/i18n';

// ─── Types ────────────────────────────────────────────────────────────────────

type Step =
  | 'idle'        // waiting for file pick
  | 'validating'  // parsing JSON
  | 'preview'     // show counts + strategy picker
  | 'importing'   // applying merge
  | 'done'        // show summary
  | 'error';      // validation / file error

// ─── Component ────────────────────────────────────────────────────────────────

type Props = {
  visible: boolean;
  onClose: () => void;
};

export function ImportProjectsModal({ visible, onClose }: Props) {
  const { t } = useTranslation();
  const { projects, setProjects } = useCreatorStore();

  const [step, setStep] = useState<Step>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [payload, setPayload] = useState<ProjectExportPayload | null>(null);
  const [strategy, setStrategy] = useState<DuplicateAction>('skip');
  const [importResult, setImportResult] = useState<ProjectImportResult | null>(null);

  // Count duplicates for preview
  const duplicateCount = payload
    ? payload.projects.filter((inc) =>
        projects.some(
          (e) => e.id === inc.id || (e.name === inc.name && Math.abs(e.createdAt - inc.createdAt) < 1000)
        )
      ).length
    : 0;
  const newCount = payload ? payload.projects.length - duplicateCount : 0;

  // ── Handlers ──────────────────────────────────────────────────────────────────

  const handlePickFile = useCallback(async () => {
    setStep('validating');
    setErrorMsg('');

    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/json',
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.[0]) {
        setStep('idle');
        return;
      }

      const uri = result.assets[0].uri;
      let json: string;

      if (Platform.OS === 'web') {
        const response = await fetch(uri);
        json = await response.text();
      } else {
        json = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.UTF8,
        });
      }

      const parsed = parseProjectExportPayload(json);
      if (!parsed) {
        setErrorMsg(t('import_projects.invalid_json'));
        setStep('error');
        return;
      }

      setPayload(parsed);
      setStep('preview');
    } catch (e) {
      setErrorMsg(t('import_projects.read_error'));
      setStep('error');
    }
  }, []);

  const handleImport = useCallback(async () => {
    if (!payload) return;
    setStep('importing');

    try {
      // Process in a microtask to avoid blocking UI
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const result = resolveProjectImport(payload, projects, strategy);
      const newProjects = applyProjectImport(result, projects);

      setProjects(newProjects);
      setImportResult(result);
      setStep('done');
    } catch {
      setErrorMsg(t('import_projects.import_error'));
      setStep('error');
    }
  }, [payload, projects, strategy, setProjects]);

  const handleClose = useCallback(() => {
    setStep('idle');
    setErrorMsg('');
    setPayload(null);
    setImportResult(null);
    setStrategy('skip');
    onClose();
  }, [onClose]);

  const handleRetry = useCallback(() => {
    setStep('idle');
    setErrorMsg('');
    setPayload(null);
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>{t('import_projects.title')}</Text>
            <Pressable onPress={handleClose} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>✕</Text>
            </Pressable>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            showsVerticalScrollIndicator={false}
          >
            {/* ── idle: pick file ── */}
            {step === 'idle' && (
              <View style={styles.section}>
                <Text style={styles.desc}>
                  {t('import_projects.select_desc')}
                </Text>
                <Pressable style={styles.primaryBtn} onPress={handlePickFile}>
                  <Text style={styles.primaryBtnText}>{t('import_projects.select_file')}</Text>
                </Pressable>
              </View>
            )}

            {/* ── validating ── */}
            {step === 'validating' && (
              <View style={styles.centerSection}>
                <ActivityIndicator color="#00FF88" size="large" />
                <Text style={styles.loadingText}>{t('import_projects.validating')}</Text>
              </View>
            )}

            {/* ── preview: strategy picker ── */}
            {step === 'preview' && payload && (
              <View style={styles.section}>
                <View style={styles.countRow}>
                  <View style={styles.countBox}>
                    <Text style={styles.countNum}>{payload.projects.length}</Text>
                    <Text style={styles.countLabel}>{t('import_projects.total')}</Text>
                  </View>
                  <View style={styles.countBox}>
                    <Text style={[styles.countNum, { color: '#00FF88' }]}>{newCount}</Text>
                    <Text style={styles.countLabel}>{t('import_projects.new')}</Text>
                  </View>
                  <View style={styles.countBox}>
                    <Text style={[styles.countNum, { color: '#FBBF24' }]}>{duplicateCount}</Text>
                    <Text style={styles.countLabel}>{t('import_projects.duplicate')}</Text>
                  </View>
                </View>

                {duplicateCount > 0 && (
                  <>
                    <Text style={styles.sectionLabel}>{t('import_projects.duplicate_method')}</Text>
                    {(['skip', 'overwrite', 'keep-both'] as DuplicateAction[]).map((opt) => (
                      <Pressable
                        key={opt}
                        style={[styles.strategyBtn, strategy === opt && styles.strategyBtnActive]}
                        onPress={() => setStrategy(opt)}
                      >
                        <View style={styles.strategyRow}>
                          <View style={[styles.radio, strategy === opt && styles.radioActive]} />
                          <View style={styles.strategyText}>
                            <Text style={[styles.strategyLabel, strategy === opt && styles.strategyLabelActive]}>
                              {opt === 'skip' ? t('import_projects.strategy_skip') : opt === 'overwrite' ? t('import_projects.strategy_overwrite') : t('import_projects.strategy_keep_both')}
                            </Text>
                            <Text style={styles.strategyDesc}>
                              {opt === 'skip'
                                ? t('import_projects.strategy_skip_desc')
                                : opt === 'overwrite'
                                ? t('import_projects.strategy_overwrite_desc')
                                : t('import_projects.strategy_keep_both_desc')}
                            </Text>
                          </View>
                        </View>
                      </Pressable>
                    ))}
                  </>
                )}

                <Pressable style={styles.primaryBtn} onPress={handleImport}>
                  <Text style={styles.primaryBtnText}>{t('import_projects.import_btn')}</Text>
                </Pressable>
              </View>
            )}

            {/* ── importing ── */}
            {step === 'importing' && (
              <View style={styles.centerSection}>
                <ActivityIndicator color="#00FF88" size="large" />
                <Text style={styles.loadingText}>{t('import_projects.importing')}</Text>
              </View>
            )}

            {/* ── done: summary ── */}
            {step === 'done' && importResult && (
              <View style={styles.section}>
                <Text style={styles.successTitle}>{t('import_projects.success_title')}</Text>
                <View style={styles.summaryGrid}>
                  <SummaryRow label={t('import_projects.summary_added')} value={importResult.addCount} color="#00FF88" />
                  <SummaryRow label={t('import_projects.summary_updated')} value={importResult.updateCount} color="#60A5FA" />
                  <SummaryRow label={t('import_projects.summary_skipped')} value={importResult.skipCount} color="#9BA1A6" />
                  <SummaryRow label={t('import_projects.summary_failed')} value={importResult.failCount} color="#F87171" />
                </View>
                <Pressable style={styles.primaryBtn} onPress={handleClose}>
                  <Text style={styles.primaryBtnText}>{t('import_projects.close')}</Text>
                </Pressable>
              </View>
            )}

            {/* ── error ── */}
            {step === 'error' && (
              <View style={styles.section}>
                <Text style={styles.errorTitle}>{t('import_projects.error_title')}</Text>
                <Text style={styles.errorMsg}>{errorMsg}</Text>
                <Pressable style={styles.secondaryBtn} onPress={handleRetry}>
                  <Text style={styles.secondaryBtnText}>{t('import_projects.retry')}</Text>
                </Pressable>
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SummaryRow({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={[styles.summaryValue, { color }]}>{value}</Text>
    </View>
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
    backgroundColor: '#1A1A1A',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '80%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
  },
  title: {
    color: '#ECEDEE',
    fontSize: 16,
    fontWeight: '600',
  },
  closeBtn: {
    padding: 4,
  },
  closeBtnText: {
    color: '#9BA1A6',
    fontSize: 16,
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: 20,
  },
  section: {
    gap: 16,
  },
  centerSection: {
    alignItems: 'center',
    paddingVertical: 40,
    gap: 16,
  },
  desc: {
    color: '#9BA1A6',
    fontSize: 14,
    lineHeight: 20,
  },
  loadingText: {
    color: '#9BA1A6',
    fontSize: 14,
  },
  countRow: {
    flexDirection: 'row',
    gap: 12,
  },
  countBox: {
    flex: 1,
    backgroundColor: '#111',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  countNum: {
    color: '#ECEDEE',
    fontSize: 24,
    fontWeight: '700',
  },
  countLabel: {
    color: '#9BA1A6',
    fontSize: 11,
    marginTop: 2,
  },
  sectionLabel: {
    color: '#9BA1A6',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 4,
  },
  strategyBtn: {
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderRadius: 8,
    padding: 12,
    backgroundColor: '#111',
  },
  strategyBtnActive: {
    borderColor: '#00FF88',
    backgroundColor: '#0D1F17',
  },
  strategyRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  radio: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#9BA1A6',
    marginTop: 2,
  },
  radioActive: {
    borderColor: '#00FF88',
    backgroundColor: '#00FF88',
  },
  strategyText: {
    flex: 1,
    gap: 2,
  },
  strategyLabel: {
    color: '#9BA1A6',
    fontSize: 14,
  },
  strategyLabelActive: {
    color: '#00FF88',
  },
  strategyDesc: {
    color: '#687076',
    fontSize: 12,
    lineHeight: 16,
  },
  primaryBtn: {
    backgroundColor: '#00FF88',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#0D0D0D',
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: '#9BA1A6',
    fontSize: 14,
  },
  successTitle: {
    color: '#00FF88',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  summaryGrid: {
    backgroundColor: '#111',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    overflow: 'hidden',
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  summaryLabel: {
    color: '#9BA1A6',
    fontSize: 14,
  },
  summaryValue: {
    fontSize: 20,
    fontWeight: '700',
  },
  errorTitle: {
    color: '#F87171',
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  errorMsg: {
    color: '#9BA1A6',
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
});
