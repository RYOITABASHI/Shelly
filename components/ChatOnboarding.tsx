/**
 * ChatOnboarding.tsx — チャットベースのインタラクティブオンボーディング
 *
 * SetupWizard完了後にChatタブ上部に表示される。
 * ユーザーにコマンド実行を体験させ、Cerebras/GroqのAPIキー設定を促す。
 *
 * 表示条件: onboarding未完了 && chatLoaded
 * 非表示: オンボーディング完了 or スキップ
 */
import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, Pressable, TextInput, StyleSheet, Linking } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTranslation } from '@/lib/i18n';
import { useTerminalStore } from '@/store/terminal-store';
import {
  type OnboardingStep,
  getOnboardingStep,
  setOnboardingStep,
  isOnboardingDone,
} from '@/lib/chat-onboarding';

type Props = {
  /** 現在のオンボーディングステップ */
  step: OnboardingStep;
  /** ステップ変更コールバック */
  onStepChange: (step: OnboardingStep) => void;
};

export function ChatOnboarding({ step, onStepChange }: Props) {
  const { t } = useTranslation();
  const { updateSettings } = useTerminalStore();
  const settings = useTerminalStore((s) => s.settings);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [saving, setSaving] = useState(false);

  if (step === 'complete' || step === 'skipped') return null;

  const advanceTo = async (next: OnboardingStep) => {
    await setOnboardingStep(next);
    onStepChange(next);
  };

  const handleSaveCerebras = async () => {
    const key = apiKeyInput.trim();
    if (!key) return;
    setSaving(true);
    updateSettings({ cerebrasApiKey: key });
    setApiKeyInput('');
    setSaving(false);
    await advanceTo('cerebras_done');
  };

  const handleSaveGroq = async () => {
    const key = apiKeyInput.trim();
    if (!key) return;
    setSaving(true);
    updateSettings({ groqApiKey: key });
    setApiKeyInput('');
    setSaving(false);
    await advanceTo('complete');
  };

  const handleSkip = () => advanceTo(step === 'cerebras_done' ? 'complete' : 'skipped');

  // ── Render based on step ──

  if (step === 'welcome') {
    return (
      <View style={styles.container}>
        <Text style={styles.message}>{t('onboarding.welcome')}</Text>
      </View>
    );
  }

  if (step === 'after_first_cmd') {
    return (
      <View style={styles.container}>
        <Text style={styles.message}>{t('onboarding.after_cmd')}</Text>
        <Pressable style={styles.primaryBtn} onPress={() => advanceTo('gemini_cli_bridge')}>
          <MaterialIcons name="auto-awesome" size={16} color="#000" />
          <Text style={styles.primaryBtnText}>{t('onboarding.setup_cerebras')}</Text>
        </Pressable>
        <Pressable style={styles.skipBtn} onPress={handleSkip}>
          <Text style={styles.skipText}>{t('onboarding.skip')}</Text>
        </Pressable>
      </View>
    );
  }

  if (step === 'gemini_cli_bridge') {
    return (
      <View style={styles.container}>
        <Text style={styles.message}>{t('onboarding.gemini_bridge')}</Text>
        <Pressable style={[styles.primaryBtn, { backgroundColor: '#60A5FA' }]} onPress={() => advanceTo('cerebras_setup')}>
          <MaterialIcons name="terminal" size={16} color="#000" />
          <Text style={styles.primaryBtnText}>{t('onboarding.gemini_bridge_next')}</Text>
        </Pressable>
        <Pressable style={styles.skipBtn} onPress={() => advanceTo('cerebras_setup')}>
          <Text style={styles.skipText}>{t('onboarding.try_gemini')}</Text>
        </Pressable>
      </View>
    );
  }

  if (step === 'cerebras_setup') {
    return (
      <View style={styles.container}>
        <Text style={styles.message}>{t('onboarding.cerebras_prompt')}</Text>
        <Pressable
          style={styles.linkBtn}
          onPress={() => Linking.openURL('https://cloud.cerebras.ai').catch(() => {})}
        >
          <MaterialIcons name="open-in-new" size={14} color="#A78BFA" />
          <Text style={styles.linkText}>{t('onboarding.open_browser')}</Text>
        </Pressable>
        <TextInput
          style={styles.input}
          value={apiKeyInput}
          onChangeText={setApiKeyInput}
          placeholder={t('onboarding.key_placeholder')}
          placeholderTextColor="#4B5563"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <Pressable
          style={[styles.primaryBtn, { opacity: apiKeyInput.trim() ? 1 : 0.4 }]}
          onPress={handleSaveCerebras}
          disabled={!apiKeyInput.trim() || saving}
        >
          <MaterialIcons name="check" size={16} color="#000" />
          <Text style={styles.primaryBtnText}>{t('onboarding.save_key')}</Text>
        </Pressable>
        <Pressable style={styles.skipBtn} onPress={handleSkip}>
          <Text style={styles.skipText}>{t('onboarding.skip')}</Text>
        </Pressable>
      </View>
    );
  }

  if (step === 'cerebras_done') {
    return (
      <View style={styles.container}>
        <Text style={styles.message}>{t('onboarding.cerebras_done')}</Text>
        <Pressable style={styles.primaryBtn} onPress={() => advanceTo('groq_setup')}>
          <MaterialIcons name="mic" size={16} color="#000" />
          <Text style={styles.primaryBtnText}>{t('onboarding.setup_groq')}</Text>
        </Pressable>
        <Pressable style={styles.skipBtn} onPress={handleSkip}>
          <Text style={styles.skipText}>{t('onboarding.skip')}</Text>
        </Pressable>
      </View>
    );
  }

  if (step === 'groq_setup') {
    return (
      <View style={styles.container}>
        <Text style={styles.message}>{t('onboarding.groq_prompt')}</Text>
        <Pressable
          style={styles.linkBtn}
          onPress={() => Linking.openURL('https://console.groq.com').catch(() => {})}
        >
          <MaterialIcons name="open-in-new" size={14} color="#F97316" />
          <Text style={[styles.linkText, { color: '#F97316' }]}>{t('onboarding.open_browser')}</Text>
        </Pressable>
        <TextInput
          style={styles.input}
          value={apiKeyInput}
          onChangeText={setApiKeyInput}
          placeholder={t('onboarding.key_placeholder')}
          placeholderTextColor="#4B5563"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <Pressable
          style={[styles.primaryBtn, { backgroundColor: '#F97316', opacity: apiKeyInput.trim() ? 1 : 0.4 }]}
          onPress={handleSaveGroq}
          disabled={!apiKeyInput.trim() || saving}
        >
          <MaterialIcons name="check" size={16} color="#000" />
          <Text style={styles.primaryBtnText}>{t('onboarding.save_key')}</Text>
        </Pressable>
        <Pressable style={styles.skipBtn} onPress={() => advanceTo('complete')}>
          <Text style={styles.skipText}>{t('onboarding.skip')}</Text>
        </Pressable>
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#0D0D0D',
    borderBottomWidth: 1,
    borderBottomColor: '#1E1E1E',
    padding: 16,
    gap: 10,
  },
  message: {
    color: '#D1D5DB',
    fontSize: 13,
    fontFamily: 'monospace',
    lineHeight: 20,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#A78BFA',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  primaryBtnText: {
    color: '#000',
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  linkText: {
    color: '#A78BFA',
    fontSize: 12,
    fontFamily: 'monospace',
    textDecorationLine: 'underline',
  },
  input: {
    backgroundColor: '#1A1A1A',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderRadius: 8,
    padding: 10,
    color: '#E5E7EB',
    fontSize: 13,
    fontFamily: 'monospace',
  },
  skipBtn: {
    alignItems: 'center',
    paddingVertical: 6,
  },
  skipText: {
    color: '#6B7280',
    fontSize: 11,
    fontFamily: 'monospace',
  },
});
