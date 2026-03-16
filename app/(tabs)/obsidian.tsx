/**
 * Obsidian タブ
 *
 * STEAM/EdTech 研究者向けの知識管理・発信支援画面。
 *
 * 画面遷移:
 *   briefing（一覧）→ detail（詳細）→ discuss（議論）
 *                                   → sns（SNS執筆）
 *                                   → research（論文執筆支援）
 */

import React, { useEffect, useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  FlatList,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Clipboard,
  StyleSheet,
} from 'react-native';
import { ScreenContainer } from '@/components/screen-container';
import { useObsidianStore } from '@/store/obsidian-store';
import { useTerminalStore } from '@/store/terminal-store';
import { collectBriefing } from '@/lib/obsidian-collector';
import { geminiChatStream } from '@/lib/gemini';
import { perplexitySearchStream } from '@/lib/perplexity';
import type { BriefingItem } from '@/lib/obsidian-collector';
import type { DiscussionMessage } from '@/store/obsidian-store';
import { t } from '@/lib/i18n';

// ─── カラー定数 ───────────────────────────────────────────────────────────────

const C = {
  bg: '#0D0D0D',
  surface: '#161616',
  surface2: '#1E1E1E',
  border: '#2A2A2A',
  teal: '#00D4AA',
  tealDim: '#00D4AA33',
  purple: '#8B5CF6',
  purpleDim: '#8B5CF633',
  amber: '#F59E0B',
  amberDim: '#F59E0B33',
  blue: '#3B82F6',
  blueDim: '#3B82F633',
  green: '#22C55E',
  red: '#EF4444',
  fg: '#E5E7EB',
  fgMuted: '#6B7280',
  fgDim: '#374151',
};

// ─── 型バッジ ─────────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: BriefingItem['type'] }) {
  const config = {
    paper: { label: 'Paper', color: C.purple, bg: C.purpleDim },
    article: { label: 'Article', color: C.teal, bg: C.tealDim },
    policy: { label: 'Policy', color: C.amber, bg: C.amberDim },
  }[type];
  return (
    <View style={[styles.badge, { backgroundColor: config.bg }]}>
      <Text style={[styles.badgeText, { color: config.color }]}>{config.label}</Text>
    </View>
  );
}

function CredibilityDots({ level }: { level: number }) {
  return (
    <View style={styles.credRow}>
      {[1, 2, 3, 4, 5].map(i => (
        <View
          key={i}
          style={[
            styles.credDot,
            { backgroundColor: i <= level ? C.teal : C.border },
          ]}
        />
      ))}
    </View>
  );
}

// ─── BriefingCard ─────────────────────────────────────────────────────────────

function BriefingCard({
  item,
  onPress,
}: {
  item: BriefingItem;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.75}>
      <View style={styles.cardHeader}>
        <TypeBadge type={item.type} />
        <CredibilityDots level={item.credibility} />
        {item.citationCount !== undefined && (
          <Text style={styles.citationText}>Citations {item.citationCount}</Text>
        )}
      </View>
      <Text style={styles.cardTitle} numberOfLines={2}>{item.title}</Text>
      <Text style={styles.cardSource}>{item.source}</Text>
      <Text style={styles.cardSummary} numberOfLines={3}>{item.summary}</Text>
      <View style={styles.tagRow}>
        {item.tags.slice(0, 3).map(tag => (
          <View key={tag} style={styles.tag}>
            <Text style={styles.tagText}>{tag}</Text>
          </View>
        ))}
      </View>
    </TouchableOpacity>
  );
}

// ─── Daily Briefing 一覧画面 ──────────────────────────────────────────────────

function BriefingListView() {
  const {
    todayItems,
    isCollecting,
    lastCollectionResult,
    collectionError,
    settings,
    settingsLoaded,
    loadSettings,
    loadCachedItems,
    saveCachedItems,
    setTodayItems,
    setCollecting,
    setCollectionResult,
    setCollectionError,
    selectItem,
    setView,
  } = useObsidianStore();

  const appSettings = useTerminalStore(s => s.settings);

  useEffect(() => {
    if (!settingsLoaded) loadSettings();
    loadCachedItems();
  }, []);

  const handleCollect = useCallback(async () => {
    if (isCollecting) return;
    if (!appSettings.geminiApiKey) {
      Alert.alert(t('obsidian.setup_required'), t('obsidian.setup_gemini'));
      return;
    }
    if (!settings.vaultPath) {
      Alert.alert(t('obsidian.setup_required'), t('obsidian.setup_vault'));
      return;
    }

    setCollecting(true);
    setCollectionError(null);

    try {
      const result = await collectBriefing({
        geminiApiKey: appSettings.geminiApiKey,
        perplexityApiKey: appSettings.perplexityApiKey,
        vaultPath: settings.vaultPath,
        maxItems: settings.maxItemsPerDay,
        daysBack: settings.daysBack,
      });

      setCollectionResult(result);
      setTodayItems(result.items);
      await saveCachedItems(result.items);

      if (result.errors.length > 0) {
        setCollectionError(`Partial error: ${result.errors[0]}`);
      }
    } catch (e) {
      setCollectionError(`Collection failed: ${e}`);
    } finally {
      setCollecting(false);
    }
  }, [isCollecting, appSettings, settings]);

  const handleItemPress = useCallback((item: BriefingItem) => {
    selectItem(item);
    setView('detail');
  }, []);

  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
  });

  return (
    <View style={styles.flex1}>
      {/* ヘッダー */}
      <View style={styles.listHeader}>
        <View>
          <Text style={styles.headerTitle}>📚 Daily Briefing</Text>
          <Text style={styles.headerDate}>{today}</Text>
        </View>
        <TouchableOpacity
          style={[styles.collectBtn, isCollecting && styles.collectBtnDisabled]}
          onPress={handleCollect}
          disabled={isCollecting}
          activeOpacity={0.75}
        >
          {isCollecting ? (
            <ActivityIndicator size="small" color={C.bg} />
          ) : (
            <Text style={styles.collectBtnText}>Collect</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* 収集結果サマリー */}
      {lastCollectionResult && (
        <View style={styles.resultBanner}>
          <Text style={styles.resultText}>
            ✓ {lastCollectionResult.items.length} items collected
            {lastCollectionResult.duplicatesSkipped > 0
              ? ` (${lastCollectionResult.duplicatesSkipped} duplicates skipped)`
              : ''}
            {lastCollectionResult.tokenUsage
              ? ` | Gemini: ${lastCollectionResult.tokenUsage.geminiTokens.toLocaleString()} tokens`
              : ''}
          </Text>
        </View>
      )}

      {/* エラー表示 */}
      {collectionError && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{collectionError}</Text>
        </View>
      )}

      {/* 収集中インジケーター */}
      {isCollecting && (
        <View style={styles.collectingBanner}>
          <ActivityIndicator size="small" color={C.teal} style={{ marginRight: 8 }} />
          <Text style={styles.collectingText}>
            Collecting from arXiv / Semantic Scholar / Perplexity...
          </Text>
        </View>
      )}

      {/* 記事一覧 */}
      {todayItems.length === 0 && !isCollecting ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>📭</Text>
          <Text style={styles.emptyTitle}>No briefing for today</Text>
          <Text style={styles.emptyDesc}>
            Tap &quot;Collect&quot; to fetch{'\n'}the latest STEAM/EdTech updates
          </Text>
          <TouchableOpacity style={styles.emptyBtn} onPress={handleCollect}>
            <Text style={styles.emptyBtnText}>Collect now</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={todayItems}
          keyExtractor={item => item.id}
          renderItem={({ item }) => (
            <BriefingCard item={item} onPress={() => handleItemPress(item)} />
          )}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

// ─── 記事詳細画面 ─────────────────────────────────────────────────────────────

function DetailView() {
  const { selectedItem, setView } = useObsidianStore();
  if (!selectedItem) return null;

  const item = selectedItem;

  return (
    <View style={styles.flex1}>
      {/* ナビゲーションバー */}
      <View style={styles.navBar}>
        <TouchableOpacity onPress={() => setView('briefing')} style={styles.backBtn}>
          <Text style={styles.backBtnText}>← List</Text>
        </TouchableOpacity>
        <TypeBadge type={item.type} />
      </View>

      <ScrollView style={styles.flex1} contentContainerStyle={styles.detailContent}>
        {/* タイトル */}
        <Text style={styles.detailTitle}>{item.title}</Text>
        <Text style={styles.detailOriginalTitle}>{item.originalTitle}</Text>

        {/* メタ情報 */}
        <View style={styles.metaGrid}>
          <MetaRow label="Source" value={item.source} />
          {item.doi && <MetaRow label="DOI" value={item.doi} />}
          {item.authors && item.authors.length > 0 && (
            <MetaRow label="Authors" value={item.authors.slice(0, 3).join(', ')} />
          )}
          <MetaRow label="Published" value={item.publishedAt.split('T')[0]} />
          {item.citationCount !== undefined && (
            <MetaRow label="Citations" value={`${item.citationCount}`} />
          )}
          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>Credibility</Text>
            <CredibilityDots level={item.credibility} />
          </View>
        </View>

        {/* 要約 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Summary</Text>
          <Text style={styles.summaryText}>{item.summary}</Text>
        </View>

        {/* タグ */}
        <View style={styles.tagRowWrap}>
          {item.tags.map(tag => (
            <View key={tag} style={styles.tag}>
              <Text style={styles.tagText}>{tag}</Text>
            </View>
          ))}
        </View>

        {/* アクションボタン */}
        <View style={styles.actionGrid}>
          <ActionButton
            icon="💬"
            label="Discuss"
            color={C.teal}
            onPress={() => setView('discuss')}
          />
          <ActionButton
            icon="✍️"
            label="SNS Draft"
            color={C.purple}
            onPress={() => setView('sns')}
          />
          <ActionButton
            icon="📝"
            label="Research"
            color={C.amber}
            onPress={() => setView('research')}
          />
          <ActionButton
            icon="🔗"
            label="Copy URL"
            color={C.blue}
            onPress={() => {
              Clipboard.setString(item.url);
              Alert.alert(t('obsidian.copied'), item.url);
            }}
          />
        </View>
      </ScrollView>
    </View>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue} numberOfLines={2}>{value}</Text>
    </View>
  );
}

function ActionButton({
  icon, label, color, onPress,
}: {
  icon: string; label: string; color: string; onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.actionBtn, { borderColor: color }]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <Text style={styles.actionBtnIcon}>{icon}</Text>
      <Text style={[styles.actionBtnLabel, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── 議論モード ───────────────────────────────────────────────────────────────

function DiscussView() {
  const {
    selectedItem,
    discussionHistory,
    isDiscussing,
    setView,
    addDiscussionMessage,
    clearDiscussion,
    setDiscussing,
  } = useObsidianStore();
  const appSettings = useTerminalStore(s => s.settings);
  const [input, setInput] = useState('');
  const [model, setModel] = useState<'local' | 'perplexity' | 'gemini'>('gemini');
  const scrollRef = useRef<ScrollView>(null);

  if (!selectedItem) return null;

  const handleSend = async () => {
    if (!input.trim() || isDiscussing) return;
    const userMsg: DiscussionMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim(),
      timestamp: new Date().toISOString(),
      model,
    };
    addDiscussionMessage(userMsg);
    setInput('');
    setDiscussing(true);

    const context = `Please discuss the following ${selectedItem.type === 'paper' ? 'paper' : 'article'}.

Title: ${selectedItem.title}
Source: ${selectedItem.source}
Summary: ${selectedItem.summary}

Question/Discussion: ${input.trim()}`;

    const assistantId = (Date.now() + 1).toString();
    let fullContent = '';

    const updateMsg = (text: string, done: boolean) => {
      fullContent += text;
      if (done) {
        addDiscussionMessage({
          id: assistantId,
          role: 'assistant',
          content: fullContent,
          timestamp: new Date().toISOString(),
          model,
        });
        setDiscussing(false);
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
      }
    };

    try {
      if (model === 'gemini' && appSettings.geminiApiKey) {
        await geminiChatStream(appSettings.geminiApiKey, context, updateMsg);
      } else if (model === 'perplexity' && appSettings.perplexityApiKey) {
        await perplexitySearchStream(appSettings.perplexityApiKey, context, updateMsg);
      } else if (model === 'local' && appSettings.localLlmEnabled) {
        // Local LLM
        const resp = await fetch(`${appSettings.localLlmUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: appSettings.localLlmModel || 'local',
            messages: [{ role: 'user', content: context }],
            stream: false,
          }),
        });
        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content || t('obsidian.no_response');
        addDiscussionMessage({
          id: assistantId,
          role: 'assistant',
          content,
          timestamp: new Date().toISOString(),
          model,
        });
        setDiscussing(false);
      } else {
        addDiscussionMessage({
          id: assistantId,
          role: 'assistant',
          content: t('obsidian.api_not_configured'),
          timestamp: new Date().toISOString(),
          model,
        });
        setDiscussing(false);
      }
    } catch (e) {
      addDiscussionMessage({
        id: assistantId,
        role: 'assistant',
        content: `Error: ${e}`,
        timestamp: new Date().toISOString(),
        model,
      });
      setDiscussing(false);
    }
  };

  return (
    <View style={styles.flex1}>
      <View style={styles.navBar}>
        <TouchableOpacity onPress={() => setView('detail')} style={styles.backBtn}>
          <Text style={styles.backBtnText}>← Detail</Text>
        </TouchableOpacity>
        <Text style={styles.navTitle}>💬 Discussion</Text>
        <TouchableOpacity onPress={clearDiscussion}>
          <Text style={styles.clearText}>Clear</Text>
        </TouchableOpacity>
      </View>

      {/* モデル選択 */}
      <View style={styles.modelRow}>
        {(['gemini', 'perplexity', 'local'] as const).map(m => (
          <TouchableOpacity
            key={m}
            style={[styles.modelBtn, model === m && styles.modelBtnActive]}
            onPress={() => setModel(m)}
          >
            <Text style={[styles.modelBtnText, model === m && styles.modelBtnTextActive]}>
              {m === 'gemini' ? 'Gemini' : m === 'perplexity' ? 'Perplexity' : 'Local LLM'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* コンテキスト表示 */}
      <View style={styles.contextBanner}>
        <Text style={styles.contextText} numberOfLines={1}>
          📄 {selectedItem.title}
        </Text>
      </View>

      {/* チャット履歴 */}
      <ScrollView
        ref={scrollRef}
        style={styles.flex1}
        contentContainerStyle={styles.chatContent}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {discussionHistory.length === 0 && (
          <View style={styles.chatEmpty}>
            <Text style={styles.chatEmptyText}>
              Ask questions or discuss this article/paper freely.{'\n\n'}
              Examples:{'\n'}
              &quot;What are the limitations of this study?&quot;{'\n'}
              &quot;How could this apply in practice?&quot;{'\n'}
              &quot;What related prior research exists?&quot;
            </Text>
          </View>
        )}
        {discussionHistory.map(msg => (
          <View
            key={msg.id}
            style={[
              styles.chatBubble,
              msg.role === 'user' ? styles.chatBubbleUser : styles.chatBubbleAssistant,
            ]}
          >
            <Text style={styles.chatBubbleText}>{msg.content}</Text>
          </View>
        ))}
        {isDiscussing && (
          <View style={styles.chatBubbleAssistant}>
            <ActivityIndicator size="small" color={C.teal} />
          </View>
        )}
      </ScrollView>

      {/* 入力欄 */}
      <View style={styles.inputRow}>
        <TextInput
          style={styles.chatInput}
          value={input}
          onChangeText={setInput}
          placeholder="Type a question or thought..."
          placeholderTextColor={C.fgMuted}
          multiline
          returnKeyType="done"
          onSubmitEditing={handleSend}
        />
        <TouchableOpacity
          style={[styles.sendBtn, (!input.trim() || isDiscussing) && styles.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!input.trim() || isDiscussing}
        >
          <Text style={styles.sendBtnText}>Send</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── SNS執筆モード ────────────────────────────────────────────────────────────

function SnsView() {
  const {
    selectedItem,
    snsDrafts,
    isGeneratingSns,
    setView,
    setSnsDraft,
    setGeneratingSns,
  } = useObsidianStore();
  const appSettings = useTerminalStore(s => s.settings);
  const [activeTab, setActiveTab] = useState<'x' | 'threads' | 'note'>('x');

  if (!selectedItem) return null;

  const draft = snsDrafts[selectedItem.id];

  const handleGenerate = async () => {
    if (isGeneratingSns || !appSettings.geminiApiKey) return;
    setGeneratingSns(true);

    const basePrompt = `You are posting as a STEAM education / EdTech researcher and practitioner.
Write content that provides value to academics, researchers, policymakers, and industry professionals.
Include expert insights and your own analysis.

Source article/paper:
Title: ${selectedItem.title}
Source: ${selectedItem.source}
Summary: ${selectedItem.summary}
Tags: ${selectedItem.tags.join(', ')}`;

    try {
      // X post (280 chars max)
      const xPrompt = `${basePrompt}

Write an X (Twitter) post.
Requirements:
- 280 characters max
- Include expert insight + brief personal analysis
- 3-4 hashtags (#STEAMeducation #EdTech #DigitalLearning etc.)
- Include the source name
- Return only the post text (no explanation)`;

      let xContent = '';
      await geminiChatStream(appSettings.geminiApiKey, xPrompt, (text, done) => {
        xContent += text;
        if (done) setSnsDraft(selectedItem.id, { x: xContent.trim() });
      }, 'gemini-2.0-flash');

      // Threads post (~500 chars)
      const threadsPrompt = `${basePrompt}

Write a Threads post.
Requirements:
- 400-500 characters
- Structure: background → content → analysis → practical implications
- Provide value to researchers and practitioners
- 3-5 hashtags
- Return only the post text`;

      let threadsContent = '';
      await geminiChatStream(appSettings.geminiApiKey, threadsPrompt, (text, done) => {
        threadsContent += text;
        if (done) setSnsDraft(selectedItem.id, { threads: threadsContent.trim() });
      }, 'gemini-2.0-flash');

      // note article (2000-3000 chars)
      const notePrompt = `${basePrompt}

Write a note article.
Requirements:
- 2000-3000 characters
- Structure: Title / Introduction / Overview / Key Points (3) / Practical Implications / Conclusion
- Include source link: ${selectedItem.url}
- Use Markdown headings (##, ###)
- Content should be useful for academics, researchers, and education professionals
- Actively include author analysis and opinions
- Return only the article text`;

      let noteContent = '';
      await geminiChatStream(appSettings.geminiApiKey, notePrompt, (text, done) => {
        noteContent += text;
        if (done) setSnsDraft(selectedItem.id, { note: noteContent.trim() });
      }, 'gemini-2.0-flash');

    } catch (e) {
      Alert.alert(t('settings.error_label'), t('obsidian.generation_failed', { error: String(e) }));
    } finally {
      setGeneratingSns(false);
    }
  };

  const currentContent = activeTab === 'x' ? draft?.x
    : activeTab === 'threads' ? draft?.threads
    : draft?.note;

  const charCount = currentContent?.length || 0;
  const charLimit = activeTab === 'x' ? 280 : activeTab === 'threads' ? 500 : 99999;

  return (
    <View style={styles.flex1}>
      <View style={styles.navBar}>
        <TouchableOpacity onPress={() => setView('detail')} style={styles.backBtn}>
          <Text style={styles.backBtnText}>← Detail</Text>
        </TouchableOpacity>
        <Text style={styles.navTitle}>✍️ SNS Draft</Text>
        <TouchableOpacity
          style={[styles.generateBtn, isGeneratingSns && styles.generateBtnDisabled]}
          onPress={handleGenerate}
          disabled={isGeneratingSns}
        >
          {isGeneratingSns ? (
            <ActivityIndicator size="small" color={C.bg} />
          ) : (
            <Text style={styles.generateBtnText}>Generate</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* プラットフォームタブ */}
      <View style={styles.platformRow}>
        {(['x', 'threads', 'note'] as const).map(p => (
          <TouchableOpacity
            key={p}
            style={[styles.platformBtn, activeTab === p && styles.platformBtnActive]}
            onPress={() => setActiveTab(p)}
          >
            <Text style={[styles.platformBtnText, activeTab === p && styles.platformBtnTextActive]}>
              {p === 'x' ? 'X (Twitter)' : p === 'threads' ? 'Threads' : 'note'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* 元記事コンテキスト */}
      <View style={styles.contextBanner}>
        <Text style={styles.contextText} numberOfLines={1}>
          📄 {selectedItem.title}
        </Text>
      </View>

      {/* 下書きエリア */}
      <ScrollView style={styles.flex1} contentContainerStyle={{ padding: 16 }}>
        {!currentContent && !isGeneratingSns ? (
          <View style={styles.snsEmpty}>
            <Text style={styles.snsEmptyText}>
              Tap &quot;Generate&quot; to create{'\n'}
              drafts for X, Threads, and note at once
            </Text>
          </View>
        ) : isGeneratingSns && !currentContent ? (
          <View style={styles.snsEmpty}>
            <ActivityIndicator size="large" color={C.teal} />
            <Text style={styles.generatingText}>Writing with Gemini...</Text>
          </View>
        ) : (
          <>
            <View style={styles.draftHeader}>
              <Text style={styles.charCount}>
                {charCount} chars{activeTab !== 'note' && ` / ${charLimit}`}
                {activeTab === 'x' && charCount > 280 && (
                  <Text style={{ color: C.red }}> over limit</Text>
                )}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  if (currentContent) {
                    Clipboard.setString(currentContent);
                    Alert.alert(t('obsidian.copied'));
                  }
                }}
                style={styles.copyBtn}
              >
                <Text style={styles.copyBtnText}>Copy</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.draftText}>{currentContent}</Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

// ─── Research writing mode ───────────────────────────────────────────────────────

function ResearchView() {
  const { selectedItem, setView } = useObsidianStore();
  const appSettings = useTerminalStore(s => s.settings);
  const [output, setOutput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [task, setTask] = useState<'outline' | 'related' | 'critique' | 'abstract'>('outline');

  if (!selectedItem) return null;

  const taskConfig = {
    outline: { label: 'Paper Outline', desc: 'Create a paper outline based on this research' },
    related: { label: 'Related Work', desc: 'Suggest related prior research and literature' },
    critique: { label: 'Critical Analysis', desc: 'Analyze limitations, issues, and improvements' },
    abstract: { label: 'Abstract Draft', desc: 'Draft an abstract for your paper' },
  };

  const handleGenerate = async () => {
    if (isGenerating || !appSettings.geminiApiKey) return;
    setIsGenerating(true);
    setOutput('');

    const prompts = {
      outline: `As a STEAM education / EdTech researcher, create an outline for a new research paper based on the following article/paper.
Include perspectives from education practice and academia.

Reference:
Title: ${selectedItem.title}
Source: ${selectedItem.source}
Summary: ${selectedItem.summary}

Paper outline (Markdown format):`,

      related: `Suggest 5-8 related prior research/literature for the following article/paper.
Include author names, titles, publication year, and why they are related.

Target:
Title: ${selectedItem.title}
Summary: ${selectedItem.summary}`,

      critique: `From a researcher/reviewer perspective, critically analyze the following article/paper.
Include strengths, limitations, methodological issues, and future research directions.

Target:
Title: ${selectedItem.title}
Source: ${selectedItem.source}
Summary: ${selectedItem.summary}`,

      abstract: `Based on the following article/paper, draft an abstract for a STEAM education research paper.
Structure: Background, Objective, Method, Results, Conclusion. 200-300 words.

Reference:
Title: ${selectedItem.title}
Summary: ${selectedItem.summary}`,
    };

    try {
      await geminiChatStream(
        appSettings.geminiApiKey,
        prompts[task],
        (text, done) => {
          setOutput(prev => prev + text);
          if (done) setIsGenerating(false);
        },
        'gemini-2.0-flash',
      );
    } catch (e) {
      setOutput(`Error: ${e}`);
      setIsGenerating(false);
    }
  };

  return (
    <View style={styles.flex1}>
      <View style={styles.navBar}>
        <TouchableOpacity onPress={() => setView('detail')} style={styles.backBtn}>
          <Text style={styles.backBtnText}>← Detail</Text>
        </TouchableOpacity>
        <Text style={styles.navTitle}>📝 Research Assistant</Text>
      </View>

      {/* タスク選択 */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.taskScroll}>
        <View style={styles.taskRow}>
          {(Object.keys(taskConfig) as (keyof typeof taskConfig)[]).map(t => (
            <TouchableOpacity
              key={t}
              style={[styles.taskBtn, task === t && styles.taskBtnActive]}
              onPress={() => setTask(t)}
            >
              <Text style={[styles.taskBtnText, task === t && styles.taskBtnTextActive]}>
                {taskConfig[t].label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>

      <View style={styles.contextBanner}>
        <Text style={styles.contextText} numberOfLines={1}>
          📄 {selectedItem.title}
        </Text>
        <Text style={styles.contextSubText}>{taskConfig[task].desc}</Text>
      </View>

      <TouchableOpacity
        style={[styles.researchGenerateBtn, isGenerating && styles.generateBtnDisabled]}
        onPress={handleGenerate}
        disabled={isGenerating}
        activeOpacity={0.75}
      >
        {isGenerating ? (
          <ActivityIndicator size="small" color={C.bg} />
        ) : (
          <Text style={styles.generateBtnText}>Generate</Text>
        )}
      </TouchableOpacity>

      <ScrollView style={styles.flex1} contentContainerStyle={{ padding: 16 }}>
        {output ? (
          <>
            <View style={styles.draftHeader}>
              <Text style={styles.charCount}>{output.length} chars</Text>
              <TouchableOpacity
                onPress={() => { Clipboard.setString(output); Alert.alert(t('obsidian.copied')); }}
                style={styles.copyBtn}
              >
                <Text style={styles.copyBtnText}>Copy</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.draftText}>{output}</Text>
          </>
        ) : !isGenerating ? (
          <View style={styles.snsEmpty}>
            <Text style={styles.snsEmptyText}>
              Select a task and tap &quot;Generate&quot;
            </Text>
          </View>
        ) : (
          <View style={styles.snsEmpty}>
            <ActivityIndicator size="large" color={C.amber} />
            <Text style={[styles.generatingText, { color: C.amber }]}>Generating with Gemini...</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ─── メイン画面 ───────────────────────────────────────────────────────────────

export default function ObsidianScreen() {
  const { currentView } = useObsidianStore();

  return (
    <ScreenContainer containerClassName="bg-[#0D0D0D]">
      {currentView === 'briefing' && <BriefingListView />}
      {currentView === 'detail' && <DetailView />}
      {currentView === 'discuss' && <DiscussView />}
      {currentView === 'sns' && <SnsView />}
      {currentView === 'research' && <ResearchView />}
    </ScreenContainer>
  );
}

// ─── スタイル ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  flex1: { flex: 1 },

  // カード
  card: {
    backgroundColor: C.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: C.border,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  cardTitle: {
    color: C.fg,
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
    marginBottom: 2,
  },
  cardSource: {
    color: C.teal,
    fontSize: 11,
    fontFamily: 'monospace',
    marginBottom: 6,
  },
  cardSummary: {
    color: C.fgMuted,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 8,
  },

  // バッジ
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
  },

  // 信頼度ドット
  credRow: { flexDirection: 'row', gap: 3, alignItems: 'center' },
  credDot: { width: 6, height: 6, borderRadius: 3 },
  citationText: { color: C.fgMuted, fontSize: 10, fontFamily: 'monospace' },

  // タグ
  tagRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  tagRowWrap: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 16 },
  tag: {
    backgroundColor: C.surface2,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: C.border,
  },
  tagText: { color: C.fgMuted, fontSize: 10, fontFamily: 'monospace' },

  // リストヘッダー
  listHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  headerTitle: { color: C.fg, fontSize: 16, fontWeight: '700' },
  headerDate: { color: C.fgMuted, fontSize: 11, fontFamily: 'monospace', marginTop: 2 },
  collectBtn: {
    backgroundColor: C.teal,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    minWidth: 60,
    alignItems: 'center',
  },
  collectBtnDisabled: { opacity: 0.5 },
  collectBtnText: { color: C.bg, fontSize: 13, fontWeight: '700' },

  // バナー
  resultBanner: {
    backgroundColor: '#00D4AA1A',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#00D4AA33',
  },
  resultText: { color: C.teal, fontSize: 11, fontFamily: 'monospace' },
  errorBanner: {
    backgroundColor: '#EF444420',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  errorText: { color: C.red, fontSize: 11 },
  collectingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: C.surface,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  collectingText: { color: C.teal, fontSize: 11, fontFamily: 'monospace' },

  // リストコンテンツ
  listContent: { padding: 12 },

  // 空状態
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { color: C.fg, fontSize: 16, fontWeight: '600', marginBottom: 8 },
  emptyDesc: { color: C.fgMuted, fontSize: 13, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  emptyBtn: {
    backgroundColor: C.teal,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  emptyBtnText: { color: C.bg, fontSize: 14, fontWeight: '700' },

  // ナビバー
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  backBtn: { paddingVertical: 4, paddingRight: 12 },
  backBtnText: { color: C.teal, fontSize: 13 },
  navTitle: { color: C.fg, fontSize: 14, fontWeight: '600', flex: 1, textAlign: 'center' },
  clearText: { color: C.fgMuted, fontSize: 12 },

  // 詳細
  detailContent: { padding: 16 },
  detailTitle: { color: C.fg, fontSize: 17, fontWeight: '700', lineHeight: 24, marginBottom: 4 },
  detailOriginalTitle: { color: C.fgMuted, fontSize: 11, fontFamily: 'monospace', marginBottom: 16 },
  metaGrid: {
    backgroundColor: C.surface,
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: C.border,
    gap: 8,
  },
  metaRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  metaLabel: { color: C.fgMuted, fontSize: 11, fontFamily: 'monospace', width: 60, flexShrink: 0 },
  metaValue: { color: C.fg, fontSize: 12, flex: 1 },
  section: { marginBottom: 16 },
  sectionTitle: { color: C.teal, fontSize: 12, fontWeight: '700', fontFamily: 'monospace', marginBottom: 8 },
  summaryText: { color: C.fg, fontSize: 13, lineHeight: 22 },

  // アクションボタン
  actionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 },
  actionBtn: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: C.surface,
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    gap: 6,
  },
  actionBtnIcon: { fontSize: 22 },
  actionBtnLabel: { fontSize: 12, fontWeight: '600' },

  // モデル選択
  modelRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  modelBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 6,
    alignItems: 'center',
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  modelBtnActive: { backgroundColor: C.tealDim, borderColor: C.teal },
  modelBtnText: { color: C.fgMuted, fontSize: 11 },
  modelBtnTextActive: { color: C.teal, fontWeight: '700' },

  // コンテキストバナー
  contextBanner: {
    backgroundColor: C.surface2,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  contextText: { color: C.fgMuted, fontSize: 11, fontFamily: 'monospace' },
  contextSubText: { color: C.fgDim, fontSize: 10, marginTop: 2 },

  // チャット
  chatContent: { padding: 12, gap: 10 },
  chatEmpty: { padding: 24, alignItems: 'center' },
  chatEmptyText: { color: C.fgMuted, fontSize: 13, lineHeight: 22, textAlign: 'center' },
  chatBubble: { borderRadius: 12, padding: 12, maxWidth: '90%' },
  chatBubbleUser: {
    backgroundColor: C.tealDim,
    alignSelf: 'flex-end',
    borderBottomRightRadius: 4,
  },
  chatBubbleAssistant: {
    backgroundColor: C.surface,
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: C.border,
  },
  chatBubbleText: { color: C.fg, fontSize: 13, lineHeight: 20 },

  // 入力欄
  inputRow: {
    flexDirection: 'row',
    padding: 12,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: C.border,
    backgroundColor: C.surface,
  },
  chatInput: {
    flex: 1,
    backgroundColor: C.surface2,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: C.fg,
    fontSize: 13,
    borderWidth: 1,
    borderColor: C.border,
    maxHeight: 80,
  },
  sendBtn: {
    backgroundColor: C.teal,
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { color: C.bg, fontSize: 13, fontWeight: '700' },

  // SNS
  platformRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  platformBtn: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 6,
    alignItems: 'center',
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  platformBtnActive: { backgroundColor: C.purpleDim, borderColor: C.purple },
  platformBtnText: { color: C.fgMuted, fontSize: 11 },
  platformBtnTextActive: { color: C.purple, fontWeight: '700' },

  generateBtn: {
    backgroundColor: C.purple,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
    minWidth: 56,
    alignItems: 'center',
  },
  generateBtnDisabled: { opacity: 0.5 },
  generateBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  snsEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, minHeight: 200 },
  snsEmptyText: { color: C.fgMuted, fontSize: 13, textAlign: 'center', lineHeight: 22 },
  generatingText: { color: C.teal, fontSize: 13, marginTop: 12 },

  draftHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  charCount: { color: C.fgMuted, fontSize: 11, fontFamily: 'monospace' },
  copyBtn: {
    backgroundColor: C.surface,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: C.border,
  },
  copyBtnText: { color: C.teal, fontSize: 12 },
  draftText: { color: C.fg, fontSize: 13, lineHeight: 22 },

  // 論文執筆
  taskScroll: { maxHeight: 48, borderBottomWidth: 1, borderBottomColor: C.border },
  taskRow: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  taskBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  taskBtnActive: { backgroundColor: C.amberDim, borderColor: C.amber },
  taskBtnText: { color: C.fgMuted, fontSize: 12 },
  taskBtnTextActive: { color: C.amber, fontWeight: '700' },
  researchGenerateBtn: {
    backgroundColor: C.amber,
    margin: 12,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
});
