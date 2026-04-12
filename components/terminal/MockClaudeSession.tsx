/**
 * MockClaudeSession.tsx — Hardcoded Claude Code session matching mock screenshots
 */
import React from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable } from 'react-native';
import { neonTextGlow, neonDotGlow } from '@/lib/neon-glow';
import { colors as C, fonts as F, sizes as S, padding as P, radii as R, decorations as D } from '@/theme.config';

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
          <View style={s.progressBar}>
            <View style={s.progressDot} />
          </View>
          <Text style={s.bannerTokens}>92K / 1M TOKENS · ~$0.63</Text>
        </View>
      </View>

      {/* ── READ Block ── */}
      <View style={s.blockRow}>
        <View style={[s.blockDot, { backgroundColor: C.accent }]} />
        <Text style={[s.blockAction, { color: C.accent }]}>READ </Text>
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
        <View style={[s.blockDot, { backgroundColor: C.warning }]} />
        <Text style={[s.blockAction, { color: C.warning }]}>EDIT </Text>
        <Text style={s.blockPath}>LIB/INPUT-ROUTER.TS</Text>
        <View style={{ flex: 1 }} />
        <Text style={s.editPen}>✏️</Text>
      </View>
      <View style={s.diffContainer}>
        <View style={s.diffLine}>
          <View style={[s.diffBar, { backgroundColor: C.diffRemoveBorder }]} />
          <Text style={s.diffRemove}>—   LAYER: 'NATURAL',</Text>
        </View>
        <View style={s.diffLineAdd}>
          <View style={[s.diffBar, { backgroundColor: C.diffAddBorder }]} />
          <Text style={s.diffAdd}>+   LAYER: 'MENTION',</Text>
        </View>
        <View style={s.diffLine}>
          <View style={[s.diffBar, { backgroundColor: C.diffRemoveBorder }]} />
          <Text style={s.diffRemove}>—   TARGET: 'SUGGEST',</Text>
        </View>
        <View style={s.diffLineAdd}>
          <View style={[s.diffBar, { backgroundColor: C.diffAddBorder }]} />
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
  container: { flex: 1, backgroundColor: C.bgDeep },
  content: { padding: 0 },

  // Banner
  banner: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: C.bgSurface, borderRadius: 8, margin: 8, padding: 10,
    borderWidth: S.borderWidth, borderColor: C.border,
  },
  bannerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bannerIcon: { fontSize: 16, color: C.text2 },
  bannerTitle: { fontFamily: F.family, fontSize: 11, fontWeight: '700', color: C.text1 },
  bannerVersion: { color: C.text2, fontWeight: '400' },
  bannerSub: { fontFamily: F.family, fontSize: 8, color: C.text2, marginTop: 2 },
  bannerRight: { alignItems: 'flex-end' },
  progressBar: { width: 60, height: 3, backgroundColor: C.border, borderRadius: 2, marginBottom: 3 },
  progressDot: {
    position: 'absolute', width: 5, height: 5, borderRadius: 3,
    backgroundColor: C.accent, top: -1, left: '50%',
  },
  bannerTokens: { fontFamily: F.family, fontSize: 8, color: C.text2 },

  // Block header
  blockRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingVertical: 6, gap: 4,
  },
  blockDot: { width: 8, height: 8, borderRadius: 4 },
  blockAction: { fontFamily: F.family, fontSize: F.paneHeader.size, fontWeight: F.paneHeader.weight, letterSpacing: 0.5 },
  blockPath: { fontFamily: F.family, fontSize: F.paneHeader.size, color: C.text1 },
  blockDuration: { fontFamily: F.family, fontSize: F.contextBar.size, color: C.text2 },
  blockCopy: { fontSize: 12, marginLeft: 4 },
  editPen: { fontSize: 12 },
  blockBody: { paddingHorizontal: 12, paddingBottom: 8 },
  codeText: { fontFamily: F.family, fontSize: F.contextBar.size, color: '#93C5FD', lineHeight: 14 },

  // Diff
  diffContainer: { marginHorizontal: 8, borderRadius: 4, overflow: 'hidden', borderWidth: S.borderWidth, borderColor: C.border },
  diffLine: {
    flexDirection: 'row', alignItems: 'stretch',
    backgroundColor: C.errorBg,
  },
  diffLineAdd: {
    flexDirection: 'row', alignItems: 'stretch',
    backgroundColor: C.addBg,
  },
  diffBar: { width: D.diffBorderWidth },
  diffRemove: {
    fontFamily: F.family, fontSize: F.paneHeader.size, color: C.errorText,
    paddingHorizontal: 8, paddingVertical: 4, flex: 1,
  },
  diffAdd: {
    fontFamily: F.family, fontSize: F.paneHeader.size, color: C.addText,
    paddingHorizontal: 8, paddingVertical: 4, flex: 1,
  },

  // Action buttons
  actionRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingVertical: 6 },
  acceptBtn: {
    backgroundColor: C.btnPrimaryBg, paddingHorizontal: 14, paddingVertical: 5, borderRadius: R.actionButton,
    shadowColor: C.accent, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.4, shadowRadius: 6,
  },
  acceptText: { fontFamily: F.family, fontSize: F.contextBar.size, fontWeight: '800', color: C.btnPrimaryText, letterSpacing: 0.5 },
  rejectBtn: {
    backgroundColor: C.btnSecondaryBg, paddingHorizontal: 14, paddingVertical: 5, borderRadius: R.actionButton,
  },
  rejectText: { fontFamily: F.family, fontSize: F.contextBar.size, fontWeight: '700', color: C.btnSecondaryText, letterSpacing: 0.5 },

  // Bash warning
  bashHeader: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(245,158,11,0.08)', paddingHorizontal: 10, paddingVertical: 6,
    borderTopWidth: S.borderWidth, borderTopColor: C.border, marginTop: 4,
  },
  bashIcon: { fontSize: 12, color: C.warning },
  bashTitle: { fontFamily: F.family, fontSize: F.paneHeader.size, fontWeight: '700', color: C.warning },
  bashConfirm: { fontFamily: F.family, fontSize: F.contextBar.size, fontWeight: '800', color: C.warning },
  bashBody: { paddingHorizontal: 10, paddingVertical: 6 },
  bashText: { fontFamily: F.family, fontSize: F.paneHeader.size, color: C.text1, marginBottom: 6 },
  allowBtn: {
    backgroundColor: C.btnPrimaryBg, paddingHorizontal: 14, paddingVertical: 5, borderRadius: R.actionButton,
  },
  allowText: { fontFamily: F.family, fontSize: F.contextBar.size, fontWeight: '800', color: C.btnPrimaryText, letterSpacing: 0.5 },
  denyBtn: {
    backgroundColor: C.btnSecondaryBg, paddingHorizontal: 14, paddingVertical: 5, borderRadius: R.actionButton,
  },
  denyText: { fontFamily: F.family, fontSize: F.contextBar.size, fontWeight: '700', color: C.btnSecondaryText, letterSpacing: 0.5 },

  // Auto-save
  autoSaveBar: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.autoSaveBg, paddingHorizontal: 10, paddingVertical: 5,
    marginHorizontal: 8, borderRadius: 4, marginTop: 4,
  },
  autoSaveIcon: { fontSize: 10 },
  autoSaveText: { fontFamily: F.family, fontSize: F.contextBar.size, color: C.accent },
  autoSaveLink: {
    fontFamily: F.family, fontSize: F.contextBar.size, fontWeight: '700', color: C.accent,
    textDecorationLine: 'underline',
  },

  // Tip
  tipRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingVertical: 4,
  },
  tipIcon: { fontSize: 10 },
  tipText: { fontFamily: F.family, fontSize: F.tip.size, color: C.text3 },
  tipDismiss: { fontFamily: F.family, fontSize: F.paneHeader.size, color: C.text3 },

  // Prompt
  promptRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, paddingVertical: 8, gap: 4,
  },
  promptSymbol: { fontFamily: F.family, fontSize: 12, color: C.accent, fontWeight: '700' },
  cursor: {
    width: 8, height: 14, backgroundColor: C.accent, borderRadius: 1,
    opacity: 0.8,
  },

  // FABs
  fabRow: {
    position: 'absolute', bottom: 12, right: 12,
    flexDirection: 'row', gap: 8,
  },
  fab: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(0,212,170,0.2)', borderWidth: S.borderWidth, borderColor: C.accent,
    justifyContent: 'center', alignItems: 'center',
  },
  fabIcon: { fontSize: 14 },
});
