/**
 * Browser Screen — Shelly AI Browser
 * WebView ベースのインアプリブラウザ
 * - アドレスバー（URL入力・移動）
 * - 進む / 戻る / 更新 / ホーム
 * - ブックマーク（長押し保存・一覧モーダル）
 * - 共有（システム共有シート）
 * - AI アシスト（ページ要約・選択テキスト質問）
 */
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Clipboard from 'expo-clipboard';

import { useBookmarkStore, type Bookmark } from '@/store/bookmark-store';
import { useTerminalStore } from '@/store/terminal-store';
import { useRouter } from 'expo-router';
import { useTranslation } from '@/lib/i18n';

// ─── Constants ────────────────────────────────────────────────────────────────

const HOME_URL = 'https://www.google.com';
const COLORS = {
  bg: '#0A0A0A',
  surface: '#141414',
  surfaceHigh: '#1E1E1E',
  border: '#2A2A2A',
  text: '#E8E8E8',
  muted: '#6B7280',
  accent: '#00D4AA',
  accentDim: '#00D4AA33',
  error: '#FF7878',
  warning: '#FBBF24',
  ai: '#7C3AED',
  aiDim: '#7C3AED33',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return HOME_URL;
  // すでに URL スキームがある
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // ドット含む → URL として扱う
  if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(trimmed) && !trimmed.includes(' ')) {
    return `https://${trimmed}`;
  }
  // それ以外 → Google 検索
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function BookmarkRow({
  item,
  onOpen,
  onDelete,
}: {
  item: Bookmark;
  onOpen: (url: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <View style={styles.bmRow}>
      <Pressable
        style={styles.bmRowContent}
        onPress={() => onOpen(item.url)}
      >
        <MaterialIcons name="bookmark" size={16} color={COLORS.accent} style={{ marginRight: 8 }} />
        <View style={{ flex: 1 }}>
          <Text style={styles.bmTitle} numberOfLines={1}>{item.title || getDomain(item.url)}</Text>
          <Text style={styles.bmUrl} numberOfLines={1}>{item.url}</Text>
        </View>
      </Pressable>
      <Pressable onPress={() => onDelete(item.id)} style={styles.bmDeleteBtn}>
        <MaterialIcons name="close" size={16} color={COLORS.muted} />
      </Pressable>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function BrowserScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);

  // Navigation state
  const [currentUrl, setCurrentUrl] = useState(HOME_URL);
  const [inputUrl, setInputUrl] = useState('');
  const [isAddressBarFocused, setIsAddressBarFocused] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [pageTitle, setPageTitle] = useState('');
  const [loadProgress, setLoadProgress] = useState(0);

  // UI state
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showAiPanel, setShowAiPanel] = useState(false);
  const [aiSummary, setAiSummary] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');

  // Stores
  const { bookmarks, loadBookmarks, addBookmark, removeBookmark, isBookmarked } = useBookmarkStore();
  const { settings, insertCommand } = useTerminalStore();
  const router = useRouter();

  // ── Terminalで開く ─────────────────────────────────────────────────────────────────
  const handleOpenInTerminal = useCallback(() => {
    insertCommand(`curl -L "${currentUrl}"`);
    router.push('/(tabs)' as any);
  }, [currentUrl, insertCommand, router]);

  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);

  // @open コマンドからのURL遷移を受け取る
  useEffect(() => {
    const state = useTerminalStore.getState() as any;
    if (state.pendingBrowserUrl) {
      navigate(state.pendingBrowserUrl);
      useTerminalStore.setState({ pendingBrowserUrl: null } as any);
    }
  }, []);

  // ── Navigation ──────────────────────────────────────────────────────────────

  const navigate = useCallback((url: string) => {
    const normalized = normalizeUrl(url);
    setCurrentUrl(normalized);
    setInputUrl('');
    Keyboard.dismiss();
  }, []);

  const handleAddressSubmit = () => {
    navigate(inputUrl || currentUrl);
  };

  const handleNavStateChange = (navState: WebViewNavigation) => {
    setCanGoBack(navState.canGoBack);
    setCanGoForward(navState.canGoForward);
    if (navState.url && navState.url !== 'about:blank') {
      setCurrentUrl(navState.url);
    }
    if (navState.title) setPageTitle(navState.title);
  };

  // ── Bookmark ────────────────────────────────────────────────────────────────

  const handleToggleBookmark = async () => {
    if (isBookmarked(currentUrl)) {
      const bm = useBookmarkStore.getState().getBookmarkByUrl(currentUrl);
      if (bm) {
        await removeBookmark(bm.id);
        Alert.alert(t('browser.bookmark_removed'), t('browser.bookmark_removed_msg', { title: pageTitle || getDomain(currentUrl) }));
      }
    } else {
      await addBookmark(currentUrl, pageTitle || getDomain(currentUrl));
      Alert.alert(t('browser.bookmark_added'), t('browser.bookmark_added_msg', { title: pageTitle || getDomain(currentUrl) }));
    }
  };

  // ── Share ───────────────────────────────────────────────────────────────────

  const handleShare = async () => {
    try {
      await Share.share({
        message: `${pageTitle ? pageTitle + '\n' : ''}${currentUrl}`,
        url: currentUrl,
        title: pageTitle || getDomain(currentUrl),
      });
    } catch {
      // user cancelled
    }
  };

  // ── Copy URL ─────────────────────────────────────────────────────────────────

  const handleCopyUrl = async () => {
    await Clipboard.setStringAsync(currentUrl);
    Alert.alert(t('browser.copied'), t('browser.copied_url'));
  };

  // ── AI Assist ───────────────────────────────────────────────────────────────

  const handleAiSummarize = async () => {
    setShowAiPanel(true);
    setAiSummary('');
    setAiError('');
    setIsAiLoading(true);

    const prompt = `Summarize the following page. Infer the content from the URL domain and title, and provide a concise summary.\n\nURL: ${currentUrl}\nPage title: ${pageTitle || 'Unknown'}`;

    try {
      // 優先順位: Perplexity → Gemini → Local LLM
      if (settings.perplexityApiKey) {
        await summarizeWithPerplexity(prompt, settings.perplexityApiKey, settings.perplexityModel);
      } else if (settings.geminiApiKey) {
        await summarizeWithGemini(prompt, settings.geminiApiKey, settings.geminiModel);
      } else if (settings.localLlmEnabled) {
        await summarizeWithLocalLlm(prompt, settings.localLlmUrl);
      } else {
        setAiError(t('browser.ai_no_provider'));
        setIsAiLoading(false);
      }
    } catch (err) {
      setAiError(`Error: ${err instanceof Error ? err.message : String(err)}`);
      setIsAiLoading(false);
    }
  };

  const summarizeWithGemini = async (prompt: string, apiKey: string, model?: string) => {
    const { geminiChatStream } = await import('@/lib/gemini');
    const result = await geminiChatStream(
      apiKey,
      prompt,
      (chunk, done) => {
        if (chunk) {
          setAiSummary((prev) => prev + chunk);
        }
        if (done) {
          setIsAiLoading(false);
        }
      },
      model ?? 'gemini-2.0-flash',
    );
    if (!result.success && !result.content) {
      throw new Error(result.error ?? 'Gemini API error');
    }
  };

  const summarizeWithPerplexity = async (
    prompt: string,
    apiKey: string,
    model?: string,
  ) => {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'sonar-reasoning-pro',
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Perplexity API error: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('Failed to read response');

    const decoder = new TextDecoder();
    let accumulated = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            accumulated += delta;
            setAiSummary(accumulated);
          }
        } catch {
          // skip
        }
      }
    }
    setIsAiLoading(false);
  };

  const summarizeWithLocalLlm = async (prompt: string, baseUrl: string) => {
    const url = `${baseUrl}/v1/chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.localLlmModel || 'default',
        messages: [
          {
            role: 'system',
            content: 'Provide a concise summary.',
          },
          { role: 'user', content: prompt },
        ],
        stream: true,
        max_tokens: 512,
      }),
    });

    if (!response.ok) {
      throw new Error(`Local LLM error: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('Failed to read response');

    const decoder = new TextDecoder();
    let accumulated = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            accumulated += delta;
            setAiSummary(accumulated);
          }
        } catch {
          // skip
        }
      }
    }
    setIsAiLoading(false);
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  const bookmarked = isBookmarked(currentUrl);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>

      {/* ── Address Bar ────────────────────────────────────────────────────── */}
      <View style={styles.addressBar}>
        {/* Back / Forward */}
        <Pressable
          onPress={() => webViewRef.current?.goBack()}
          disabled={!canGoBack}
          style={[styles.navBtn, !canGoBack && styles.navBtnDisabled]}
        >
          <MaterialIcons name="arrow-back" size={20} color={canGoBack ? COLORS.text : COLORS.muted} />
        </Pressable>
        <Pressable
          onPress={() => webViewRef.current?.goForward()}
          disabled={!canGoForward}
          style={[styles.navBtn, !canGoForward && styles.navBtnDisabled]}
        >
          <MaterialIcons name="arrow-forward" size={20} color={canGoForward ? COLORS.text : COLORS.muted} />
        </Pressable>

        {/* URL Input */}
        <View style={styles.urlInputWrapper}>
          {!isAddressBarFocused && (
            <MaterialIcons
              name="lock"
              size={12}
              color={currentUrl.startsWith('https') ? COLORS.accent : COLORS.muted}
              style={{ marginRight: 4 }}
            />
          )}
          <TextInput
            style={styles.urlInput}
            value={isAddressBarFocused ? inputUrl : (pageTitle || getDomain(currentUrl))}
            onChangeText={setInputUrl}
            onFocus={() => {
              setIsAddressBarFocused(true);
              setInputUrl(currentUrl);
            }}
            onBlur={() => setIsAddressBarFocused(false)}
            onSubmitEditing={handleAddressSubmit}
            placeholder={t('browser.enter_url')}
            placeholderTextColor={COLORS.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            selectTextOnFocus
          />
          {isAddressBarFocused && inputUrl.length > 0 && (
            <Pressable onPress={() => setInputUrl('')} style={{ padding: 4 }}>
              <MaterialIcons name="close" size={16} color={COLORS.muted} />
            </Pressable>
          )}
        </View>

        {/* Reload / Stop */}
        <Pressable
          onPress={() => isLoading ? webViewRef.current?.stopLoading() : webViewRef.current?.reload()}
          style={styles.navBtn}
        >
          <MaterialIcons
            name={isLoading ? 'close' : 'refresh'}
            size={20}
            color={COLORS.text}
          />
        </Pressable>
      </View>

      {/* ── Progress Bar ───────────────────────────────────────────────────── */}
      {isLoading && (
        <View style={styles.progressBarBg}>
          <View style={[styles.progressBarFill, { width: `${loadProgress * 100}%` }]} />
        </View>
      )}

      {/* ── WebView ────────────────────────────────────────────────────────── */}
      <WebView
        ref={webViewRef}
        source={{ uri: currentUrl }}
        style={styles.webView}
        onNavigationStateChange={handleNavStateChange}
        onLoadStart={() => setIsLoading(true)}
        onLoadEnd={() => setIsLoading(false)}
        onLoadProgress={({ nativeEvent }) => setLoadProgress(nativeEvent.progress)}
        javaScriptEnabled
        domStorageEnabled
        allowsBackForwardNavigationGestures
        pullToRefreshEnabled
        renderLoading={() => (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator color={COLORS.accent} size="large" />
          </View>
        )}
        startInLoadingState
      />

      {/* ── Bottom Toolbar ─────────────────────────────────────────────────── */}
      <View style={[styles.toolbar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {/* Home */}
        <Pressable onPress={() => navigate(HOME_URL)} style={styles.toolBtn}>
          <MaterialIcons name="home" size={22} color={COLORS.muted} />
          <Text style={styles.toolLabel}>{t('browser.home')}</Text>
        </Pressable>

        {/* Bookmark */}
        <Pressable onPress={handleToggleBookmark} style={styles.toolBtn}>
          <MaterialIcons
            name={bookmarked ? 'bookmark' : 'bookmark-border'}
            size={22}
            color={bookmarked ? COLORS.accent : COLORS.muted}
          />
          <Text style={[styles.toolLabel, bookmarked && { color: COLORS.accent }]}>
            {bookmarked ? t('browser.saved') : t('browser.save')}
          </Text>
        </Pressable>

        {/* Bookmark List */}
        <Pressable onPress={() => setShowBookmarks(true)} style={styles.toolBtn}>
          <MaterialIcons name="list" size={22} color={COLORS.muted} />
          <Text style={styles.toolLabel}>{t('browser.list')}</Text>
        </Pressable>

        {/* Share */}
        <Pressable onPress={handleShare} style={styles.toolBtn}>
          <MaterialIcons name="share" size={22} color={COLORS.muted} />
          <Text style={styles.toolLabel}>{t('browser.share')}</Text>
        </Pressable>

        {/* Copy URL */}
        <Pressable onPress={handleCopyUrl} style={styles.toolBtn}>
          <MaterialIcons name="content-copy" size={22} color={COLORS.muted} />
          <Text style={styles.toolLabel}>{t('browser.copy')}</Text>
        </Pressable>

        {/* AI Summarize */}
        <Pressable onPress={handleAiSummarize} style={styles.toolBtn}>
          <MaterialIcons name="auto-awesome" size={22} color={COLORS.ai} />
          <Text style={[styles.toolLabel, { color: COLORS.ai }]}>AI</Text>
        </Pressable>

        {/* Terminalで開く (curl) */}
        <Pressable onPress={handleOpenInTerminal} style={styles.toolBtn}>
          <MaterialIcons name="terminal" size={22} color="#4ADE80" />
          <Text style={[styles.toolLabel, { color: '#4ADE80' }]}>curl</Text>
        </Pressable>
      </View>

      {/* ── Bookmark List Modal ─────────────────────────────────────────────── */}
      <Modal
        visible={showBookmarks}
        animationType="slide"
        transparent
        onRequestClose={() => setShowBookmarks(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setShowBookmarks(false)}>
          <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('browser.bookmarks')}</Text>
              <Pressable onPress={() => setShowBookmarks(false)}>
                <MaterialIcons name="close" size={20} color={COLORS.muted} />
              </Pressable>
            </View>
            {bookmarks.length === 0 ? (
              <View style={styles.emptyState}>
                <MaterialIcons name="bookmark-border" size={40} color={COLORS.muted} />
                <Text style={styles.emptyText}>{t('browser.no_bookmarks')}</Text>
                <Text style={styles.emptySubText}>{t('browser.no_bookmarks_hint')}</Text>
              </View>
            ) : (
              <FlatList
                data={bookmarks}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => (
                  <BookmarkRow
                    item={item}
                    onOpen={(url) => {
                      setShowBookmarks(false);
                      navigate(url);
                    }}
                    onDelete={removeBookmark}
                  />
                )}
                style={{ maxHeight: 400 }}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── AI Panel Modal ──────────────────────────────────────────────────── */}
      <Modal
        visible={showAiPanel}
        animationType="slide"
        transparent
        onRequestClose={() => setShowAiPanel(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setShowAiPanel(false)}>
          <Pressable style={[styles.modalSheet, { maxHeight: '70%' }]} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <MaterialIcons name="auto-awesome" size={18} color={COLORS.ai} />
                <Text style={[styles.modalTitle, { color: COLORS.ai }]}>{t('browser.ai_summary')}</Text>
              </View>
              <Pressable onPress={() => setShowAiPanel(false)}>
                <MaterialIcons name="close" size={20} color={COLORS.muted} />
              </Pressable>
            </View>

            {/* Page info */}
            <View style={styles.aiPageInfo}>
              <MaterialIcons name="link" size={12} color={COLORS.muted} style={{ marginRight: 4 }} />
              <Text style={styles.aiPageUrl} numberOfLines={1}>{getDomain(currentUrl)}</Text>
            </View>

            {/* Content */}
            {isAiLoading && !aiSummary ? (
              <View style={styles.aiLoading}>
                <ActivityIndicator color={COLORS.ai} />
                <Text style={styles.aiLoadingText}>
                  {settings.perplexityApiKey
                    ? t('browser.ai_searching')
                    : settings.geminiApiKey
                    ? t('browser.ai_gemini')
                    : t('browser.ai_local')}
                </Text>
              </View>
            ) : aiError ? (
              <View style={styles.aiError}>
                <MaterialIcons name="error-outline" size={20} color={COLORS.error} />
                <Text style={styles.aiErrorText}>{aiError}</Text>
              </View>
            ) : (
              <View style={{ padding: 16 }}>
                <Text style={styles.aiSummaryText}>
                  {aiSummary}
                  {isAiLoading && <Text style={{ color: COLORS.ai }}>▋</Text>}
                </Text>
                {!isAiLoading && aiSummary ? (
                  <Pressable
                    style={styles.aiCopyBtn}
                    onPress={async () => {
                      await Clipboard.setStringAsync(aiSummary);
                      Alert.alert(t('browser.copied'), t('browser.summary_copied'));
                    }}
                  >
                    <MaterialIcons name="content-copy" size={14} color={COLORS.ai} />
                    <Text style={styles.aiCopyBtnText}>{t('browser.copy_summary')}</Text>
                  </Pressable>
                ) : null}
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },

  // Address bar
  addressBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 4,
  },
  navBtn: {
    padding: 6,
    borderRadius: 6,
  },
  navBtnDisabled: {
    opacity: 0.3,
  },
  urlInputWrapper: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surfaceHigh,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === 'ios' ? 8 : 4,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  urlInput: {
    flex: 1,
    color: COLORS.text,
    fontSize: 13,
    fontFamily: 'monospace',
  },

  // Progress bar
  progressBarBg: {
    height: 2,
    backgroundColor: COLORS.border,
  },
  progressBarFill: {
    height: 2,
    backgroundColor: COLORS.accent,
  },

  // WebView
  webView: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: COLORS.bg,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Bottom toolbar
  toolbar: {
    flexDirection: 'row',
    backgroundColor: COLORS.surface,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop: 8,
    paddingHorizontal: 4,
  },
  toolBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    gap: 2,
  },
  toolLabel: {
    fontSize: 9,
    color: COLORS.muted,
    fontFamily: 'monospace',
  },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingBottom: 32,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  modalTitle: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '600',
    fontFamily: 'monospace',
  },

  // Bookmark list
  bmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  bmRowContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
  },
  bmTitle: {
    color: COLORS.text,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  bmUrl: {
    color: COLORS.muted,
    fontSize: 11,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  bmDeleteBtn: {
    padding: 12,
  },

  // Empty state
  emptyState: {
    alignItems: 'center',
    padding: 32,
    gap: 8,
  },
  emptyText: {
    color: COLORS.text,
    fontSize: 14,
    fontFamily: 'monospace',
  },
  emptySubText: {
    color: COLORS.muted,
    fontSize: 12,
    fontFamily: 'monospace',
    textAlign: 'center',
  },

  // AI panel
  aiPageInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  aiPageUrl: {
    color: COLORS.muted,
    fontSize: 11,
    fontFamily: 'monospace',
    flex: 1,
  },
  aiLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 24,
  },
  aiLoadingText: {
    color: COLORS.muted,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  aiError: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 16,
  },
  aiErrorText: {
    color: COLORS.error,
    fontSize: 13,
    fontFamily: 'monospace',
    flex: 1,
    lineHeight: 18,
  },
  aiSummaryText: {
    color: COLORS.text,
    fontSize: 13,
    fontFamily: 'monospace',
    lineHeight: 20,
  },
  aiCopyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 12,
    alignSelf: 'flex-start',
    backgroundColor: COLORS.aiDim,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.ai,
  },
  aiCopyBtnText: {
    color: COLORS.ai,
    fontSize: 12,
    fontFamily: 'monospace',
  },
});
