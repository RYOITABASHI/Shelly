/**
 * MockClaudeSession.tsx — Hardcoded Claude Code session matching mock screenshots
 *
 * Renders a pixel-perfect replica of the mock's terminal content:
 * - Session banner (CLAUDE CODE V2.1.92)
 * - READ block with file content preview
 * - EDIT block with diff (red/green lines) + ACCEPT/REJECT
 * - BASH warning block with ALLOW/DENY
 * - Auto-save bar
 * - Tip bar
 * - Prompt cursor
 */
import React from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable } from 'react-native';
import { neonTextGlow, neonDotGlow } from '@/lib/neon-glow';

const ACCENT = '#00D4AA';
const FONT = 'GeistPixel-Square';

export function MockClaudeSession() {
  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      {/* ── Session Banner ── */}
      <View style={s.banner}>
        <View style={s.bannerLeft}>
          <Text style={s.bannerIcon}>⊙</Text>
          <View>
            <Text style={s.bannerTitle}>
              CLAUDE CODE <Text style={s.bannerVersion}>V2.1.92</Text>
            </Text>
            <Text style={s.bannerSub}>OPUS 4.6 (1M CONTEXT) · ~/SHELLY</Text>
          </View>
        </View>
        <View style={s.bannerRight}>
          {/* Progress bar */}
          <View style={s.progressBar}>
            <View style={s.progressDot} />
          </View>
          <Text style={s.bannerTokens}>92K / 1M TOKENS · ~$0.63</Text>
        </View>
      </View>

      {/* ── READ Block ── */}
      <View style={s.blockRow}>
        <View style={[s.blockDot, { backgroundColor: ACCENT }]} />
        <Text style={[s.blockAction, { color: ACCENT }]}>READ </Text>
        <Text style={s.blockPath}>COMPONENTS/WELCOMEWIZARD.TSX</Text>
        <View style={{ flex: 1 }} />
        <Text style={s.blockDuration}>0.3S</Text>
        <Text style={s.blockCopy}>📋</Text>
      </View>
      <View style={s.blockBody}>
        <Text style={s.codeText}>
          1 IMPORT REACT, {'{ USESTATE }'} FROM 'REACT'; 2 IMPORT {'{ VIEW, TEXT }'} FROM{'\n'}
          'REACT-NATIVE'; 3 // ... 340 LINES
        </Text>
      </View>

      {/* ── EDIT Block ── */}
      <View style={s.blockRow}>
        <View style={[s.blockDot, { backgroundColor: '#FBBF24' }]} />
        <Text style={[s.blockAction, { color: '#FBBF24' }]}>EDIT </Text>
        <Text style={s.blockPath}>LIB/INPUT-ROUTER.TS</Text>
        <View style={{ flex: 1 }} />
        <Text style={s.editPen}>✏️</Text>
      </View>
      <View style={s.diffContainer}>
        <View style={s.diffLine}>
          <View style={[s.diffBar, { backgroundColor: '#EF4444' }]} />
          <Text style={s.diffRemove}>—   LAYER: 'NATURAL',</Text>
        </View>
        <View style={s.diffLineAdd}>
          <View style={[s.diffBar, { backgroundColor: ACCENT }]} />
          <Text style={s.diffAdd}>+   LAYER: 'MENTION',</Text>
        </View>
        <View style={s.diffLine}>
          <View style={[s.diffBar, { backgroundColor: '#EF4444' }]} />
          <Text style={s.diffRemove}>—   TARGET: 'SUGGEST',</Text>
        </View>
        <View style={s.diffLineAdd}>
          <View style={[s.diffBar, { backgroundColor: ACCENT }]} />
          <Text style={s.diffAdd}>+   TARGET: 'ACTIONS',</Text>
        </View>
      </View>
      {/* ACCEPT / REJECT */}
      <View style={s.actionRow}>
        <Pressable style={s.acceptBtn}>
          <Text style={s.acceptText}>ACCEPT</Text>
        </Pressable>
        <Pressable style={s.rejectBtn}>
          <Text style={s.rejectText}>REJECT</Text>
        </Pressable>
      </View>

      {/* ── BASH Warning Block ── */}
      <View style={s.bashHeader}>
        <Text style={s.bashIcon}>⚠</Text>
        <Text style={s.bashTitle}> BASH: RM -RF NODE_MODULES/</Text>
        <View style={{ flex: 1 }} />
        <Text style={s.bashConfirm}>CONFIRM?</Text>
      </View>
      <View style={s.bashBody}>
        <Text style={s.bashText}>THIS WILL DELETE NODE_MODULES/. PROCEED?</Text>
        <View style={s.actionRow}>
          <Pressable style={s.allowBtn}>
            <Text style={s.allowText}>ALLOW</Text>
          </Pressable>
          <Pressable style={s.denyBtn}>
            <Text style={s.denyText}>DENY</Text>
          </Pressable>
        </View>
      </View>

      {/* ── Auto-Save Bar ── */}
      <View style={s.autoSaveBar}>
        <Text style={s.autoSaveIcon}>🔒</Text>
        <Text style={s.autoSaveText}> AUTO-SAVED · 3 FILES CHANGED </Text>
        <Text style={s.autoSaveLink}>UNDO</Text>
        <Text style={s.autoSaveText}> </Text>
        <Text style={s.autoSaveLink}>VIEW DIFF</Text>
      </View>

      {/* ── Tip ── */}
      <View style={s.tipRow}>
        <Text style={s.tipIcon}>💡</Text>
        <Text style={s.tipText}> TIP: SAY "SHELLY VOICE" FOR HANDS-FREE MODE</Text>
        <View style={{ flex: 1 }} />
        <Text style={s.tipDismiss}>✕</Text>
      </View>

      {/* ── Prompt ── */}
      <View style={s.promptRow}>
        <Text style={[s.promptSymbol, neonTextGlow]}>{'>'}</Text>
        <View style={s.cursor} />
      </View>

      {/* ── FABs ── */}
      <View style={s.fabRow}>
        <View style={s.fab}>
          <Text style={s.fabIcon}>💾</Text>
        </View>
        <View style={s.fab}>
          <Text style={s.fabIcon}>⬆</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  content: { padding: 0 },

  // Banner
  banner: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: '#111', borderRadius: 8, margin: 8, padding: 10,
    borderWidth: 1, borderColor: '#1A1A1A',
  },
  bannerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bannerIcon: { fontSize: 16, color: '#6B7280' },
  bannerTitle: { fontFamily: FONT, fontSize: 11, fontWeight: '700', color: '#E5E7EB' },
  bannerVersion: { color: '#6B7280', fontWeight: '400' },
  bannerSub: { fontFamily: FONT, fontSize: 8, color: '#6B7280', marginTop: 2 },
  bannerRight: { alignItems: 'flex-end' },
  progressBar: { width: 60, height: 3, backgroundColor: '#1A1A1A', borderRadius: 2, marginBottom: 3 },
  progressDot: {
    position: 'absolute', width: 5, height: 5, borderRadius: 3,
    backgroundColor: ACCENT, top: -1, left: '50%',
  },
  bannerTokens: { fontFamily: FONT, fontSize: 8, color: '#6B7280' },

  // Block header
  blockRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingVertical: 6, gap: 4,
  },
  blockDot: { width: 8, height: 8, borderRadius: 4 },
  blockAction: { fontFamily: FONT, fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  blockPath: { fontFamily: FONT, fontSize: 10, color: '#E5E7EB' },
  blockDuration: { fontFamily: FONT, fontSize: 9, color: '#6B7280' },
  blockCopy: { fontSize: 12, marginLeft: 4 },
  editPen: { fontSize: 12 },
  blockBody: { paddingHorizontal: 12, paddingBottom: 8 },
  codeText: { fontFamily: FONT, fontSize: 9, color: '#93C5FD', lineHeight: 14 },

  // Diff
  diffContainer: { marginHorizontal: 8, borderRadius: 4, overflow: 'hidden', borderWidth: 1, borderColor: '#1A1A1A' },
  diffLine: {
    flexDirection: 'row', alignItems: 'stretch',
    backgroundColor: 'rgba(239,68,68,0.10)',
  },
  diffLineAdd: {
    flexDirection: 'row', alignItems: 'stretch',
    backgroundColor: 'rgba(0,212,170,0.10)',
  },
  diffBar: { width: 3 },
  diffRemove: {
    fontFamily: FONT, fontSize: 10, color: '#EF4444',
    paddingHorizontal: 8, paddingVertical: 4, flex: 1,
  },
  diffAdd: {
    fontFamily: FONT, fontSize: 10, color: ACCENT,
    paddingHorizontal: 8, paddingVertical: 4, flex: 1,
  },

  // Action buttons
  actionRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingVertical: 6 },
  acceptBtn: {
    backgroundColor: ACCENT, paddingHorizontal: 14, paddingVertical: 5, borderRadius: 4,
    shadowColor: ACCENT, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.4, shadowRadius: 6,
  },
  acceptText: { fontFamily: FONT, fontSize: 9, fontWeight: '800', color: '#000', letterSpacing: 0.5 },
  rejectBtn: {
    borderWidth: 1, borderColor: '#333', paddingHorizontal: 14, paddingVertical: 5, borderRadius: 4,
  },
  rejectText: { fontFamily: FONT, fontSize: 9, fontWeight: '700', color: '#6B7280', letterSpacing: 0.5 },

  // Bash warning
  bashHeader: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(251,191,36,0.08)', paddingHorizontal: 10, paddingVertical: 6,
    borderTopWidth: 1, borderTopColor: '#1A1A1A', marginTop: 4,
  },
  bashIcon: { fontSize: 12, color: '#FBBF24' },
  bashTitle: { fontFamily: FONT, fontSize: 10, fontWeight: '700', color: '#FBBF24' },
  bashConfirm: { fontFamily: FONT, fontSize: 9, fontWeight: '800', color: '#FBBF24' },
  bashBody: { paddingHorizontal: 10, paddingVertical: 6 },
  bashText: { fontFamily: FONT, fontSize: 10, color: '#E5E7EB', marginBottom: 6 },
  allowBtn: {
    backgroundColor: ACCENT, paddingHorizontal: 14, paddingVertical: 5, borderRadius: 4,
  },
  allowText: { fontFamily: FONT, fontSize: 9, fontWeight: '800', color: '#000', letterSpacing: 0.5 },
  denyBtn: {
    borderWidth: 1, borderColor: '#333', paddingHorizontal: 14, paddingVertical: 5, borderRadius: 4,
  },
  denyText: { fontFamily: FONT, fontSize: 9, fontWeight: '700', color: '#6B7280', letterSpacing: 0.5 },

  // Auto-save
  autoSaveBar: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(0,212,170,0.08)', paddingHorizontal: 10, paddingVertical: 5,
    marginHorizontal: 8, borderRadius: 4, marginTop: 4,
  },
  autoSaveIcon: { fontSize: 10 },
  autoSaveText: { fontFamily: FONT, fontSize: 9, color: ACCENT },
  autoSaveLink: {
    fontFamily: FONT, fontSize: 9, fontWeight: '700', color: ACCENT,
    textDecorationLine: 'underline',
  },

  // Tip
  tipRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingVertical: 4,
  },
  tipIcon: { fontSize: 10 },
  tipText: { fontFamily: FONT, fontSize: 9, color: '#6B7280' },
  tipDismiss: { fontFamily: FONT, fontSize: 10, color: '#4B5563' },

  // Prompt
  promptRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingVertical: 8, gap: 4,
  },
  promptSymbol: { fontFamily: FONT, fontSize: 12, color: ACCENT, fontWeight: '700' },
  cursor: {
    width: 8, height: 14, backgroundColor: ACCENT, borderRadius: 1,
    opacity: 0.8,
  },

  // FABs
  fabRow: {
    position: 'absolute', bottom: 12, right: 12,
    flexDirection: 'row', gap: 8,
  },
  fab: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(0,212,170,0.2)', borderWidth: 1, borderColor: ACCENT,
    justifyContent: 'center', alignItems: 'center',
  },
  fabIcon: { fontSize: 14 },
});
