# Shelly Coming Soon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the remaining 6 "Coming Soon" features (theme presets, MCP manager UI, background agent scheduler UI, SSH profiles, llama.cpp UI, Google Drive OAuth + Dropbox/OneDrive direct links) to close out the README Coming Soon section.

**Architecture:** Reuse existing modules (`lib/llamacpp-setup.ts` 386 LOC, `store/mcp-store.ts`, `store/agent-store.ts`, `lib/agent-manager.ts`) wherever possible. Touch UI layer first, lib layer only for surgical edits. Plan B runtime (Android `/data/data/dev.shelly.terminal/files/`) — no Termux required. `execCommand` is synchronous-return (blocks until child exits).

**Tech Stack:** Expo 54 / React Native 0.81 / TypeScript strict / Zustand / NativeWind / expo-auth-session (new dep) / expo-crypto (new dep) / expo-file-system / expo-secure-store.

**Spec references:**
- `docs/superpowers/specs/2026-04-14-coming-soon-design.md` — umbrella
- `docs/superpowers/specs/2026-04-14-llama-cpp-setup-design.md` — mini for feature 5
- `docs/superpowers/specs/2026-04-14-cloud-oauth-design.md` — mini for feature 6

**Testing approach:** Jest is not installed (issue #5). Verification is per-feature manual smoke test on device. Each task ends with `npx tsc --noEmit` (0 errors) + a documented manual test.

**Branching:** main direct push, one commit per feature (or per sub-step for features 5/6).

---

## Overall checklist

- [ ] Task 1 — Additional theme presets (4 new)
- [ ] Task 2 — MCP manager UI
- [ ] Task 3 — Background agent scheduler UI
- [ ] Task 4 — SSH profiles UI (key auth only)
- [ ] Task 5 — llama.cpp UI (5A pre-flight / 5B state store / 5C lib edits / 5D UI / 5E settings row / 5F doc)
- [ ] Task 6 — Google Drive OAuth + Dropbox/OneDrive links (6A deps / 6B auth lib / 6C store / 6D auth modal / 6E list component / 6F sidebar rewrite / 6G readme)
- [ ] Task 7 — README + handoff final sync
- [ ] Task 8 — Status table final pass

---

## Task 1: Additional theme presets (Dracula / Nord / Gruvbox / Tokyo Night)

**Files:**
- Modify: `lib/theme-presets.ts` — add 4 `Palette` constants + extend `themePresets` map
- Modify: `store/types.ts` — extend `uiFont` union
- Modify: `components/layout/SettingsDropdown.tsx` — add 4 tiles to FontFamilyRow
- Modify: `components/CommandPalette.tsx` — add 4 Theme rows
- Modify: `components/panes/TerminalPane.tsx` — map new ids to native font

---

- [ ] **Step 1.1: Read existing palette structure**

Run:
```bash
sed -n '60,200p' lib/theme-presets.ts
```
Expected: see `shellyPalette`, `silkscreenPalette`, and `themePresets` map.

- [ ] **Step 1.2: Add 4 new palette constants**

In `lib/theme-presets.ts`, after `silkscreenPalette` add:

```ts
// ── Dracula (official-ish, neon-safe) ──
export const draculaPalette: Palette = {
  bgDeep:     '#282A36',
  bgSurface:  '#21222C',
  bgSidebar:  '#1A1B24',
  border:     '#44475A',
  accent:        '#BD93F9',
  accentGreen:   '#50FA7B',
  accentBlue:    '#8BE9FD',
  accentSky:     '#8BE9FD',
  accentPurple:  '#BD93F9',
  accentPink:    '#FF79C6',
  accentAmber:   '#F1FA8C',
  accentCode:    '#8BE9FD',
  warning:       '#FFB86C',
  text1:      '#F8F8F2',
  text2:      '#BFBFBF',
  text3:      '#6272A4',
  errorText:  '#FF5555',
  errorBg:    'rgba(255,85,85,0.12)',
  addText:    '#50FA7B',
  addBg:      'rgba(80,250,123,0.12)',
  btnPrimaryBg:     '#BD93F9',
  btnPrimaryText:   '#282A36',
  btnSecondaryBg:   '#44475A',
  btnSecondaryText: '#F8F8F2',
  badgeRunningBg:   'rgba(255,184,108,0.15)',
  badgeRunningText: '#FFB86C',
  badgeLinkedBg:    'rgba(80,250,123,0.15)',
  badgeLinkedText:  '#50FA7B',
  badgeConnectBg:   '#21222C',
  badgeConnectText: '#6272A4',
  layoutActiveBg:     '#BD93F9',
  layoutActiveText:   '#282A36',
  layoutInactiveBg:   '#21222C',
  layoutInactiveText: '#6272A4',
  crtBadgeBg:   '#1A1B24',
  crtBadgeText: '#BD93F9',
  autoSaveBg:   '#21222C',
  diffAddBorder:    '#50FA7B',
  diffRemoveBorder: '#FF5555',
};

// ── Nord (official-ish) ──
export const nordPalette: Palette = {
  bgDeep:     '#2E3440',
  bgSurface:  '#3B4252',
  bgSidebar:  '#242933',
  border:     '#434C5E',
  accent:        '#88C0D0',
  accentGreen:   '#A3BE8C',
  accentBlue:    '#81A1C1',
  accentSky:     '#88C0D0',
  accentPurple:  '#B48EAD',
  accentPink:    '#B48EAD',
  accentAmber:   '#EBCB8B',
  accentCode:    '#81A1C1',
  warning:       '#EBCB8B',
  text1:      '#ECEFF4',
  text2:      '#D8DEE9',
  text3:      '#4C566A',
  errorText:  '#BF616A',
  errorBg:    'rgba(191,97,106,0.12)',
  addText:    '#A3BE8C',
  addBg:      'rgba(163,190,140,0.12)',
  btnPrimaryBg:     '#88C0D0',
  btnPrimaryText:   '#2E3440',
  btnSecondaryBg:   '#434C5E',
  btnSecondaryText: '#ECEFF4',
  badgeRunningBg:   'rgba(235,203,139,0.15)',
  badgeRunningText: '#EBCB8B',
  badgeLinkedBg:    'rgba(163,190,140,0.15)',
  badgeLinkedText:  '#A3BE8C',
  badgeConnectBg:   '#3B4252',
  badgeConnectText: '#4C566A',
  layoutActiveBg:     '#88C0D0',
  layoutActiveText:   '#2E3440',
  layoutInactiveBg:   '#3B4252',
  layoutInactiveText: '#4C566A',
  crtBadgeBg:   '#242933',
  crtBadgeText: '#88C0D0',
  autoSaveBg:   '#3B4252',
  diffAddBorder:    '#A3BE8C',
  diffRemoveBorder: '#BF616A',
};

// ── Gruvbox dark medium ──
export const gruvboxPalette: Palette = {
  bgDeep:     '#282828',
  bgSurface:  '#3C3836',
  bgSidebar:  '#1D2021',
  border:     '#504945',
  accent:        '#FABD2F',
  accentGreen:   '#B8BB26',
  accentBlue:    '#83A598',
  accentSky:     '#8EC07C',
  accentPurple:  '#D3869B',
  accentPink:    '#D3869B',
  accentAmber:   '#FABD2F',
  accentCode:    '#83A598',
  warning:       '#FE8019',
  text1:      '#EBDBB2',
  text2:      '#D5C4A1',
  text3:      '#7C6F64',
  errorText:  '#FB4934',
  errorBg:    'rgba(251,73,52,0.12)',
  addText:    '#B8BB26',
  addBg:      'rgba(184,187,38,0.12)',
  btnPrimaryBg:     '#FABD2F',
  btnPrimaryText:   '#282828',
  btnSecondaryBg:   '#504945',
  btnSecondaryText: '#EBDBB2',
  badgeRunningBg:   'rgba(254,128,25,0.15)',
  badgeRunningText: '#FE8019',
  badgeLinkedBg:    'rgba(184,187,38,0.15)',
  badgeLinkedText:  '#B8BB26',
  badgeConnectBg:   '#3C3836',
  badgeConnectText: '#7C6F64',
  layoutActiveBg:     '#FABD2F',
  layoutActiveText:   '#282828',
  layoutInactiveBg:   '#3C3836',
  layoutInactiveText: '#7C6F64',
  crtBadgeBg:   '#1D2021',
  crtBadgeText: '#FABD2F',
  autoSaveBg:   '#3C3836',
  diffAddBorder:    '#B8BB26',
  diffRemoveBorder: '#FB4934',
};

// ── Tokyo Night ──
export const tokyoNightPalette: Palette = {
  bgDeep:     '#1A1B26',
  bgSurface:  '#24283B',
  bgSidebar:  '#16161E',
  border:     '#414868',
  accent:        '#7AA2F7',
  accentGreen:   '#9ECE6A',
  accentBlue:    '#7AA2F7',
  accentSky:     '#7DCFFF',
  accentPurple:  '#BB9AF7',
  accentPink:    '#F7768E',
  accentAmber:   '#E0AF68',
  accentCode:    '#7AA2F7',
  warning:       '#E0AF68',
  text1:      '#C0CAF5',
  text2:      '#A9B1D6',
  text3:      '#565F89',
  errorText:  '#F7768E',
  errorBg:    'rgba(247,118,142,0.12)',
  addText:    '#9ECE6A',
  addBg:      'rgba(158,206,106,0.12)',
  btnPrimaryBg:     '#7AA2F7',
  btnPrimaryText:   '#1A1B26',
  btnSecondaryBg:   '#414868',
  btnSecondaryText: '#C0CAF5',
  badgeRunningBg:   'rgba(224,175,104,0.15)',
  badgeRunningText: '#E0AF68',
  badgeLinkedBg:    'rgba(158,206,106,0.15)',
  badgeLinkedText:  '#9ECE6A',
  badgeConnectBg:   '#24283B',
  badgeConnectText: '#565F89',
  layoutActiveBg:     '#7AA2F7',
  layoutActiveText:   '#1A1B26',
  layoutInactiveBg:   '#24283B',
  layoutInactiveText: '#565F89',
  crtBadgeBg:   '#16161E',
  crtBadgeText: '#7AA2F7',
  autoSaveBg:   '#24283B',
  diffAddBorder:    '#9ECE6A',
  diffRemoveBorder: '#F7768E',
};
```

- [ ] **Step 1.3: Extend `ThemePresetId` union**

Change in `lib/theme-presets.ts`:
```ts
export type ThemePresetId =
  | 'shelly'
  | 'silkscreen'
  | 'pixel'
  | 'mono'
  | 'dracula'
  | 'nord'
  | 'gruvbox'
  | 'tokyo-night';
```

- [ ] **Step 1.4: Extend `themePresets` map**

```ts
export const themePresets: Record<ThemePresetId, ThemePreset> = {
  shelly:       { id: 'shelly',       font: 'Silkscreen', colors: shellyPalette },
  silkscreen:   { id: 'silkscreen',   font: 'Silkscreen', colors: silkscreenPalette },
  pixel:        { id: 'pixel',        font: 'PressStart2P', colors: silkscreenPalette },
  mono:         { id: 'mono',         font: 'monospace',  colors: silkscreenPalette },
  dracula:      { id: 'dracula',      font: 'Silkscreen', colors: draculaPalette },
  nord:         { id: 'nord',         font: 'Silkscreen', colors: nordPalette },
  gruvbox:      { id: 'gruvbox',      font: 'Silkscreen', colors: gruvboxPalette },
  'tokyo-night':{ id: 'tokyo-night',  font: 'Silkscreen', colors: tokyoNightPalette },
};
```

- [ ] **Step 1.5: Extend `store/types.ts` uiFont union**

Find the `uiFont?: '...'` line and change to:
```ts
uiFont?: 'shelly' | 'silkscreen' | 'pixel' | 'mono' | 'dracula' | 'nord' | 'gruvbox' | 'tokyo-night';
```

- [ ] **Step 1.6: Extend `TerminalPane.tsx` native font mapping**

Find the `fontFamily={settings.uiFont === ...}` block and add the 4 new ids to the Silkscreen branch:
```ts
fontFamily={
  settings.uiFont === 'shelly' || settings.uiFont === 'silkscreen' ||
  settings.uiFont === 'dracula' || settings.uiFont === 'nord' ||
  settings.uiFont === 'gruvbox' || settings.uiFont === 'tokyo-night'
    ? 'silkscreen'
    : settings.uiFont === 'pixel'
    ? 'pixel-mplus'
    : 'jetbrains-mono'
}
```

- [ ] **Step 1.7: Extend `SettingsDropdown.tsx` FontFamilyRow**

Open `components/layout/SettingsDropdown.tsx`, find `FontFamilyRow` or the 4-segment selector, and add 4 more segments for `dracula / nord / gruvbox / tokyo-night` using the same tile pattern. Labels: `Dracula / Nord / Gruvbox / Tokyo`.

- [ ] **Step 1.8: Add 4 Theme rows to CommandPalette**

In `components/CommandPalette.tsx`, find the existing Font preset section (`{ id: 'font-shelly', ... }`) and after `font-mono` add:
```ts
{ id: 'theme-dracula', label: 'Theme: Dracula', hint: 'purple accent', icon: 'palette', category: 'action',
  onExecute: () => { useSettingsStore.getState().updateSettings({ uiFont: 'dracula' }); close(); } },
{ id: 'theme-nord', label: 'Theme: Nord', hint: 'arctic blue', icon: 'palette', category: 'action',
  onExecute: () => { useSettingsStore.getState().updateSettings({ uiFont: 'nord' }); close(); } },
{ id: 'theme-gruvbox', label: 'Theme: Gruvbox', hint: 'retro amber', icon: 'palette', category: 'action',
  onExecute: () => { useSettingsStore.getState().updateSettings({ uiFont: 'gruvbox' }); close(); } },
{ id: 'theme-tokyo-night', label: 'Theme: Tokyo Night', hint: 'deep blue', icon: 'palette', category: 'action',
  onExecute: () => { useSettingsStore.getState().updateSettings({ uiFont: 'tokyo-night' }); close(); } },
```

- [ ] **Step 1.9: tsc check**

Run:
```bash
cd ~/Shelly && npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 1.10: Commit**

```bash
git add -A && git commit -m "feat(theme): add Dracula, Nord, Gruvbox, Tokyo Night theme presets

Four new color presets on top of Silkscreen. Each preset is a full
Palette with mock-safe accent selection (neon-glow compatible). ids
added to ThemePresetId union, themePresets map, settings-store type,
TerminalPane native font mapping, SettingsDropdown selector, and
CommandPalette actions." && git push
```

- [ ] **Step 1.11: Manual smoke test**

On device:
1. Open Settings → Display → Font
2. Tap Dracula → UI accent turns purple
3. Tap Nord → arctic blue
4. Tap Gruvbox → amber
5. Tap Tokyo Night → deep blue
6. Command Palette → search "Theme" → 4 options appear
7. With vim open in terminal, switch theme → vim stays alive

---

## Task 2: MCP manager UI

**Files:**
- Create: `components/settings/MCPSection.tsx`
- Modify: `components/layout/SettingsDropdown.tsx` — add MCP Servers row

**Note**: `MCPSection.tsx` below uses `radii as R` only. The `sizes as S` and `padding as P` imports shown are for future expansion — executing agent may trim them.

---

- [ ] **Step 2.1: Read existing mcp store + catalog**

Run:
```bash
cat store/mcp-store.ts && echo --- && cat lib/mcp-manager.ts
```
Confirm:
- `useMcpStore` exists with `servers: Record<string, { enabled, ... }>` and `toggleServer(id)`
- `lib/mcp-manager.ts` exports `MCP_CATALOG`

If either claim is wrong, stop and update the spec before continuing.

- [ ] **Step 2.2: Create `components/settings/MCPSection.tsx`**

```tsx
import React from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useMcpStore } from '@/store/mcp-store';
import { MCP_CATALOG } from '@/lib/mcp-manager';
import { colors as C, fonts as F, sizes as S, padding as P, radii as R } from '@/theme.config';

export function MCPSection() {
  const servers = useMcpStore((s) => s.servers);
  const toggle = useMcpStore((s) => s.toggleServer);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>MCP SERVERS</Text>
      <Text style={styles.subheading}>
        Enable MCP servers for Claude Code integration. Changes take effect on the next Claude session.
      </Text>
      {MCP_CATALOG.map((entry) => {
        const enabled = servers[entry.id]?.enabled ?? false;
        return (
          <Pressable
            key={entry.id}
            style={styles.row}
            onPress={() => toggle(entry.id)}
          >
            <View style={styles.rowInner}>
              <Text style={styles.name}>{entry.name}</Text>
              <View style={[styles.toggle, enabled && styles.toggleOn]}>
                <Text style={[styles.toggleText, enabled && styles.toggleTextOn]}>
                  {enabled ? 'ON' : 'OFF'}
                </Text>
              </View>
            </View>
            {entry.description ? (
              <Text style={styles.description}>{entry.description}</Text>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bgDeep,
  },
  content: {
    padding: 12,
    gap: 4,
  },
  heading: {
    fontFamily: F.family,
    fontSize: 12,
    fontWeight: '700',
    color: C.accent,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  subheading: {
    fontFamily: F.family,
    fontSize: 9,
    color: C.text3,
    marginBottom: 12,
    letterSpacing: 0.3,
  },
  row: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: R.badge,
    backgroundColor: C.bgSurface,
    marginBottom: 4,
  },
  rowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  name: {
    fontFamily: F.family,
    fontSize: 10,
    fontWeight: '700',
    color: C.text1,
    letterSpacing: 0.4,
  },
  description: {
    fontFamily: F.family,
    fontSize: 8,
    color: C.text3,
    marginTop: 4,
    letterSpacing: 0.2,
  },
  toggle: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: R.badge,
    borderWidth: 1,
    borderColor: C.border,
  },
  toggleOn: {
    borderColor: C.accent,
    backgroundColor: 'rgba(0,212,170,0.15)',
  },
  toggleText: {
    fontFamily: F.family,
    fontSize: 9,
    color: C.text3,
    fontWeight: '700',
  },
  toggleTextOn: {
    color: C.accent,
  },
});
```

**Note:** If `MCP_CATALOG` entries don't have `name` or `description` fields, adapt to the actual shape (read the catalog first). If there is no description field, omit it.

- [ ] **Step 2.3: Wire SettingsDropdown → MCP Modal**

In `components/layout/SettingsDropdown.tsx`:

1. Add `useState` import if missing
2. Add a local state: `const [mcpOpen, setMcpOpen] = useState(false);`
3. Add a new `<Pressable>` row below the existing Theme/Font row (search for `Font:` label or `FontFamilyRow` to find it) with:
   ```tsx
   <Pressable onPress={() => setMcpOpen(true)} style={styles.row}>
     <MaterialIcons name="extension" size={14} color={C.text2} />
     <Text style={styles.label}>MCP Servers</Text>
   </Pressable>
   ```
4. At the very bottom of the dropdown JSX (just before the closing wrapper), add:
   ```tsx
   <Modal visible={mcpOpen} animationType="slide" onRequestClose={() => setMcpOpen(false)}>
     <MCPSection />
     <Pressable onPress={() => setMcpOpen(false)} style={styles.modalClose}>
       <Text style={styles.modalCloseText}>CLOSE</Text>
     </Pressable>
   </Modal>
   ```
5. Add `Modal` to the react-native import list if missing
6. Import `MCPSection` from `@/components/settings/MCPSection`

- [ ] **Step 2.4: tsc check**

```bash
cd ~/Shelly && npx tsc --noEmit
```

- [ ] **Step 2.5: Commit**

```bash
git add -A && git commit -m "feat(settings): MCP manager UI on top of existing store/mcp-store

Lists MCP_CATALOG entries with per-row enable toggle. Reuses existing
toggleServer action so Claude settings.json sync (generateClaudeConfig)
continues to work without plumbing changes." && git push
```

- [ ] **Step 2.6: Manual smoke test**

On device:
1. Open Settings → MCP Servers
2. See list of MCP catalog entries
3. Toggle one → state flips ON
4. Re-open → state persists

---

## Task 3: Background agent scheduler UI

**Files:**
- Modify: `store/agent-store.ts` — add `runAgent(id)` action
- Modify: `lib/agent-manager.ts` — expose run function if not already
- Modify: `components/layout/Sidebar.tsx` — extend Tasks section

---

- [ ] **Step 3.1: Inspect current agent store + manager**

```bash
grep -n "runAgent\|deleteAgent\|agent-executor\|useAgentStore" store/agent-store.ts lib/agent-manager.ts
```

Confirm:
- `store/agent-store.ts` has `agents: Agent[]` and `deleteAgent`
- `lib/agent-manager.ts` has `deleteAgent` exported at line ~159
- Is there an `agent-executor.ts` or similar runner file?

- [ ] **Step 3.2: Add `runAgent` to agent-store**

**Decision rule (apply literally, no interpretation):**

- If Step 3.1 found `runAgent` or equivalent runner in `lib/agent-manager.ts` → **import it and wrap it**
- If no runner was found → **use `pendingCommand` fallback**

Add to `store/agent-store.ts` (after existing `deleteAgent` action):

```ts
// At the top of the file, add this import if not present:
import { useTerminalStore } from '@/store/terminal-store';

// Inside the store definition, after deleteAgent:
runAgent: async (id: string) => {
  const agent = get().agents.find((a) => a.id === id);
  if (!agent) return;
  // Fallback: dispatch the agent's shell command to the active terminal pane.
  // If a native runner exists in agent-manager.ts, call it HERE instead.
  useTerminalStore.setState({
    pendingCommand: (agent as any).command ?? `# agent: ${agent.name}`,
  });
},
```

Also update `AgentStore` type to include `runAgent: (id: string) => Promise<void>`. Record the chosen wiring mode ("native runner" vs "pendingCommand fallback") in the commit message.

- [ ] **Step 3.3: Read Sidebar.tsx Tasks section**

```bash
sed -n '140,240p' components/layout/Sidebar.tsx
```

Find the Tasks section, the `runningAgents` / `recentTasks` subscription, and the empty-state placeholder (`NPM RUN DEV` / `GIT PUSH`).

- [ ] **Step 3.4: Extend Tasks section**

**Required imports** (add to the top of `Sidebar.tsx` if missing):
```tsx
import { Alert } from 'react-native';
import { useAgentStore } from '@/store/agent-store';
```
`MaterialIcons`, `neonDotGlow`, and `formatAge` should already be imported — verify first. If `formatAge` is not present, replace the `{formatAge(task.timestamp)}` usage with `{new Date(task.timestamp).toLocaleTimeString()}`.

Replace the existing Tasks section body with:

```tsx
<SidebarSection title="TASKS" ...>
  {runningAgents.length > 0 && runningAgents.map((agent) => (
    <View key={agent.id} style={styles.taskRow}>
      <View style={[styles.taskDot, { backgroundColor: C.accent }, neonDotGlow]} />
      <Text style={styles.taskName}>{agent.name.toUpperCase()}</Text>
      <View style={[styles.statusBadge, { backgroundColor: C.badgeRunningBg }]}>
        <Text style={[styles.statusBadgeText, { color: C.badgeRunningText }]}>RUNNING</Text>
      </View>
    </View>
  ))}
  {recentTasks.length > 0 && recentTasks.map((task) => (
    <View key={task.id} style={styles.taskRow}>
      <MaterialIcons name="check-circle" size={10} color={C.accentGreen} />
      <Text style={styles.taskName}>{task.name.toUpperCase()}</Text>
      <Text style={styles.taskAge}>{formatAge(task.timestamp)}</Text>
    </View>
  ))}
  {allAgents.length > 0 && (
    <>
      {runningAgents.length + recentTasks.length > 0 && <View style={styles.separator} />}
      <Text style={styles.subheader}>SCHEDULED</Text>
      {allAgents.map((agent) => (
        <View key={agent.id} style={styles.taskRow}>
          <View style={[styles.taskDot, { backgroundColor: C.text3 }]} />
          <Text style={styles.taskName} numberOfLines={1}>{agent.name.toUpperCase()}</Text>
          <Pressable
            onPress={() => useAgentStore.getState().runAgent(agent.id)}
            hitSlop={8}
            style={styles.agentAction}
          >
            <MaterialIcons name="play-arrow" size={12} color={C.accentGreen} />
          </Pressable>
          <Pressable
            onPress={() => {
              Alert.alert(
                'Delete agent',
                `Delete "${agent.name}"?`,
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Delete', style: 'destructive', onPress: () => useAgentStore.getState().deleteAgent(agent.id) },
                ],
              );
            }}
            hitSlop={8}
            style={styles.agentAction}
          >
            <MaterialIcons name="delete-outline" size={12} color={C.errorText} />
          </Pressable>
        </View>
      ))}
    </>
  )}
  {runningAgents.length === 0 && recentTasks.length === 0 && allAgents.length === 0 && (
    <Text style={styles.emptyHint}>Use @agent to create background agents</Text>
  )}
</SidebarSection>
```

Add styles:
```ts
separator: {
  height: 1,
  backgroundColor: C.border,
  marginVertical: 4,
},
subheader: {
  fontFamily: F.family,
  fontSize: 7,
  color: C.text3,
  paddingHorizontal: P.sidebarItem.px,
  paddingVertical: 2,
  letterSpacing: 0.5,
},
agentAction: {
  paddingHorizontal: 3,
},
emptyHint: {
  fontFamily: F.family,
  fontSize: 8,
  color: C.text3,
  paddingHorizontal: P.sidebarItem.px,
  paddingVertical: 4,
  letterSpacing: 0.3,
},
```

Remove the hardcoded `NPM RUN DEV` / `GIT PUSH` rows.

- [ ] **Step 3.5: tsc check**

- [ ] **Step 3.6: Commit**

```bash
git add -A && git commit -m "feat(sidebar): scheduled agent list in Tasks section

Replaces the NPM RUN DEV / GIT PUSH empty-state placeholder with a
live list of registered background agents. Each row has a Run ▶ and
Delete 🗑 button. Running and recently-completed agents still show
above the SCHEDULED subheader. Empty state shows a one-line hint to
create agents via @agent." && git push
```

- [ ] **Step 3.7: Manual smoke test**

On device:
1. In terminal: `@agent create test-agent "echo hello"`
2. Sidebar Tasks section shows `TEST-AGENT` under SCHEDULED
3. Tap ▶ → agent runs, output visible
4. Tap 🗑 → confirm dialog → row disappears
5. Restart app → still gone

---

## Task 4: SSH Profiles UI (key auth only)

**Files:**
- Create: `store/ssh-profiles-store.ts`
- Create: `lib/ssh-cmd.ts`
- Create: `components/profiles/SshProfileModal.tsx`
- Modify: `components/layout/ProfilesSection.tsx`

---

- [ ] **Step 4.1: Create `lib/ssh-cmd.ts`**

Pure function for command assembly so it can be unit-tested later.

```ts
// lib/ssh-cmd.ts
//
// Build an SSH command string from profile metadata. No secrets are
// handled here — the key path is a filesystem reference, and ssh will
// prompt for a passphrase in the terminal if the key is encrypted.

export type SshProfileInput = {
  host: string;
  port: number;
  user: string;
  keyPath: string;
};

export function buildSshCommand(p: SshProfileInput): string {
  // Shell-quote each field so spaces / weird chars survive.
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const parts = ['ssh'];
  if (p.keyPath) parts.push('-i', q(p.keyPath));
  parts.push(`${p.user}@${p.host}`);
  if (p.port && p.port !== 22) parts.push('-p', String(p.port));
  return parts.join(' ');
}
```

- [ ] **Step 4.2: Create `store/ssh-profiles-store.ts`**

```ts
// store/ssh-profiles-store.ts
//
// SSH profile metadata store. Persists label + host + port + user +
// keyPath to AsyncStorage. DOES NOT persist passwords, passphrases, or
// key contents. The key itself lives at `keyPath` on the filesystem.

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type SshProfile = {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  keyPath: string;
};

type SshProfilesState = {
  profiles: SshProfile[];
  addProfile: (profile: Omit<SshProfile, 'id'>) => void;
  updateProfile: (id: string, patch: Partial<Omit<SshProfile, 'id'>>) => void;
  deleteProfile: (id: string) => void;
};

let _nextId = 1;
function genId(): string {
  return `ssh-${Date.now()}-${_nextId++}`;
}

export const useSshProfilesStore = create<SshProfilesState>()(
  persist(
    (set) => ({
      profiles: [],
      addProfile: (profile) =>
        set((s) => ({ profiles: [...s.profiles, { ...profile, id: genId() }] })),
      updateProfile: (id, patch) =>
        set((s) => ({
          profiles: s.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        })),
      deleteProfile: (id) =>
        set((s) => ({ profiles: s.profiles.filter((p) => p.id !== id) })),
    }),
    {
      name: 'shelly-ssh-profiles',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
```

- [ ] **Step 4.3: Create `components/profiles/SshProfileModal.tsx`**

Five-field TextInput modal for add/edit.

```tsx
import React, { useState, useEffect } from 'react';
import { View, Text, Modal, Pressable, TextInput, StyleSheet } from 'react-native';
import { colors as C, fonts as F } from '@/theme.config';
import type { SshProfile } from '@/store/ssh-profiles-store';

type Props = {
  visible: boolean;
  initial?: SshProfile;
  onClose: () => void;
  onSave: (profile: Omit<SshProfile, 'id'>) => void;
};

export function SshProfileModal({ visible, initial, onClose, onSave }: Props) {
  const [label, setLabel] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [user, setUser] = useState('');
  const [keyPath, setKeyPath] = useState('~/.ssh/id_ed25519');

  useEffect(() => {
    if (initial) {
      setLabel(initial.label);
      setHost(initial.host);
      setPort(String(initial.port));
      setUser(initial.user);
      setKeyPath(initial.keyPath);
    } else {
      setLabel('');
      setHost('');
      setPort('22');
      setUser('');
      setKeyPath('~/.ssh/id_ed25519');
    }
  }, [initial, visible]);

  const canSave = label.trim() && host.trim() && user.trim() && keyPath.trim();

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      label: label.trim(),
      host: host.trim(),
      port: parseInt(port, 10) || 22,
      user: user.trim(),
      keyPath: keyPath.trim(),
    });
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>{initial ? 'Edit SSH profile' : 'New SSH profile'}</Text>
          <Field label="LABEL" value={label} onChange={setLabel} placeholder="prod-vps" />
          <Field label="HOST" value={host} onChange={setHost} placeholder="example.com" />
          <Field label="PORT" value={port} onChange={setPort} keyboardType="number-pad" />
          <Field label="USER" value={user} onChange={setUser} placeholder="ryo" />
          <Field label="KEY PATH" value={keyPath} onChange={setKeyPath} placeholder="~/.ssh/id_ed25519" />
          <View style={styles.actions}>
            <Pressable onPress={onClose} style={styles.btn}>
              <Text style={styles.btnText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleSave}
              style={[styles.btn, canSave && styles.btnPrimary]}
              disabled={!canSave}
            >
              <Text style={[styles.btnText, canSave && styles.btnPrimaryText]}>
                {initial ? 'Save' : 'Create'}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Field({ label, value, onChange, placeholder, keyboardType }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'number-pad';
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={C.text3}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboardType ?? 'default'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  card: { width: 300, backgroundColor: C.bgSurface, borderWidth: 1, borderColor: C.border, borderRadius: 6, padding: 14, gap: 8 },
  title: { fontFamily: F.family, fontSize: 11, fontWeight: '700', color: C.accent, marginBottom: 4, letterSpacing: 0.5 },
  field: { gap: 3 },
  fieldLabel: { fontFamily: F.family, fontSize: 8, color: C.text3, letterSpacing: 0.5 },
  input: { fontFamily: F.family, fontSize: 10, color: C.text1, backgroundColor: C.bgDeep, borderWidth: 1, borderColor: C.border, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 6 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 6 },
  btn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 4, borderWidth: 1, borderColor: C.border },
  btnPrimary: { backgroundColor: C.accent, borderColor: C.accent },
  btnText: { fontFamily: F.family, fontSize: 9, fontWeight: '700', color: C.text2 },
  btnPrimaryText: { color: C.bgDeep },
});
```

- [ ] **Step 4.4: Extend `components/layout/ProfilesSection.tsx`**

Read the current file first:

```bash
cat components/layout/ProfilesSection.tsx
```

**Insertion point**: Add the SSH block **at the end of the main `View` return**, after any existing profile content. If the component is currently a stub, replace the body entirely.

**Required imports** (add to the top if missing):
```tsx
import { useState, useCallback } from 'react';
import { Alert, ToastAndroid, Pressable, View, Text, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSshProfilesStore, type SshProfile } from '@/store/ssh-profiles-store';
import { buildSshCommand } from '@/lib/ssh-cmd';
import { useTerminalStore } from '@/store/terminal-store';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import { SshProfileModal } from '@/components/profiles/SshProfileModal';
import { ToastAndroid, Alert, Pressable, View, Text } from 'react-native';

// Inside the section:
const sshProfiles = useSshProfilesStore((s) => s.profiles);
const addProfile = useSshProfilesStore((s) => s.addProfile);
const updateProfile = useSshProfilesStore((s) => s.updateProfile);
const deleteProfile = useSshProfilesStore((s) => s.deleteProfile);
const [modalVisible, setModalVisible] = useState(false);
const [editTarget, setEditTarget] = useState<SshProfile | undefined>(undefined);

const handleProfileTap = useCallback((profile: SshProfile) => {
  const root = useMultiPaneStore.getState().root;
  if (!root) {
    ToastAndroid.show('Open a terminal pane first', ToastAndroid.SHORT);
    return;
  }
  const cmd = buildSshCommand(profile);
  useTerminalStore.setState({ pendingCommand: cmd });
  ToastAndroid.show(`SSH: ${profile.label}`, ToastAndroid.SHORT);
}, []);

const handleLongPress = useCallback((profile: SshProfile) => {
  Alert.alert(profile.label, undefined, [
    { text: 'Edit', onPress: () => { setEditTarget(profile); setModalVisible(true); } },
    { text: 'Delete', style: 'destructive', onPress: () => {
      Alert.alert('Delete', `Delete "${profile.label}"?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteProfile(profile.id) },
      ]);
    } },
    { text: 'Cancel', style: 'cancel' },
  ]);
}, [deleteProfile]);

// Render:
<View style={styles.sshBlock}>
  <Text style={styles.sshHeader}>SSH</Text>
  {sshProfiles.map((p) => (
    <Pressable
      key={p.id}
      style={styles.profileRow}
      onPress={() => handleProfileTap(p)}
      onLongPress={() => handleLongPress(p)}
      delayLongPress={350}
    >
      <MaterialIcons name="vpn-key" size={10} color={C.accent} />
      <Text style={styles.profileLabel}>{p.label.toUpperCase()}</Text>
      <View style={{ flex: 1 }} />
      <Text style={styles.profileHost}>{`${p.user}@${p.host}`}</Text>
    </Pressable>
  ))}
  <Pressable
    style={styles.addRow}
    onPress={() => { setEditTarget(undefined); setModalVisible(true); }}
  >
    <Text style={styles.addText}>+ ADD SSH PROFILE</Text>
  </Pressable>
</View>

<SshProfileModal
  visible={modalVisible}
  initial={editTarget}
  onClose={() => setModalVisible(false)}
  onSave={(profile) => {
    if (editTarget) updateProfile(editTarget.id, profile);
    else addProfile(profile);
  }}
/>
```

- [ ] **Step 4.5: tsc check**

- [ ] **Step 4.6: Commit**

```bash
git add -A && git commit -m "feat(profiles): SSH profile UI (key auth only, no password storage)

Profiles are stored as metadata only: label, host, port, user, keyPath.
No passwords or passphrases are ever persisted. Tap a profile to send
'ssh -i KEY user@host -p PORT' to the active terminal pane via
pendingCommand. Long-press for Edit/Delete. If no terminal pane is
open, a toast warns instead of silently failing.

The private key itself lives at keyPath on the filesystem. Shelly only
references it by path, which means the key never enters app memory
and can't be exfiltrated via app state dumps." && git push
```

- [ ] **Step 4.7: Manual smoke test**

On device:
1. Sidebar Profiles → SSH → `+ ADD SSH PROFILE`
2. Fill prod-vps / example.com / 22 / ryo / ~/.ssh/id_ed25519 → Create
3. Row appears → tap → terminal shows `ssh -i ~/.ssh/id_ed25519 ryo@example.com`
4. Long-press → Edit → change label → Save → row updates
5. Long-press → Delete → confirm → row disappears
6. Restart → still gone
7. Close all terminal panes → tap profile → toast warning

---

## Task 5: llama.cpp UI (6 sub-steps)

Follow spec `docs/superpowers/specs/2026-04-14-llama-cpp-setup-design.md`.

### Sub-task 5A: Pre-flight runtime verification

**Purpose:** Confirm `$HOME`, `unzip`, and write permission before committing to the feature.

- [ ] **Step 5A.1: Run probe commands from a throw-away terminal pane**

Open terminal pane in the installed app (or attach via adb shell) and run:

```bash
echo "HOME=$HOME"
which unzip || echo "no unzip"
which tar
mkdir -p $HOME/models/probe && touch $HOME/models/probe/test && rm -rf $HOME/models/probe && echo OK
```

Expected: `$HOME` resolves to a writable path, `unzip` is available, `OK` prints.

- [ ] **Step 5A.2: Decide based on probe**

| Result | Action |
|---|---|
| All green | Proceed with sub-task 5B |
| `$HOME` empty or unwritable | Stop, write "Task 5 BLOCKED: HOME unusable" into plan and skip to Task 6 |
| `unzip` missing | Stop, write "Task 5 BLOCKED: unzip missing" — decide later whether to bundle busybox or switch to tar.gz |

---

### Sub-task 5B: llama setup state store

**Files:**
- Create: `store/llama-setup-store.ts`

- [ ] **Step 5B.1: Create the store**

```ts
// store/llama-setup-store.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type LlamaStage =
  | 'not-installed'
  | 'downloading-binary'
  | 'downloading-model'
  | 'installed'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error';

type LlamaSetupState = {
  stage: LlamaStage;
  binaryVersion: string | null;
  selectedModelId: string | null;
  errorMessage: string | null;

  setStage: (s: LlamaStage) => void;
  setBinaryVersion: (v: string | null) => void;
  setSelectedModelId: (id: string | null) => void;
  setError: (e: string | null) => void;
};

export const useLlamaSetupStore = create<LlamaSetupState>()(
  persist(
    (set) => ({
      stage: 'not-installed',
      binaryVersion: null,
      selectedModelId: null,
      errorMessage: null,
      setStage: (stage) => set({ stage }),
      setBinaryVersion: (binaryVersion) => set({ binaryVersion }),
      setSelectedModelId: (selectedModelId) => set({ selectedModelId }),
      setError: (errorMessage) => set({ errorMessage }),
    }),
    {
      name: 'shelly-llama-setup',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
```

- [ ] **Step 5B.2: Commit**

```bash
git add -A && git commit -m "feat(llama): add llama-setup-store for stage tracking" && git push
```

---

### Sub-task 5C: lib/llamacpp-setup.ts surgical edits

**Files:**
- Modify: `lib/llamacpp-setup.ts` — remove `--log-disable`, fix stop command if needed, bump health-check retry to 60

- [ ] **Step 5C.1: Read lib/llamacpp-setup.ts carefully**

```bash
sed -n '200,350p' lib/llamacpp-setup.ts
```

Identify:
1. Line with `--log-disable` inside `buildServerStartCommand`
2. `buildStopCommand` implementation (pkill -f or PID-file based?)
3. `buildStartAllScript` health-check retry count (`seq 1 15`? other?)

- [ ] **Step 5C.2: Remove `--log-disable`**

Edit out `--log-disable` from `buildServerStartCommand`. This cascades through all callers (`buildRecommendedStartCommand`, `buildDaemonStartScript`, `buildStartAllScript`).

- [ ] **Step 5C.3: Fix stop command if needed**

If `buildStopCommand` is `pkill -f llama-server`, replace with:

```ts
export function buildStopCommand(): string {
  return [
    'if [ -f "$HOME/models/llama-server.pid" ]; then',
    '  kill $(cat "$HOME/models/llama-server.pid") 2>/dev/null || true',
    '  sleep 3',
    '  kill -9 $(cat "$HOME/models/llama-server.pid") 2>/dev/null || true',
    '  rm -f "$HOME/models/llama-server.pid"',
    'fi',
  ].join('\n');
}
```

If it's already PID-file based, leave alone.

- [ ] **Step 5C.4: Bump health-check retry to 60 seconds**

In `buildStartAllScript`, find the retry loop (likely `for i in $(seq 1 15); do ... sleep 1; done`) and change to `seq 1 60`.

- [ ] **Step 5C.5: tsc check**

- [ ] **Step 5C.6: Commit**

```bash
git add -A && git commit -m "fix(llama): drop --log-disable, PID-file stop, 60s readiness retry

Three surgical fixes to lib/llamacpp-setup.ts:

1. Remove --log-disable from buildServerStartCommand so
   \$HOME/models/llama-server.log actually captures startup errors.
   The change cascades through buildRecommendedStartCommand,
   buildDaemonStartScript, and buildStartAllScript.

2. Replace 'pkill -f llama-server' in buildStopCommand with a
   PID-file based kill that reads \$HOME/models/llama-server.pid
   (already written by buildDaemonStartScript). Avoids false
   positives when grep/tail/less have 'llama-server' in argv.

3. Bump the curl /health retry loop in buildStartAllScript from
   seq 1 15 to seq 1 60. Snapdragon 8 Gen3 mmap warmup for
   Gemma-2-2B-Q4_K_M is 15-40s, so 15s routinely false-negatives." && git push
```

---

### Sub-task 5D: LocalLlmSection UI

**Files:**
- Create: `components/settings/LocalLlmSection.tsx`

- [ ] **Step 5D.1: Write the component**

```tsx
// components/settings/LocalLlmSection.tsx
import React, { useState, useCallback } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Modal, ToastAndroid } from 'react-native';
import { colors as C, fonts as F } from '@/theme.config';
import { useLlamaSetupStore } from '@/store/llama-setup-store';
import { execCommand } from '@/hooks/use-native-exec';
import {
  MODEL_CATALOG,
  buildDownloadCommand,
  buildStartAllScript,
  buildStopCommand,
  buildStatusCommand,
  getModelById,
  checkRamRequirement,
} from '@/lib/llamacpp-setup';
import { usePortsStore } from '@/store/ports-store';

export function LocalLlmSection() {
  const stage = useLlamaSetupStore((s) => s.stage);
  const selectedModelId = useLlamaSetupStore((s) => s.selectedModelId);
  const binaryVersion = useLlamaSetupStore((s) => s.binaryVersion);
  const errorMessage = useLlamaSetupStore((s) => s.errorMessage);
  const setStage = useLlamaSetupStore((s) => s.setStage);
  const setSelectedModelId = useLlamaSetupStore((s) => s.setSelectedModelId);
  const setBinaryVersion = useLlamaSetupStore((s) => s.setBinaryVersion);
  const setError = useLlamaSetupStore((s) => s.setError);

  const [logOpen, setLogOpen] = useState(false);
  const [logText, setLogText] = useState('');

  // Available models = those that pass the device RAM check.
  const available = MODEL_CATALOG.filter((m) => checkRamRequirement(m).ok);
  const selected = selectedModelId ? getModelById(selectedModelId) : null;

  const handleInstall = useCallback(async () => {
    if (!selected) return;
    setStage('downloading-binary');
    setError(null);
    const cmd = buildDownloadCommand(selected);
    const r = await execCommand(cmd, 600_000); // 10 min for big downloads
    if (r.exitCode !== 0) {
      setError(`Download failed: ${(r.stderr || '').trim().slice(-200)}`);
      setStage('error');
      return;
    }
    setBinaryVersion('latest');
    setStage('installed');
    ToastAndroid.show('llama.cpp installed', ToastAndroid.SHORT);
  }, [selected, setBinaryVersion, setError, setStage]);

  const handleStart = useCallback(async () => {
    if (!selected) return;
    setStage('starting');
    setError(null);
    const script = buildStartAllScript(selected);
    const r = await execCommand(script, 90_000); // 60s health + buffer
    if (r.exitCode !== 0 || !r.stdout.includes('OK')) {
      const tail = await execCommand('tail -n 20 "$HOME/models/llama-server.log" 2>/dev/null || echo no-log', 5_000);
      setError(`llama-server failed to start:\n${tail.stdout.slice(-500)}`);
      setStage('error');
      return;
    }
    setStage('running');
  }, [selected, setError, setStage]);

  const handleStop = useCallback(async () => {
    setStage('stopping');
    await execCommand(buildStopCommand(), 10_000);
    setStage('installed');
    ToastAndroid.show('Stopped', ToastAndroid.SHORT);
  }, [setStage]);

  const handleViewLog = useCallback(async () => {
    const r = await execCommand('tail -n 40 "$HOME/models/llama-server.log" 2>/dev/null || echo "no log yet"', 5_000);
    setLogText(r.stdout || 'no output');
    setLogOpen(true);
  }, []);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>LOCAL LLM</Text>

      <Text style={styles.status}>Status: {stage}</Text>
      {binaryVersion && stage !== 'not-installed' && (
        <Text style={styles.sub}>{`Binary: ${binaryVersion}`}</Text>
      )}
      {selected && stage !== 'not-installed' && (
        <Text style={styles.sub}>{`Model: ${selected.filename}`}</Text>
      )}

      {/* Model picker */}
      {(stage === 'not-installed' || stage === 'error') && (
        <>
          <Text style={styles.subheader}>Select a model</Text>
          {available.map((m) => (
            <Pressable
              key={m.id}
              style={[styles.modelRow, selectedModelId === m.id && styles.modelRowActive]}
              onPress={() => setSelectedModelId(m.id)}
            >
              <Text style={styles.modelName}>{m.name}</Text>
              <Text style={styles.modelSize}>{`~${m.sizeGB.toFixed(1)} GB`}</Text>
            </Pressable>
          ))}
          <Pressable
            style={[styles.btn, (!selectedModelId || stage === 'downloading-binary') && styles.btnDisabled]}
            onPress={handleInstall}
            disabled={!selectedModelId}
          >
            <Text style={styles.btnText}>{'Install'}</Text>
          </Pressable>
        </>
      )}

      {stage === 'installed' && (
        <>
          <Pressable style={styles.btn} onPress={handleStart}>
            <Text style={styles.btnText}>Start server</Text>
          </Pressable>
          <Pressable style={styles.btnSecondary} onPress={() => setStage('not-installed')}>
            <Text style={styles.btnSecondaryText}>Change model</Text>
          </Pressable>
        </>
      )}

      {stage === 'starting' && (
        <Text style={styles.sub}>Waiting for :8080 (max 60s)...</Text>
      )}

      {stage === 'running' && (
        <>
          <Text style={styles.running}>Running on :8080</Text>
          <Text style={styles.sub}>Use @local in AI pane to chat.</Text>
          <Pressable style={styles.btn} onPress={handleStop}>
            <Text style={styles.btnText}>Stop server</Text>
          </Pressable>
          <Pressable style={styles.btnSecondary} onPress={handleViewLog}>
            <Text style={styles.btnSecondaryText}>View log</Text>
          </Pressable>
        </>
      )}

      {stage === 'error' && errorMessage && (
        <>
          <Text style={styles.error}>{errorMessage}</Text>
          <Pressable style={styles.btnSecondary} onPress={handleViewLog}>
            <Text style={styles.btnSecondaryText}>View full log</Text>
          </Pressable>
          <Pressable style={styles.btnSecondary} onPress={() => { setStage('installed'); setError(null); }}>
            <Text style={styles.btnSecondaryText}>Reset</Text>
          </Pressable>
        </>
      )}

      <Modal visible={logOpen} transparent animationType="fade" onRequestClose={() => setLogOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setLogOpen(false)}>
          <View style={styles.logCard}>
            <Text style={styles.logTitle}>SERVER LOG</Text>
            <ScrollView style={styles.logScroll}>
              <Text style={styles.logText}>{logText}</Text>
            </ScrollView>
            <Pressable style={styles.btn} onPress={() => setLogOpen(false)}>
              <Text style={styles.btnText}>Close</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bgDeep },
  content: { padding: 14, gap: 6 },
  heading: { fontFamily: F.family, fontSize: 12, fontWeight: '700', color: C.accent, letterSpacing: 0.5, marginBottom: 4 },
  status: { fontFamily: F.family, fontSize: 10, color: C.text1 },
  sub: { fontFamily: F.family, fontSize: 9, color: C.text2, letterSpacing: 0.3 },
  subheader: { fontFamily: F.family, fontSize: 8, color: C.text3, marginTop: 8, marginBottom: 2, letterSpacing: 0.5 },
  modelRow: { flexDirection: 'row', justifyContent: 'space-between', padding: 8, borderWidth: 1, borderColor: C.border, borderRadius: 4, marginBottom: 4 },
  modelRowActive: { borderColor: C.accent, backgroundColor: 'rgba(0,212,170,0.1)' },
  modelName: { fontFamily: F.family, fontSize: 10, color: C.text1 },
  modelSize: { fontFamily: F.family, fontSize: 9, color: C.text2 },
  btn: { backgroundColor: C.accent, paddingVertical: 8, borderRadius: 4, alignItems: 'center', marginTop: 8 },
  btnDisabled: { backgroundColor: C.border, opacity: 0.5 },
  btnText: { fontFamily: F.family, fontSize: 10, fontWeight: '700', color: C.bgDeep, letterSpacing: 0.5 },
  btnSecondary: { borderWidth: 1, borderColor: C.border, paddingVertical: 6, borderRadius: 4, alignItems: 'center', marginTop: 6 },
  btnSecondaryText: { fontFamily: F.family, fontSize: 9, color: C.text2 },
  running: { fontFamily: F.family, fontSize: 11, color: C.accentGreen, fontWeight: '700', marginTop: 4 },
  error: { fontFamily: F.family, fontSize: 9, color: C.errorText, marginTop: 6, lineHeight: 14 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center', padding: 16 },
  logCard: { width: '100%', maxHeight: '80%', backgroundColor: C.bgSurface, borderWidth: 1, borderColor: C.border, borderRadius: 6, padding: 12 },
  logTitle: { fontFamily: F.family, fontSize: 10, fontWeight: '700', color: C.accent, marginBottom: 8, letterSpacing: 0.5 },
  logScroll: { maxHeight: 400 },
  logText: { fontFamily: F.family, fontSize: 8, color: C.text2 },
});
```

- [ ] **Step 5D.2: tsc check**

- [ ] **Step 5D.3: Commit**

```bash
git add -A && git commit -m "feat(llama): LocalLlmSection UI wrapping existing llamacpp-setup lib" && git push
```

---

### Sub-task 5E: Wire SettingsDropdown → Local LLM modal

**Files:**
- Modify: `components/layout/SettingsDropdown.tsx`

- [ ] **Step 5E.1: Add a Local LLM row**

Follow the same pattern as the MCP row from Task 2. A new row opens a Modal containing `<LocalLlmSection />`.

- [ ] **Step 5E.2: tsc check + commit**

```bash
git add -A && git commit -m "feat(settings): open Local LLM section from settings dropdown" && git push
```

---

### Sub-task 5F: Smoke test + doc updates

- [ ] **Step 5F.1: Manual smoke test on device**

1. Install new APK
2. Settings → Local LLM
3. Pick Gemma-2-2B → Install → wait (1-3 min)
4. Start server → wait 60s → status flips to Running
5. AI pane → `@local hello` → response comes back
6. View log → tail shows real content (not empty due to --log-disable)
7. Stop server → back to Installed

- [ ] **Step 5F.2: Update README Status table**

In `README.md`, move "Local LLM via llama.cpp" row to ✅ shipping with the guided-setup note. Remove "llama.cpp guided setup" from Coming Soon.

Sync to downloads:
```bash
cp ~/Shelly/README.md ~/storage/downloads/README.md
```

- [ ] **Step 5F.3: Commit README**

```bash
git add README.md && git commit -m "docs(readme): promote llama.cpp guided setup to shipping" && git push
```

---

## Task 6: Google Drive OAuth + Dropbox/OneDrive direct links (7 sub-steps)

Follow spec `docs/superpowers/specs/2026-04-14-cloud-oauth-design.md`.

### Sub-task 6A: Add dependencies + prebuild

- [ ] **Step 6A.1: Add expo-auth-session + expo-crypto**

```bash
cd ~/Shelly
pnpm add expo-auth-session expo-crypto
```

- [ ] **Step 6A.2: Verify package.json**

Confirm `expo-auth-session` and `expo-crypto` are now under `dependencies` in `package.json`. No `app.config.ts` plugin edits needed — `expo-auth-session` is config-plugin-free.

- [ ] **Step 6A.3: Commit deps**

```bash
git add package.json pnpm-lock.yaml && git commit -m "deps: add expo-auth-session, expo-crypto for Google Drive OAuth" && git push
```

- [ ] **Step 6A.4: Wait for next GitHub Actions build**

Required because JS-only lib adds still require a full rebuild to bundle the new modules.

---

### Sub-task 6B: lib/google-drive.ts

**Files:**
- Create: `lib/google-drive.ts`

- [ ] **Step 6B.1: Write the auth + API helpers**

```ts
// lib/google-drive.ts
//
// Google Drive read-only integration. Uses expo-auth-session (PKCE)
// with an iOS-type OAuth client so no client_secret is needed.

import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system';

const CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '';

export function hasClientId(): boolean {
  return CLIENT_ID.length > 0 && CLIENT_ID !== 'REPLACE_ME';
}

const discovery = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'openid',
  'email',
];

const KEY_ACCESS = 'gdrive.access_token';
const KEY_REFRESH = 'gdrive.refresh_token';
const KEY_EXPIRES = 'gdrive.expires_at';
const KEY_EMAIL = 'gdrive.email';

export function getRedirectUri(): string {
  return AuthSession.makeRedirectUri({
    scheme: 'shelly',
    path: 'oauth/callback',
  });
}

export function getAuthRequestConfig() {
  return {
    clientId: CLIENT_ID,
    scopes: SCOPES,
    redirectUri: getRedirectUri(),
    usePKCE: true,
    responseType: AuthSession.ResponseType.Code,
  };
}

export { discovery };

export async function exchangeCodeForToken(
  code: string,
  codeVerifier: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; email?: string } | null> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        code,
        code_verifier: codeVerifier,
        redirect_uri: getRedirectUri(),
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const email = decodeIdTokenEmail(data.id_token);
    await SecureStore.setItemAsync(KEY_ACCESS, data.access_token);
    if (data.refresh_token) await SecureStore.setItemAsync(KEY_REFRESH, data.refresh_token);
    await SecureStore.setItemAsync(
      KEY_EXPIRES,
      String(Date.now() + data.expires_in * 1000),
    );
    if (email) await SecureStore.setItemAsync(KEY_EMAIL, email);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      email,
    };
  } catch {
    return null;
  }
}

function decodeIdTokenEmail(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = idToken.split('.')[1];
    const decoded = JSON.parse(
      // base64url → base64 → JSON
      atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
    );
    return decoded.email;
  } catch {
    return undefined;
  }
}

async function getValidToken(): Promise<string | null> {
  const expiresAt = parseInt(
    (await SecureStore.getItemAsync(KEY_EXPIRES)) ?? '0',
    10,
  );
  if (Date.now() < expiresAt - 60_000) {
    return SecureStore.getItemAsync(KEY_ACCESS);
  }
  const refresh = await SecureStore.getItemAsync(KEY_REFRESH);
  if (!refresh) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok) {
    await signOut();
    return null;
  }
  const data = await res.json();
  await SecureStore.setItemAsync(KEY_ACCESS, data.access_token);
  await SecureStore.setItemAsync(
    KEY_EXPIRES,
    String(Date.now() + data.expires_in * 1000),
  );
  return data.access_token;
}

export async function signOut(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_ACCESS);
  await SecureStore.deleteItemAsync(KEY_REFRESH);
  await SecureStore.deleteItemAsync(KEY_EXPIRES);
  await SecureStore.deleteItemAsync(KEY_EMAIL);
}

export async function getStoredEmail(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_EMAIL);
}

export async function isSignedIn(): Promise<boolean> {
  const token = await SecureStore.getItemAsync(KEY_ACCESS);
  return !!token;
}

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  isFolder: boolean;
};

export async function listFiles(folderId: string = 'root'): Promise<DriveFile[]> {
  const token = await getValidToken();
  if (!token) throw new Error('Not signed in');

  const q = [
    `'${folderId}' in parents`,
    `mimeType != 'application/vnd.google-apps.document'`,
    `mimeType != 'application/vnd.google-apps.spreadsheet'`,
    `mimeType != 'application/vnd.google-apps.presentation'`,
    `mimeType != 'application/vnd.google-apps.form'`,
    `trashed = false`,
  ].join(' and ');

  const url =
    'https://www.googleapis.com/drive/v3/files' +
    `?pageSize=20&q=${encodeURIComponent(q)}` +
    `&fields=files(id,name,mimeType,modifiedTime)` +
    `&orderBy=folder,modifiedTime desc`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    if (res.status === 401) {
      await signOut();
      throw new Error('Session expired');
    }
    throw new Error(`Drive API ${res.status}`);
  }
  const data = await res.json();
  return (data.files ?? []).map((f: any) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    isFolder: f.mimeType === 'application/vnd.google-apps.folder',
  }));
}

/**
 * Download a file to FileSystem.documentDirectory/shelly-gdrive/<name>
 * and return the bare filesystem path (file:// prefix stripped) so it
 * can be handed to openFile() / exec("cat ...").
 */
export async function downloadFile(fileId: string, name: string): Promise<string> {
  const token = await getValidToken();
  if (!token) throw new Error('Not signed in');

  const dir = `${FileSystem.documentDirectory}shelly-gdrive/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const localUri = `${dir}${name}`;

  const dl = FileSystem.createDownloadResumable(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    localUri,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const result = await dl.downloadAsync();
  if (!result || !result.uri) throw new Error('Download failed');

  // Strip file:// for openFile() which shells out through JNI fork+exec.
  return result.uri.replace(/^file:\/\//, '');
}
```

- [ ] **Step 6B.2: tsc check**

- [ ] **Step 6B.3: Commit**

```bash
git add lib/google-drive.ts && git commit -m "feat(gdrive): auth + files.list + download helpers

PKCE-only OAuth against an iOS-type Google client (no secret). Tokens
live in SecureStore; refresh fires 60s before expiry and on failure
cascades to signOut(). files.list filters out Google Docs/Sheets/
Slides/Forms because those need files/export, not alt=media — they're
out of scope for v1.

Download uses FileSystem.createDownloadResumable with an Authorization
header, then strips the file:// prefix so openFile() can 'cat' the
result through the JNI bridge." && git push
```

---

### Sub-task 6C: google-drive-store

**Files:**
- Create: `store/google-drive-store.ts`

- [ ] **Step 6C.1: Write the store**

```ts
// store/google-drive-store.ts
import { create } from 'zustand';
import { listFiles, isSignedIn, signOut as libSignOut, getStoredEmail, DriveFile } from '@/lib/google-drive';

export type BreadcrumbEntry = { id: string; name: string };

type GoogleDriveState = {
  isSignedIn: boolean;
  email: string | null;
  breadcrumb: BreadcrumbEntry[];
  files: DriveFile[];
  loading: boolean;
  error: string | null;

  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
  enterFolder: (id: string, name: string) => Promise<void>;
  goUp: () => Promise<void>;
  signOut: () => Promise<void>;
  reset: () => void;
};

export const useGoogleDriveStore = create<GoogleDriveState>((set, get) => ({
  isSignedIn: false,
  email: null,
  breadcrumb: [{ id: 'root', name: 'Root' }],
  files: [],
  loading: false,
  error: null,

  hydrate: async () => {
    const signed = await isSignedIn();
    const email = await getStoredEmail();
    set({ isSignedIn: signed, email });
    if (signed) await get().refresh();
  },

  refresh: async () => {
    const current = get().breadcrumb.at(-1);
    if (!current) return;
    set({ loading: true, error: null });
    try {
      const files = await listFiles(current.id);
      set({ files, loading: false });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false });
    }
  },

  enterFolder: async (id, name) => {
    set((s) => ({ breadcrumb: [...s.breadcrumb, { id, name }] }));
    await get().refresh();
  },

  goUp: async () => {
    set((s) =>
      s.breadcrumb.length > 1
        ? { breadcrumb: s.breadcrumb.slice(0, -1) }
        : {},
    );
    await get().refresh();
  },

  signOut: async () => {
    await libSignOut();
    get().reset();
  },

  reset: () => set({
    isSignedIn: false,
    email: null,
    breadcrumb: [{ id: 'root', name: 'Root' }],
    files: [],
    loading: false,
    error: null,
  }),
}));
```

- [ ] **Step 6C.2: tsc + commit**

```bash
git add store/google-drive-store.ts && git commit -m "feat(gdrive): zustand store for breadcrumb + file list cache" && git push
```

---

### Sub-task 6D: GoogleDriveAuthModal

**Files:**
- Create: `components/cloud/GoogleDriveAuthModal.tsx`

- [ ] **Step 6D.1: Write the component**

```tsx
// components/cloud/GoogleDriveAuthModal.tsx
import React, { useEffect } from 'react';
import { View, Text, Modal, Pressable, StyleSheet } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import { discovery, getAuthRequestConfig, exchangeCodeForToken } from '@/lib/google-drive';
import { useGoogleDriveStore } from '@/store/google-drive-store';
import { colors as C, fonts as F } from '@/theme.config';

type Props = {
  visible: boolean;
  onClose: () => void;
};

export function GoogleDriveAuthModal({ visible, onClose }: Props) {
  const hydrate = useGoogleDriveStore((s) => s.hydrate);
  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    getAuthRequestConfig(),
    discovery,
  );

  useEffect(() => {
    if (response?.type === 'success' && response.params.code && request?.codeVerifier) {
      (async () => {
        const result = await exchangeCodeForToken(
          response.params.code,
          request.codeVerifier!,
        );
        if (result) {
          await hydrate();
          onClose();
        }
      })();
    }
  }, [response, request, hydrate, onClose]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>SIGN IN WITH GOOGLE</Text>
          <Text style={styles.body}>
            Read-only access to your Google Drive files. Shelly never sees your password.
          </Text>
          <Pressable
            style={styles.btn}
            disabled={!request}
            onPress={() => promptAsync()}
          >
            <Text style={styles.btnText}>Sign in</Text>
          </Pressable>
          <Pressable onPress={onClose} style={styles.btnSecondary}>
            <Text style={styles.btnSecondaryText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  card: { width: 280, backgroundColor: C.bgSurface, borderWidth: 1, borderColor: C.border, borderRadius: 6, padding: 14, gap: 8 },
  title: { fontFamily: F.family, fontSize: 11, fontWeight: '700', color: C.accent, letterSpacing: 0.5 },
  body: { fontFamily: F.family, fontSize: 9, color: C.text2, lineHeight: 14 },
  btn: { backgroundColor: C.accent, paddingVertical: 8, borderRadius: 4, alignItems: 'center', marginTop: 6 },
  btnText: { fontFamily: F.family, fontSize: 10, fontWeight: '700', color: C.bgDeep },
  btnSecondary: { paddingVertical: 6, alignItems: 'center', marginTop: 2 },
  btnSecondaryText: { fontFamily: F.family, fontSize: 9, color: C.text2 },
});
```

- [ ] **Step 6D.2: tsc + commit**

```bash
git add -A && git commit -m "feat(gdrive): OAuth prompt modal" && git push
```

---

### Sub-task 6E: GoogleDriveList

**Files:**
- Create: `components/cloud/GoogleDriveList.tsx`

- [ ] **Step 6E.1: Write the list + breadcrumb component**

```tsx
// components/cloud/GoogleDriveList.tsx
import React, { useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, ToastAndroid } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useGoogleDriveStore } from '@/store/google-drive-store';
import { downloadFile } from '@/lib/google-drive';
import { openFile } from '@/lib/open-file';
import { colors as C, fonts as F, padding as P, icons as I } from '@/theme.config';

export function GoogleDriveList() {
  const isSignedIn = useGoogleDriveStore((s) => s.isSignedIn);
  const files = useGoogleDriveStore((s) => s.files);
  const breadcrumb = useGoogleDriveStore((s) => s.breadcrumb);
  const loading = useGoogleDriveStore((s) => s.loading);
  const error = useGoogleDriveStore((s) => s.error);
  const hydrate = useGoogleDriveStore((s) => s.hydrate);
  const enterFolder = useGoogleDriveStore((s) => s.enterFolder);
  const goUp = useGoogleDriveStore((s) => s.goUp);
  const signOut = useGoogleDriveStore((s) => s.signOut);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const handleTap = async (f: typeof files[number]) => {
    if (f.isFolder) {
      await enterFolder(f.id, f.name);
      return;
    }
    try {
      ToastAndroid.show('Downloading...', ToastAndroid.SHORT);
      const localPath = await downloadFile(f.id, f.name);
      await openFile(localPath);
    } catch (e) {
      ToastAndroid.show(`Failed: ${e instanceof Error ? e.message : String(e)}`, ToastAndroid.LONG);
    }
  };

  if (!isSignedIn) return null;

  return (
    <View style={styles.root}>
      {/* Breadcrumb row */}
      {breadcrumb.length > 1 && (
        <Pressable style={styles.breadcrumb} onPress={goUp}>
          <MaterialIcons name="arrow-back" size={I.fileIcon} color={C.accent} />
          <Text style={styles.breadcrumbText} numberOfLines={1}>
            {breadcrumb.map((b) => b.name).join(' / ')}
          </Text>
        </Pressable>
      )}

      {loading && <Text style={styles.loading}>Loading...</Text>}
      {error && <Text style={styles.errorText}>{error}</Text>}

      {files.map((f) => (
        <Pressable key={f.id} style={styles.row} onPress={() => handleTap(f)}>
          <MaterialIcons
            name={f.isFolder ? 'folder' : 'insert-drive-file'}
            size={I.fileIcon}
            color={C.accentBlue}
          />
          <Text style={styles.name} numberOfLines={1}>
            {f.name}
          </Text>
        </Pressable>
      ))}

      <Pressable style={styles.signOut} onPress={signOut}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  breadcrumb: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: P.sidebarItem.px, paddingVertical: 2 },
  breadcrumbText: { fontFamily: F.family, fontSize: 8, color: C.accent, letterSpacing: 0.3, flex: 1 },
  loading: { fontFamily: F.family, fontSize: 8, color: C.text3, paddingHorizontal: P.sidebarItem.px, paddingVertical: 4 },
  errorText: { fontFamily: F.family, fontSize: 8, color: C.errorText, paddingHorizontal: P.sidebarItem.px, paddingVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: P.sidebarItem.px, paddingVertical: 2 },
  name: { fontFamily: F.family, fontSize: 8, color: C.text1, flex: 1, letterSpacing: 0.2 },
  signOut: { paddingHorizontal: P.sidebarItem.px, paddingVertical: 4 },
  signOutText: { fontFamily: F.family, fontSize: 8, color: C.text3, letterSpacing: 0.3 },
});
```

- [ ] **Step 6E.2: tsc + commit**

```bash
git add -A && git commit -m "feat(gdrive): Sidebar file list with breadcrumb + download-and-preview" && git push
```

---

### Sub-task 6F: Rewrite Sidebar Cloud section

**Files:**
- Modify: `components/layout/Sidebar.tsx`

- [ ] **Step 6F.1: Remove handleCloudConnect and CLOUD_SERVICES dummy rows**

In `components/layout/Sidebar.tsx`:
1. Delete the `handleCloudConnect` `useCallback` function (around L124)
2. Delete the `CLOUD_OAUTH_URLS` constant (near the top) if nothing else references it — `grep -n CLOUD_OAUTH_URLS components` to confirm
3. Delete the `CLOUD_SERVICES.map` render block inside the Cloud section (around L358)

**Imports to add** for the new Cloud section:
```tsx
import { useState } from 'react';  // if not already imported
import { hasClientId } from '@/lib/google-drive';
import { GoogleDriveList } from '@/components/cloud/GoogleDriveList';
import { GoogleDriveAuthModal } from '@/components/cloud/GoogleDriveAuthModal';
import { useGoogleDriveStore } from '@/store/google-drive-store';
```

`openUrl` is already imported as `const openUrl = useBrowserStore((s) => s.openUrl);` at the top of the Sidebar component — reuse it.

- [ ] **Step 6F.2: Replace Cloud section body**

```tsx
import { hasClientId } from '@/lib/google-drive';
import { GoogleDriveList } from '@/components/cloud/GoogleDriveList';
import { GoogleDriveAuthModal } from '@/components/cloud/GoogleDriveAuthModal';
import { useGoogleDriveStore } from '@/store/google-drive-store';

// State:
const [authModalOpen, setAuthModalOpen] = useState(false);
const gDriveSignedIn = useGoogleDriveStore((s) => s.isSignedIn);

// Cloud section render:
<SidebarSection
  title="CLOUD"
  icon="cloud"
  isOpen={openSections.cloud}
  onToggle={() => toggleSection('cloud')}
  iconsOnly={iconsOnly}
>
  {/* Google Drive */}
  {hasClientId() ? (
    gDriveSignedIn ? (
      <GoogleDriveList />
    ) : (
      <Pressable style={styles.cloudRow} onPress={() => setAuthModalOpen(true)}>
        <MaterialIcons name="cloud" size={10} color={C.accentBlue} />
        <Text style={styles.cloudLabel}>SIGN IN WITH GOOGLE</Text>
      </Pressable>
    )
  ) : (
    <View style={styles.cloudWarn}>
      <Text style={styles.cloudWarnText}>⚠ Drive not configured</Text>
      <Pressable onPress={() => openUrl('https://github.com/RYOITABASHI/Shelly#google-drive-integration-optional')}>
        <Text style={styles.cloudSetup}>Setup guide →</Text>
      </Pressable>
    </View>
  )}

  {/* Dropbox direct link */}
  <Pressable style={styles.cloudRow} onPress={() => openUrl('https://www.dropbox.com/home')}>
    <MaterialIcons name="cloud" size={10} color={C.accentBlue} />
    <Text style={styles.cloudLabel}>OPEN DROPBOX</Text>
    <View style={{ flex: 1 }} />
    <MaterialIcons name="open-in-new" size={I.externalLink} color={C.text2} />
  </Pressable>

  {/* OneDrive direct link */}
  <Pressable style={styles.cloudRow} onPress={() => openUrl('https://onedrive.live.com')}>
    <MaterialIcons name="cloud" size={10} color={C.accentSky} />
    <Text style={styles.cloudLabel}>OPEN ONEDRIVE</Text>
    <View style={{ flex: 1 }} />
    <MaterialIcons name="open-in-new" size={I.externalLink} color={C.text2} />
  </Pressable>
</SidebarSection>

<GoogleDriveAuthModal
  visible={authModalOpen}
  onClose={() => setAuthModalOpen(false)}
/>
```

Add missing styles:
```ts
cloudRow: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 5,
  paddingHorizontal: P.sidebarItem.px,
  height: S.sidebarItemHeight,
},
cloudLabel: {
  fontFamily: F.family,
  fontSize: F.sidebarItem.size,
  color: C.text1,
  letterSpacing: 0.3,
},
cloudWarn: {
  paddingHorizontal: P.sidebarItem.px,
  paddingVertical: 4,
  gap: 2,
},
cloudWarnText: {
  fontFamily: F.family,
  fontSize: 8,
  color: C.warning,
},
cloudSetup: {
  fontFamily: F.family,
  fontSize: 8,
  color: C.accent,
  letterSpacing: 0.3,
},
```

- [ ] **Step 6F.3: tsc check**

- [ ] **Step 6F.4: Commit**

```bash
git add -A && git commit -m "feat(sidebar): Cloud section wired to Google Drive + direct links

Replaces the static handleCloudConnect stub with a three-branch Cloud
section:

1. Google Drive — if EXPO_PUBLIC_GOOGLE_CLIENT_ID is set, shows either
   the file list (signed in) or a Sign In button. If not configured,
   shows a warning banner linking to the README setup guide.
2. Open Dropbox — Browser pane bookmark.
3. Open OneDrive — Browser pane bookmark." && git push
```

---

### Sub-task 6G: README + .env.example + smoke test

- [ ] **Step 6G.1: Create `.env.example`**

```
# Copy to .env.local and fill in your Google OAuth client ID.
# See README "Google Drive integration (optional)" for setup steps.
EXPO_PUBLIC_GOOGLE_CLIENT_ID=
```

- [ ] **Step 6G.2: Add Google Drive setup section to README**

Add this as a new H2 section near the Coming Soon area:

```markdown
## Google Drive integration (optional)

To enable Google Drive browsing in the Cloud sidebar section:

1. Go to https://console.cloud.google.com/apis/credentials
2. Create a new project (or use an existing one)
3. Configure OAuth consent screen → External → add your email as a test user
4. Create credentials → OAuth client ID → **iOS** type
5. Bundle ID: `dev.shelly.terminal`
6. Copy the Client ID into `.env.local`:

   ```
   EXPO_PUBLIC_GOOGLE_CLIENT_ID=12345-abc.apps.googleusercontent.com
   ```

7. Rebuild the APK (`pnpm android` or GitHub Actions push)

Without a Client ID, the Cloud sidebar hides the Drive section and
only shows Dropbox / OneDrive direct browser links.
```

Also update the Status table:
- Move "Sidebar Cloud / SSH Profiles" to ✅ shipping with a note "Drive via OAuth; Dropbox/OneDrive as browser links"
- Remove "Cloud OAuth" from Coming Soon

Sync to downloads:
```bash
cp ~/Shelly/README.md ~/storage/downloads/README.md
```

- [ ] **Step 6G.3: Commit README + env example**

```bash
git add README.md .env.example && git commit -m "docs(readme): Google Drive setup guide + promote Cloud to shipping" && git push
```

- [ ] **Step 6G.4: Manual smoke test**

On device:
1. Without CLIENT_ID → Cloud section shows warning + Dropbox/OneDrive only
2. Set `EXPO_PUBLIC_GOOGLE_CLIENT_ID` + rebuild → "Sign in with Google" appears
3. Tap → browser opens → sign in → returns to Shelly
4. File list appears (20 entries, no Google Docs)
5. Tap a folder → enters, breadcrumb updates
6. Tap ← → goes up
7. Tap a small text file → downloads → Preview pane shows content
8. Tap Sign out → back to Sign in button
9. Tap Dropbox → Browser pane opens dropbox.com
10. Tap OneDrive → Browser pane opens onedrive.live.com

---

## Task 7: README + handoff final sync

- [ ] **Step 7.1: Update handoff doc**

In `docs/superpowers/specs/2026-04-13-handoff.md`, add a "2026-04-14 session" subsection at the top listing the 6 commits (one per Task) with their short hashes.

- [ ] **Step 7.2: Check README Coming Soon is empty or minimal**

Remaining Coming Soon should be:
- App icon + Play Store / F-Droid distribution

All other items should have moved to the Status table.

- [ ] **Step 7.3: Sync downloads README**

```bash
cp ~/Shelly/README.md ~/storage/downloads/README.md
```

- [ ] **Step 7.4: Commit**

```bash
git add -A && git commit -m "docs: 2026-04-14 Coming Soon completion handoff sync" && git push
```

---

## Task 8: Final status table pass

- [ ] **Step 8.1: Read README Status table**

```bash
sed -n '/^## Status/,/^---$/p' README.md
```

Verify each of the 6 features has a ✅ shipping row. Any feature that failed pre-flight (e.g., Task 5 blocked) should be clearly marked 🟡 with the blocker reason.

- [ ] **Step 8.2: Build one final APK**

Trigger via push (already happened in each prior task), or explicitly `gh workflow run build-android.yml`. Wait for success.

- [ ] **Step 8.3: Final smoke test checklist**

Walk through all 6 features on device in a single session:
- [ ] Theme: switch to Dracula, Nord, Gruvbox, Tokyo Night via Settings and Command Palette
- [ ] MCP: toggle one MCP server, verify persist
- [ ] Agent: create a test agent, run, delete
- [ ] SSH: create a profile, tap to populate terminal, edit, delete
- [ ] llama: install Gemma, start, `@local hello`, stop
- [ ] Drive: sign in (if CLIENT_ID set), browse, download a file

- [ ] **Step 8.4: Update memory**

Append the 2026-04-14 completion to `~/.claude/projects/.../memory/shelly-session-20260413.md` or create a new `shelly-session-20260414.md` entry.

---

## Rollback plan

If any Task fails catastrophically:
1. `git log --oneline -5` to find the last green commit
2. `git revert <bad-commit>` (preferred) or `git reset --hard <green-hash>` + `git push --force-with-lease` (only if the bad commit hasn't been pulled by anyone)
3. Re-plan the failed Task with fresh context

If a pre-flight check fails (Task 5A), mark the feature blocked in README Status and skip to the next Task.

---

## Execution handoff (read by operator)

This plan is written to be executable by `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Each Task is self-contained; a fresh subagent per Task is fine.

Total estimated time: **6 hours**. Tasks 1-4 are 3 hours combined, Task 5 is 75 minutes, Task 6 is 120 minutes, Tasks 7-8 are cleanup.

**Warnings for the executing agent:**
- `MCP_CATALOG` shape must be confirmed at Step 2.2 — adapt the component if fields differ
- `lib/llamacpp-setup.ts` lines may have drifted from the spec's line numbers — grep for the function names, don't hard-reference line numbers
- Task 6 requires a rebuild after `pnpm add` (Step 6A.4); don't run the subsequent steps in the same session without waiting for the new APK
- Task 5A can block the entire Task 5 — if pre-flight fails, document and skip, don't try to "fix" the Android runtime
