/**
 * PackageManager.tsx — GUI wrapper for Termux pkg commands
 *
 * Shows installed/available/upgradable packages with search,
 * category browsing, and one-tap install/remove/upgrade.
 */
import React, { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  Pressable,
  Modal,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from '@/lib/i18n';
import {
  usePackageStore,
  PACKAGE_CATEGORIES,
  type PackageInfo,
  type PackageFilter,
} from '@/lib/package-manager';

const ACCENT = '#00D4AA';

const FILTER_TABS: { key: PackageFilter; labelKey: string }[] = [
  { key: 'installed', labelKey: 'pkg.installed' },
  { key: 'all', labelKey: 'pkg.available' },
  { key: 'upgradable', labelKey: 'pkg.upgradable' },
];

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Run a command in Termux */
  onRunCommand: (command: string) => void;
  isConnected: boolean;
};

export function PackageManager({ visible, onClose, onRunCommand, isConnected }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const {
    filter,
    searchQuery,
    isLoading,
    activeOp,
    setFilter,
    setSearch,
    getFiltered,
  } = usePackageStore();

  const filtered = useMemo(() => getFiltered(), [getFiltered, filter, searchQuery]);

  const handleInstall = useCallback(
    (pkg: PackageInfo) => {
      onRunCommand(`pkg install -y ${pkg.name}`);
    },
    [onRunCommand],
  );

  const handleRemove = useCallback(
    (pkg: PackageInfo) => {
      onRunCommand(`pkg uninstall -y ${pkg.name}`);
    },
    [onRunCommand],
  );

  const handleUpgrade = useCallback(
    (pkg: PackageInfo) => {
      onRunCommand(`pkg upgrade -y ${pkg.name}`);
    },
    [onRunCommand],
  );

  const handleUpgradeAll = useCallback(() => {
    onRunCommand('pkg upgrade -y');
  }, [onRunCommand]);

  const handleRefresh = useCallback(() => {
    onRunCommand('pkg update -y && dpkg-query -W -f \'${Package}\\t${Version}\\t${Description}\\n\'');
  }, [onRunCommand]);

  const handleCategoryPress = useCallback(
    (pkgName: string) => {
      setSearch(pkgName);
    },
    [setSearch],
  );

  const renderPackage = useCallback(
    ({ item }: { item: PackageInfo }) => (
      <View style={styles.pkgCard}>
        <View style={styles.pkgInfo}>
          <View style={styles.pkgNameRow}>
            <Text style={styles.pkgName}>{item.name}</Text>
            {item.installed && (
              <View style={styles.installedBadge}>
                <Text style={styles.installedBadgeText}>installed</Text>
              </View>
            )}
            {item.upgradable && (
              <View style={styles.upgradeBadge}>
                <Text style={styles.upgradeBadgeText}>update</Text>
              </View>
            )}
          </View>
          <Text style={styles.pkgVersion}>{item.version}</Text>
          {item.description ? (
            <Text style={styles.pkgDesc} numberOfLines={2}>
              {item.description}
            </Text>
          ) : null}
        </View>

        <View style={styles.pkgActions}>
          {item.upgradable && (
            <Pressable
              style={[styles.actionChip, styles.upgradeChip]}
              onPress={() => handleUpgrade(item)}
            >
              <MaterialIcons name="arrow-upward" size={14} color="#FBBF24" />
            </Pressable>
          )}
          {item.installed ? (
            <Pressable
              style={[styles.actionChip, styles.removeChip]}
              onPress={() => handleRemove(item)}
            >
              <MaterialIcons name="delete-outline" size={14} color="#F87171" />
            </Pressable>
          ) : (
            <Pressable
              style={[styles.actionChip, styles.installChip]}
              onPress={() => handleInstall(item)}
            >
              <MaterialIcons name="add" size={14} color={ACCENT} />
              <Text style={styles.installText}>{t('pkg.install')}</Text>
            </Pressable>
          )}
        </View>
      </View>
    ),
    [handleInstall, handleRemove, handleUpgrade, t],
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={styles.header}>
          <MaterialIcons name="inventory-2" size={20} color={ACCENT} />
          <Text style={styles.headerTitle}>{t('pkg.title')}</Text>
          <View style={styles.headerActions}>
            <Pressable style={styles.headerBtn} onPress={handleRefresh}>
              <MaterialIcons name="refresh" size={18} color="#6B7280" />
            </Pressable>
            {filter === 'upgradable' && (
              <Pressable style={styles.upgradeAllBtn} onPress={handleUpgradeAll}>
                <Text style={styles.upgradeAllText}>{t('pkg.upgrade_all')}</Text>
              </Pressable>
            )}
            <Pressable style={styles.headerBtn} onPress={onClose}>
              <MaterialIcons name="close" size={18} color="#6B7280" />
            </Pressable>
          </View>
        </View>

        {/* Not connected warning */}
        {!isConnected && (
          <View style={styles.warningBar}>
            <MaterialIcons name="warning" size={14} color="#FBBF24" />
            <Text style={styles.warningText}>{t('pkg.connect_first')}</Text>
          </View>
        )}

        {/* Search */}
        <View style={styles.searchRow}>
          <MaterialIcons name="search" size={18} color="#4B5563" />
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearch}
            placeholder={t('pkg.search')}
            placeholderTextColor="#4B5563"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {searchQuery.length > 0 && (
            <Pressable onPress={() => setSearch('')}>
              <MaterialIcons name="close" size={16} color="#4B5563" />
            </Pressable>
          )}
        </View>

        {/* Filter tabs */}
        <View style={styles.filterRow}>
          {FILTER_TABS.map((tab) => (
            <Pressable
              key={tab.key}
              style={[styles.filterTab, filter === tab.key && styles.filterTabActive]}
              onPress={() => setFilter(tab.key)}
            >
              <Text
                style={[
                  styles.filterTabText,
                  filter === tab.key && styles.filterTabTextActive,
                ]}
              >
                {t(tab.labelKey)}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Category chips (when on 'all' filter) */}
        {filter === 'all' && !searchQuery && (
          <View style={styles.categoriesRow}>
            {PACKAGE_CATEGORIES.map((cat) => (
              <Pressable
                key={cat.name}
                style={styles.categoryChip}
                onPress={() => handleCategoryPress(cat.packages[0])}
              >
                <MaterialIcons name={cat.icon as any} size={14} color="#9BA1A6" />
                <Text style={styles.categoryText}>{cat.name}</Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* Active operation */}
        {activeOp && (
          <View style={styles.opBar}>
            <ActivityIndicator size="small" color={ACCENT} />
            <Text style={styles.opText}>
              {activeOp.action} {activeOp.name}...
            </Text>
          </View>
        )}

        {/* Package list */}
        {isLoading ? (
          <View style={styles.centerBox}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        ) : filtered.length === 0 ? (
          <View style={styles.centerBox}>
            <MaterialIcons name="inventory" size={40} color="#333" />
            <Text style={styles.emptyText}>{t('pkg.no_packages')}</Text>
          </View>
        ) : (
          <FlatList
            data={filtered}
            renderItem={renderPackage}
            keyExtractor={(item) => item.name}
            contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 16 }]}
            keyboardShouldPersistTaps="handled"
            removeClippedSubviews
            maxToRenderPerBatch={15}
            windowSize={10}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1E1E1E',
    gap: 8,
  },
  headerTitle: {
    color: '#ECEDEE',
    fontSize: 16,
    fontWeight: '700',
    fontFamily: 'monospace',
    flex: 1,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerBtn: {
    padding: 6,
    borderRadius: 6,
    backgroundColor: '#1A1A1A',
  },
  upgradeAllBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: '#FBBF2420',
    borderWidth: 1,
    borderColor: '#FBBF2440',
  },
  upgradeAllText: {
    color: '#FBBF24',
    fontSize: 11,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  warningBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#FBBF2415',
    borderBottomWidth: 1,
    borderBottomColor: '#FBBF2430',
  },
  warningText: {
    color: '#FBBF24',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  searchInput: {
    flex: 1,
    color: '#ECEDEE',
    fontSize: 14,
    fontFamily: 'monospace',
    paddingVertical: 4,
  },
  filterRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  filterTab: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2D2D2D',
    backgroundColor: '#111',
  },
  filterTabActive: {
    borderColor: ACCENT,
    backgroundColor: ACCENT + '18',
  },
  filterTabText: {
    color: '#6B7280',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  filterTabTextActive: {
    color: ACCENT,
    fontWeight: '600',
  },
  categoriesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  categoryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#1A1A1A',
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  categoryText: {
    color: '#9BA1A6',
    fontSize: 10,
    fontFamily: 'monospace',
  },
  opBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: ACCENT + '10',
    borderBottomWidth: 1,
    borderBottomColor: ACCENT + '30',
  },
  opText: {
    color: ACCENT,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  centerBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  emptyText: {
    color: '#4B5563',
    fontSize: 13,
    fontFamily: 'monospace',
  },
  listContent: {
    paddingHorizontal: 10,
    paddingTop: 6,
  },
  pkgCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#141414',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1E1E1E',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 4,
  },
  pkgInfo: {
    flex: 1,
    gap: 2,
  },
  pkgNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  pkgName: {
    color: '#ECEDEE',
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  installedBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    backgroundColor: ACCENT + '20',
    borderWidth: 1,
    borderColor: ACCENT + '40',
  },
  installedBadgeText: {
    color: ACCENT,
    fontSize: 8,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  upgradeBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    backgroundColor: '#FBBF2420',
    borderWidth: 1,
    borderColor: '#FBBF2440',
  },
  upgradeBadgeText: {
    color: '#FBBF24',
    fontSize: 8,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  pkgVersion: {
    color: '#4B5563',
    fontSize: 10,
    fontFamily: 'monospace',
  },
  pkgDesc: {
    color: '#6B7280',
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 16,
  },
  pkgActions: {
    flexDirection: 'row',
    gap: 6,
    marginLeft: 8,
  },
  actionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
  },
  installChip: {
    backgroundColor: ACCENT + '15',
    borderColor: ACCENT + '40',
  },
  installText: {
    color: ACCENT,
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  removeChip: {
    backgroundColor: '#F8717115',
    borderColor: '#F8717140',
  },
  upgradeChip: {
    backgroundColor: '#FBBF2415',
    borderColor: '#FBBF2440',
  },
});
