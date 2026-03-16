/**
 * app/(tabs)/creator.tsx  — v2.1
 *
 * Creator Engine screen with:
 *  - 4-lane layout (Command / Plan / Build / Result)
 *  - History tab (past projects with Open / Clone / Improve)
 *  - Termux real-file generation (when connected)
 *  - Non-engineer UX messages (natural language only)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Alert,
  Platform,
  Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import { ScreenContainer } from '@/components/screen-container';
import { CommandLane } from '@/components/creator/CommandLane';
import { PlanLane } from '@/components/creator/PlanLane';
import { BuildLane } from '@/components/creator/BuildLane';
import { ResultLane } from '@/components/creator/ResultLane';
import { ProjectHistoryLane } from '@/components/creator/ProjectHistoryLane';
import { ToolsLane } from '@/components/creator/ToolsLane';

import { useCreatorStore } from '@/store/creator-store';
import { useSnippetStore } from '@/store/snippet-store';
import { useTerminalStore } from '@/store/terminal-store';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
import { CreatorProject } from '@/store/types';
import { buildRunCommand } from '@/lib/creator-engine';
import { exportProjects } from '@/lib/project-io';
import { ImportProjectsModal } from '@/components/creator/ImportProjectsModal';
import { useTranslation } from '@/lib/i18n';

// ─── Constants ────────────────────────────────────────────────────────────────

const STEP_DELAY = 400;

type TabId = 'create' | 'history' | 'tools';

// ─── Component ────────────────────────────────────────────────────────────────

export default function CreatorScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<TabId>('create');

  // Creator store
  const {
    sessionStatus,
    currentProject,
    projects,
    startPlanning,
    confirmPlan,
    cancelSession,
    resetSession,
    advanceBuildStep,
    updateBuildStepMessage,
    finishProject,
    failProject,
    getCompletionMessage,
    getRecipeCommand,
    loadProjects,
    deleteProject,
    cloneProject,
    updateProjectTags,
    touchProject,
  } = useCreatorStore();

  // Snippet store (for Recipe saving)
  const { addSnippet: saveSnippetToStore } = useSnippetStore();

  // Terminal store (for running commands)
  const { insertCommand, settings } = useTerminalStore();

  // Termux bridge (for real file generation + Tools exec)
  const {
    createProject: termuxCreateProject,
    openFolder,
    runCommand: termuxRunCommand,
    cancelCurrent: termuxCancelCurrent,
    isConnected: termuxConnected,
    testConnection: termuxTestConnection,
  } = useTermuxBridge();

  const [recipeSaved, setRecipeSaved] = useState(false);
  const [importModalVisible, setImportModalVisible] = useState(false);
  const buildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  // Load project history on mount
  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Reset recipe saved state when session resets
  useEffect(() => {
    if (sessionStatus === 'idle') {
      setRecipeSaved(false);
    }
  }, [sessionStatus]);

  // ── Build flow ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (sessionStatus !== 'building' || !currentProject) return;

    const steps = currentProject.buildSteps;
    let stepIndex = 0;

    if (termuxConnected) {
      // ── Termux real file generation ──────────────────────────────────────
      const runTermuxBuild = async () => {
        // Step 0: create project folder + files
        const firstStep = steps[0];
        if (firstStep) {
          advanceBuildStep(firstStep.id, 'running');
          updateBuildStepMessage(firstStep.id, 'Preparing workspace...');
        }

        const files = currentProject.files.map((f) => ({
          path: f.path,
          content: f.content,
        }));

        const result = await termuxCreateProject(
          `Projects/${currentProject.path}`,
          files,
          (msg, current, total) => {
            // Update the current running step with real-time progress
            const runningStep = steps[Math.min(current, steps.length - 1)];
            if (runningStep) {
              advanceBuildStep(runningStep.id, 'running');
              updateBuildStepMessage(runningStep.id, msg);
            }
          }
        );

        if (result.ok) {
          // Mark all steps done
          for (const step of steps) {
            advanceBuildStep(step.id, 'done');
          }
          await finishProject(result.projectPath);
        } else {
          failProject(`Failed to create files: ${(result as { ok: false; error: string }).error}`);
          if (Platform.OS !== 'web') {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          }
          return;
        }
        if (Platform.OS !== 'web') {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      };

      runTermuxBuild();
    } else {
      // ── Simulated build (no Termux) ──────────────────────────────────────
      const runNextStep = () => {
        if (stepIndex >= steps.length) {
          finishProject().then(() => {
            if (Platform.OS !== 'web') {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            }
          });
          return;
        }

        const step = steps[stepIndex];
        advanceBuildStep(step.id, 'running');

        buildTimerRef.current = setTimeout(() => {
          advanceBuildStep(step.id, 'done');
          stepIndex++;
          buildTimerRef.current = setTimeout(runNextStep, STEP_DELAY / 2);
        }, STEP_DELAY);
      };

      buildTimerRef.current = setTimeout(runNextStep, 200);
    }

    return () => {
      if (buildTimerRef.current) clearTimeout(buildTimerRef.current);
    };
  }, [sessionStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to bottom when status changes
  useEffect(() => {
    setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, [sessionStatus]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    (input: string) => {
      startPlanning(input);
      setActiveTab('create');
    },
    [startPlanning]
  );

  const handleConfirm = useCallback(() => {
    confirmPlan();
  }, [confirmPlan]);

  const handleCancel = useCallback(() => {
    if (buildTimerRef.current) clearTimeout(buildTimerRef.current);
    cancelSession();
  }, [cancelSession]);

  const handleNewProject = useCallback(() => {
    if (buildTimerRef.current) clearTimeout(buildTimerRef.current);
    resetSession();
  }, [resetSession]);

  const handleRunInTerminal = useCallback(() => {
    if (!currentProject) return;
    const cmd = buildRunCommand(currentProject);
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    insertCommand(cmd);
    Alert.alert(
      'Sent to Terminal',
      'Check and run the command in the Terminal tab.',
      [{ text: 'OK' }]
    );
  }, [currentProject, insertCommand]);

  const handleOpenFolder = useCallback(() => {
    if (!currentProject) return;
    if (termuxConnected) {
      openFolder(`Projects/${currentProject.path}`);
    } else {
      Alert.alert(
        t('creator.open_folder'),
        t('creator.open_folder_msg', { path: currentProject.path }),
        [{ text: 'OK' }]
      );
    }
  }, [currentProject, termuxConnected, openFolder]);

  const handleSaveRecipe = useCallback(() => {
    if (!currentProject || recipeSaved) return;
    const cmd = getRecipeCommand();
    saveSnippetToStore({
      title: `Recipe: ${currentProject.name}`,
      command: cmd,
      tags: ['recipe', currentProject.projectType],
      scope: 'global',
    });
    setRecipeSaved(true);
    if (Platform.OS !== 'web') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }, [currentProject, recipeSaved, getRecipeCommand, saveSnippetToStore]);

  // Export / Import handlers
  const handleExportProjects = useCallback(async () => {
    if (projects.length === 0) {
      Alert.alert(t('settings.export'), t('creator.export_empty'));
      return;
    }
    const ok = await exportProjects(projects);
    if (!ok) {
      Alert.alert(t('settings.error_label'), t('creator.export_failed'));
    }
  }, [projects]);

  const handleImportProjects = useCallback(() => {
    setImportModalVisible(true);
  }, []);

  // History handlers
  const handleHistoryOpen = useCallback((project: CreatorProject) => {
    // Update lastOpenedAt
    touchProject(project.id);
    if (termuxConnected) {
      openFolder(`Projects/${project.path}`);
    } else {
      Alert.alert(
        t('creator.location_title'),
        t('creator.location_msg', { path: project.path }),
        [{ text: 'OK' }]
      );
    }
  }, [termuxConnected, openFolder, touchProject]);

  const handleHistoryClone = useCallback((project: CreatorProject) => {
    cloneProject(project.id);
    setActiveTab('create');
  }, [cloneProject]);

  const handleHistoryImprove = useCallback((project: CreatorProject) => {
    startPlanning(`${project.userInput} — improved version`);
    setActiveTab('create');
  }, [startPlanning]);

  const handleHistoryDelete = useCallback((project: CreatorProject) => {
    deleteProject(project.id);
  }, [deleteProject]);

  // ── Render ──────────────────────────────────────────────────────────────────

  const isInputDisabled =
    sessionStatus !== 'idle' && sessionStatus !== 'error';

  return (
    <ScreenContainer edges={['top', 'left', 'right']} containerClassName="bg-[#0D0D0D]">
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>creator</Text>
          <Text style={styles.headerVersion}>v2.3</Text>
          {termuxConnected && (
            <View style={styles.termuxBadge}>
              <Text style={styles.termuxBadgeText}>TERMUX</Text>
            </View>
          )}
        </View>
        <Text style={styles.headerTagline}>{t('creator.tagline')}</Text>
      </View>

      {/* Tab bar */}
      <View style={styles.tabBar}>
        <Pressable
          style={[styles.tab, activeTab === 'create' && styles.tabActive]}
          onPress={() => setActiveTab('create')}
        >
          <Text style={[styles.tabText, activeTab === 'create' && styles.tabTextActive]}>
            ✦ Create
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tab, activeTab === 'history' && styles.tabActive]}
          onPress={() => setActiveTab('history')}
        >
          <Text style={[styles.tabText, activeTab === 'history' && styles.tabTextActive]}>
            📂 History {projects.length > 0 ? `(${projects.length})` : ''}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tab, activeTab === 'tools' && styles.tabActive]}
          onPress={() => setActiveTab('tools')}
        >
          <Text style={[styles.tabText, activeTab === 'tools' && styles.tabTextActive]}>
            ⚡ Tools{termuxConnected ? ' ●' : ''}
          </Text>
        </Pressable>
      </View>

      {/* Content */}
      {activeTab === 'create' ? (
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: insets.bottom + 16 },
          ]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Lane 1: Command */}
          <CommandLane
            onSubmit={handleSubmit}
            isDisabled={isInputDisabled}
          />

          {/* Lane 2: Plan */}
          <PlanLane
            status={sessionStatus}
            plan={currentProject?.plan ?? null}
            onConfirm={handleConfirm}
            onCancel={handleCancel}
          />

          {/* Lane 3: Build */}
          <BuildLane
            status={sessionStatus}
            steps={currentProject?.buildSteps ?? []}
          />

          {/* Lane 4: Result */}
          <ResultLane
            status={sessionStatus}
            project={currentProject}
            completionMessage={getCompletionMessage()}
            onSaveRecipe={handleSaveRecipe}
            onNewProject={handleNewProject}
            onRunInTerminal={handleRunInTerminal}
            onOpenFolder={handleOpenFolder}
            recipeSaved={recipeSaved}
            termuxConnected={termuxConnected}
          />
        </ScrollView>
      ) : activeTab === 'tools' ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 16 }]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <ToolsLane
            lastProject={projects[0] ?? null}
            projects={projects}
            termuxConnected={termuxConnected}
            onRunCommand={(cmd, opts) => termuxRunCommand(cmd, opts)}
            onCancel={termuxCancelCurrent}
            onSendToTerminal={(cmd) => {
              insertCommand(cmd);
              Alert.alert(t('creator.sent_title'), t('creator.sent_message'), [{ text: 'OK' }]);
            }}
            onTestConnection={termuxTestConnection}
            localLlmConfig={{
              baseUrl: settings.localLlmUrl,
              model: settings.localLlmModel,
              enabled: settings.localLlmEnabled,
            }}
          />
        </ScrollView>
      ) : (
        <View style={[styles.historyContainer, { paddingBottom: insets.bottom + 16 }]}>
          <ProjectHistoryLane
            projects={projects}
            onOpen={handleHistoryOpen}
            onClone={handleHistoryClone}
            onImprove={handleHistoryImprove}
            onDelete={handleHistoryDelete}
            onUpdateTags={(id, tags) => updateProjectTags(id, tags)}
            onExport={handleExportProjects}
            onImport={handleImportProjects}
          />
          <ImportProjectsModal
            visible={importModalVisible}
            onClose={() => setImportModalVisible(false)}
          />
        </View>
      )}
    </ScreenContainer>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
    backgroundColor: '#0D0D0D',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerTitle: {
    fontSize: 16,
    fontFamily: 'monospace',
    fontWeight: '700',
    color: '#00D4AA',
    letterSpacing: -0.5,
  },
  headerVersion: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: '#4B5563',
    backgroundColor: '#161616',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: '#272727',
  },
  termuxBadge: {
    backgroundColor: '#052E16',
    borderWidth: 1,
    borderColor: '#166534',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
  },
  termuxBadgeText: {
    fontSize: 9,
    fontFamily: 'monospace',
    color: '#4ADE80',
    fontWeight: '700',
  },
  headerTagline: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: '#374151',
  },
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
    backgroundColor: '#0D0D0D',
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: '#00D4AA',
  },
  tabText: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: '#4B5563',
  },
  tabTextActive: {
    color: '#00D4AA',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  historyContainer: {
    flex: 1,
  },
});
