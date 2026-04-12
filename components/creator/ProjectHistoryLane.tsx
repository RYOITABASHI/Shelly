/**
 * components/creator/ProjectHistoryLane.tsx  — v2.2
 *
 * Project History lane with:
 *  - Real-time search bar (name / date / tags)
 *  - Tag chip filter (horizontal scroll, multi-select OR)
 *  - Sort selector (createdAt / lastOpenedAt / name)
 *  - Tag editing per project (⋯ menu)
 *  - Open / Clone / Improve / Delete actions
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  Alert,
  TextInput,
  ScrollView,
  Modal,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { CreatorProject, ProjectSortOrder } from '@/store/types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  projects: CreatorProject[];
  onOpen: (project: CreatorProject) => void;
  onClone: (project: CreatorProject) => void;
  onImprove: (project: CreatorProject) => void;
  onDelete: (project: CreatorProject) => void;
  onUpdateTags: (projectId: string, tags: string[]) => void;
  onExport?: () => void;
  onImport?: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TYPE_ICONS: Record<string, string> = {
  web: '🌐',
  script: '⚡',
  document: '📄',
  unknown: '📦',
};

function formatDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${day} ${h}:${min}`;
}

function formatDateCompact(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** Collect all unique tags from all projects */
function collectAllTags(projects: CreatorProject[]): string[] {
  const set = new Set<string>();
  for (const p of projects) {
    for (const t of p.tags ?? []) {
      if (t.trim()) set.add(t.trim());
    }
  }
  return Array.from(set).sort();
}

/** Filter projects by query and active tags */
function filterProjects(
  projects: CreatorProject[],
  query: string,
  activeTags: string[]
): CreatorProject[] {
  let result = projects;

  // Tag filter (OR)
  if (activeTags.length > 0) {
    result = result.filter((p) =>
      activeTags.some((t) => (p.tags ?? []).includes(t))
    );
  }

  // Text search
  const q = query.trim().toLowerCase();
  if (q) {
    result = result.filter((p) => {
      const nameMatch = p.name.toLowerCase().includes(q);
      const dateMatch = formatDateCompact(p.createdAt).includes(q);
      const tagMatch = (p.tags ?? []).some((t) => t.toLowerCase().includes(q));
      const inputMatch = p.userInput.toLowerCase().includes(q);
      return nameMatch || dateMatch || tagMatch || inputMatch;
    });
  }

  return result;
}

/** Sort projects */
function sortProjects(
  projects: CreatorProject[],
  order: ProjectSortOrder
): CreatorProject[] {
  return [...projects].sort((a, b) => {
    switch (order) {
      case 'lastOpenedAt':
        return (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt);
      case 'name':
        return a.name.localeCompare(b.name, 'ja');
      case 'tags':
        return (a.tags?.[0] ?? '').localeCompare(b.tags?.[0] ?? '', 'ja');
      case 'createdAt':
      default:
        return b.createdAt - a.createdAt;
    }
  });
}

// ─── TagEditModal ─────────────────────────────────────────────────────────────

function TagEditModal({
  visible,
  project,
  onSave,
  onClose,
}: {
  visible: boolean;
  project: CreatorProject | null;
  onSave: (tags: string[]) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState('');

  React.useEffect(() => {
    if (visible && project) {
      setInput((project.tags ?? []).join(', '));
    }
  }, [visible, project]);

  const handleSave = () => {
    const tags = input
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    onSave(tags);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={tagModalStyles.overlay}
      >
        <View style={tagModalStyles.sheet}>
          <Text style={tagModalStyles.title}>Edit Tags</Text>
          <Text style={tagModalStyles.hint}>
            Comma separated (e.g. school, website, timer)
          </Text>
          <TextInput
            style={tagModalStyles.input}
            value={input}
            onChangeText={setInput}
            placeholder="Enter tag..."
            placeholderTextColor="#374151"
            autoFocus
            returnKeyType="done"
            onSubmitEditing={handleSave}
          />
          <View style={tagModalStyles.actions}>
            <Pressable
              style={({ pressed }) => [tagModalStyles.cancelBtn, pressed && { opacity: 0.7 }]}
              onPress={onClose}
            >
              <Text style={tagModalStyles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [tagModalStyles.saveBtn, pressed && { opacity: 0.7 }]}
              onPress={handleSave}
            >
              <Text style={tagModalStyles.saveText}>Save</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const tagModalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#111111',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderColor: '#1E1E1E',
    padding: 20,
    gap: 12,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: '#E5E7EB',
  },
  hint: {
    fontSize: 11,
    color: '#4B5563',
  },
  input: {
    backgroundColor: '#0D0D0D',
    borderWidth: 1,
    borderColor: '#272727',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#E5E7EB',
    fontSize: 13,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#272727',
    borderRadius: 8,
  },
  cancelText: {
    fontSize: 13,
    color: '#6B7280',
  },
  saveBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: 'rgba(0, 212, 170, 0.1)',
    borderWidth: 1,
    borderColor: '#00D4AA',
    borderRadius: 8,
  },
  saveText: {
    fontSize: 13,
    color: '#00D4AA',
    fontWeight: '600',
  },
});

// ─── ProjectCard ──────────────────────────────────────────────────────────────

function ProjectCard({
  project,
  onOpen,
  onClone,
  onImprove,
  onDelete,
  onEditTags,
}: {
  project: CreatorProject;
  onOpen: (p: CreatorProject) => void;
  onClone: (p: CreatorProject) => void;
  onImprove: (p: CreatorProject) => void;
  onDelete: (p: CreatorProject) => void;
  onEditTags: (p: CreatorProject) => void;
}) {
  const icon = TYPE_ICONS[project.projectType] ?? '📦';
  const tags = project.tags ?? [];
  const visibleTags = tags.slice(0, 3);
  const hiddenCount = tags.length - visibleTags.length;

  const handleDelete = useCallback(() => {
    Alert.alert(
      'Delete?',
      `「${project.name}」 will be removed from history.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => onDelete(project) },
      ]
    );
  }, [project, onDelete]);

  const handleMenu = useCallback(() => {
    Alert.alert(
      project.name,
      'Choose an action',
      [
        { text: 'Edit tags', onPress: () => onEditTags(project) },
        { text: 'Clone', onPress: () => onClone(project) },
        { text: 'Improve', onPress: () => onImprove(project) },
        { text: 'Delete', style: 'destructive', onPress: handleDelete },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  }, [project, onEditTags, onClone, onImprove, handleDelete]);

  return (
    <View style={cardStyles.card}>
      {/* Header row */}
      <View style={cardStyles.header}>
        <Text style={cardStyles.icon}>{icon}</Text>
        <View style={cardStyles.meta}>
          <Text style={cardStyles.name} numberOfLines={1}>
            {project.name}
          </Text>
          <Text style={cardStyles.date}>{formatDate(project.createdAt)}</Text>
        </View>
        <View style={[cardStyles.statusBadge, project.status === 'done' ? cardStyles.statusDone : cardStyles.statusError]}>
          <Text style={cardStyles.statusText}>{project.status === 'done' ? 'Done' : 'Error'}</Text>
        </View>
        <Pressable
          style={({ pressed }) => [cardStyles.menuBtn, pressed && { opacity: 0.6 }]}
          onPress={handleMenu}
        >
          <Text style={cardStyles.menuBtnText}>⋯</Text>
        </Pressable>
      </View>

      {/* Path */}
      <Text style={cardStyles.path} numberOfLines={1}>
        ~/Projects/{project.path}
      </Text>

      {/* Tags */}
      {tags.length > 0 && (
        <View style={cardStyles.tagRow}>
          {visibleTags.map((t) => (
            <View key={t} style={cardStyles.tagChip}>
              <Text style={cardStyles.tagText}>{t}</Text>
            </View>
          ))}
          {hiddenCount > 0 && (
            <View style={cardStyles.tagChipMore}>
              <Text style={cardStyles.tagTextMore}>+{hiddenCount}</Text>
            </View>
          )}
        </View>
      )}

      {/* Action buttons */}
      <View style={cardStyles.actions}>
        <Pressable
          style={({ pressed }) => [cardStyles.actionBtn, cardStyles.actionOpen, pressed && { opacity: 0.7 }]}
          onPress={() => onOpen(project)}
        >
          <Text style={cardStyles.actionOpenText}>📂 Open</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [cardStyles.actionBtn, cardStyles.actionClone, pressed && { opacity: 0.7 }]}
          onPress={() => onClone(project)}
        >
          <Text style={cardStyles.actionCloneText}>⧉ Clone</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [cardStyles.actionBtn, cardStyles.actionImprove, pressed && { opacity: 0.7 }]}
          onPress={() => onImprove(project)}
        >
          <Text style={cardStyles.actionImproveText}>✦ Improve</Text>
        </Pressable>
      </View>
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: '#111111',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1E1E1E',
    padding: 12,
    marginBottom: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  icon: { fontSize: 20 },
  meta: { flex: 1 },
  name: {
    fontSize: 14,
    fontWeight: '600',
    color: '#E5E7EB',
  },
  date: {
    fontSize: 10,
    color: '#4B5563',
    marginTop: 1,
  },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statusDone: {
    backgroundColor: '#052E16',
    borderWidth: 1,
    borderColor: '#166534',
  },
  statusError: {
    backgroundColor: '#2D0A0A',
    borderWidth: 1,
    borderColor: '#7F1D1D',
  },
  statusText: {
    fontSize: 9,
    color: '#6EE7B7',
  },
  menuBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  menuBtnText: {
    fontSize: 16,
    color: '#4B5563',
  },
  path: {
    fontSize: 10,
    color: '#374151',
    marginBottom: 8,
    marginLeft: 28,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginBottom: 10,
    marginLeft: 28,
  },
  tagChip: {
    backgroundColor: '#0A1628',
    borderWidth: 1,
    borderColor: '#1E3A5F',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  tagText: {
    fontSize: 10,
    color: '#60A5FA',
  },
  tagChipMore: {
    backgroundColor: '#1A1A1A',
    borderWidth: 1,
    borderColor: '#272727',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  tagTextMore: {
    fontSize: 10,
    color: '#4B5563',
  },
  actions: {
    flexDirection: 'row',
    gap: 6,
  },
  actionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
  },
  actionOpen: { backgroundColor: '#0A1628', borderColor: '#1E3A5F' },
  actionOpenText: { fontSize: 11, color: '#60A5FA', fontFamily: 'Silkscreen' },
  actionClone: { backgroundColor: '#0D1F0D', borderColor: '#1A3D1A' },
  actionCloneText: { fontSize: 11, color: '#4ADE80', fontFamily: 'Silkscreen' },
  actionImprove: { backgroundColor: '#1A1000', borderColor: '#3D2A00' },
  actionImproveText: { fontSize: 11, color: '#FBBF24', fontFamily: 'Silkscreen' },
});

// ─── SortSelector ─────────────────────────────────────────────────────────────

const SORT_OPTIONS: { value: ProjectSortOrder; label: string }[] = [
  { value: 'createdAt', label: 'Newest' },
  { value: 'lastOpenedAt', label: 'Recently opened' },
  { value: 'name', label: 'By name' },
  { value: 'tags', label: 'By tags' },
];

function SortSelector({
  value,
  onChange,
}: {
  value: ProjectSortOrder;
  onChange: (v: ProjectSortOrder) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={sortStyles.scroll}
      contentContainerStyle={sortStyles.content}
    >
      {SORT_OPTIONS.map((opt) => (
        <Pressable
          key={opt.value}
          style={[sortStyles.chip, value === opt.value && sortStyles.chipActive]}
          onPress={() => onChange(opt.value)}
        >
          <Text style={[sortStyles.chipText, value === opt.value && sortStyles.chipTextActive]}>
            {opt.label}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const sortStyles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  content: { gap: 6, paddingHorizontal: 12, paddingVertical: 6 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#272727',
    backgroundColor: '#0D0D0D',
  },
  chipActive: {
    borderColor: '#00D4AA',
    backgroundColor: 'rgba(0, 212, 170, 0.08)',
  },
  chipText: {
    fontSize: 11,
    color: '#4B5563',
  },
  chipTextActive: {
    color: '#00D4AA',
  },
});

// ─── TagChipFilter ────────────────────────────────────────────────────────────

function TagChipFilter({
  allTags,
  activeTags,
  onToggle,
  onClear,
}: {
  allTags: string[];
  activeTags: string[];
  onToggle: (tag: string) => void;
  onClear: () => void;
}) {
  if (allTags.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={tagFilterStyles.scroll}
      contentContainerStyle={tagFilterStyles.content}
    >
      {/* "All" chip */}
      <Pressable
        style={[tagFilterStyles.chip, activeTags.length === 0 && tagFilterStyles.chipActive]}
        onPress={onClear}
      >
        <Text style={[tagFilterStyles.chipText, activeTags.length === 0 && tagFilterStyles.chipTextActive]}>
          All
        </Text>
      </Pressable>

      {allTags.map((tag) => {
        const isActive = activeTags.includes(tag);
        return (
          <Pressable
            key={tag}
            style={[tagFilterStyles.chip, isActive && tagFilterStyles.chipActive]}
            onPress={() => onToggle(tag)}
          >
            <Text style={[tagFilterStyles.chipText, isActive && tagFilterStyles.chipTextActive]}>
              {tag}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const tagFilterStyles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  content: { gap: 6, paddingHorizontal: 12, paddingVertical: 6 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#272727',
    backgroundColor: '#0D0D0D',
  },
  chipActive: {
    borderColor: '#60A5FA',
    backgroundColor: 'rgba(96, 165, 250, 0.1)',
  },
  chipText: {
    fontSize: 11,
    color: '#4B5563',
  },
  chipTextActive: {
    color: '#60A5FA',
  },
});

// ─── ProjectHistoryLane ───────────────────────────────────────────────────────

export function ProjectHistoryLane({
  projects,
  onOpen,
  onClone,
  onImprove,
  onDelete,
  onUpdateTags,
  onExport,
  onImport,
}: Props) {
  const [query, setQuery] = useState('');
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [sortOrder, setSortOrder] = useState<ProjectSortOrder>('createdAt');
  const [tagEditProject, setTagEditProject] = useState<CreatorProject | null>(null);

  // Collect all tags from all projects
  const allTags = useMemo(() => collectAllTags(projects), [projects]);

  // Filter + sort
  const displayProjects = useMemo(() => {
    const filtered = filterProjects(projects, query, activeTags);
    return sortProjects(filtered, sortOrder);
  }, [projects, query, activeTags, sortOrder]);

  const handleTagToggle = useCallback((tag: string) => {
    setActiveTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  }, []);

  const handleTagClear = useCallback(() => setActiveTags([]), []);

  const handleEditTags = useCallback((project: CreatorProject) => {
    setTagEditProject(project);
  }, []);

  const handleSaveTags = useCallback(
    (tags: string[]) => {
      if (!tagEditProject) return;
      onUpdateTags(tagEditProject.id, tags);
    },
    [tagEditProject, onUpdateTags]
  );

  const handleGlobalMenu = useCallback(() => {
    Alert.alert(
      'Project list',
      'Choose an action',
      [
        { text: 'Export', onPress: onExport },
        { text: 'Import', onPress: onImport },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  }, [onExport, onImport]);

  return (
    <View style={styles.container}>
      {/* Header with menu */}
      <View style={styles.historyHeader}>
        <Text style={styles.historyTitle}>📂 Project History</Text>
        <Pressable
          style={({ pressed }) => [styles.menuBtn, pressed && { opacity: 0.6 }]}
          onPress={handleGlobalMenu}
        >
          <Text style={styles.menuBtnText}>⋯</Text>
        </Pressable>
      </View>

      {/* Search bar */}
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search by name, date, tag..."
            placeholderTextColor="#374151"
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          {query.length > 0 && (
            <Pressable style={styles.clearBtn} onPress={() => setQuery('')}>
              <Text style={styles.clearBtnText}>✕</Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* Tag chip filter */}
      <TagChipFilter
        allTags={allTags}
        activeTags={activeTags}
        onToggle={handleTagToggle}
        onClear={handleTagClear}
      />

      {/* Sort selector */}
      <SortSelector value={sortOrder} onChange={setSortOrder} />

      {/* Result count */}
      <View style={styles.resultRow}>
        <Text style={styles.resultCount}>
          {displayProjects.length} items
          {(query || activeTags.length > 0) ? ` / total ${projects.length}items` : ''}
        </Text>
      </View>

      {/* List */}
      {displayProjects.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>
            {projects.length === 0 ? '📂' : '🔍'}
          </Text>
          <Text style={styles.emptyText}>
            {projects.length === 0
              ? 'No projects yet'
              : 'No results found'}
          </Text>
          <Text style={styles.emptyHint}>
            {projects.length === 0
              ? 'Create something with Creator'
              : 'Try different keywords'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={displayProjects}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <ProjectCard
              project={item}
              onOpen={onOpen}
              onClone={onClone}
              onImprove={onImprove}
              onDelete={onDelete}
              onEditTags={handleEditTags}
            />
          )}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews
          maxToRenderPerBatch={20}
          windowSize={10}
          initialNumToRender={15}
        />
      )}

      {/* Tag edit modal */}
      <TagEditModal
        visible={tagEditProject !== null}
        project={tagEditProject}
        onSave={handleSaveTags}
        onClose={() => setTagEditProject(null)}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  searchRow: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111111',
    borderWidth: 1,
    borderColor: '#1E1E1E',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    gap: 8,
  },
  searchIcon: {
    fontSize: 14,
  },
  searchInput: {
    flex: 1,
    color: '#E5E7EB',
    fontSize: 13,
    padding: 0,
  },
  clearBtn: {
    padding: 2,
  },
  clearBtnText: {
    fontSize: 12,
    color: '#4B5563',
  },
  resultRow: {
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  resultCount: {
    fontSize: 10,
    color: '#374151',
  },
  list: {
    padding: 12,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    gap: 8,
  },
  emptyIcon: {
    fontSize: 40,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#4B5563',
  },
  emptyHint: {
    fontSize: 11,
    color: '#374151',
  },
  historyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 4,
  },
  historyTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#9BA1A6',
  },
  menuBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  menuBtnText: {
    fontSize: 18,
    color: '#9BA1A6',
  },
});
