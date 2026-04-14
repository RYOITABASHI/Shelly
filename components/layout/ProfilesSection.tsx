// components/layout/ProfilesSection.tsx
import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Alert,
  StyleSheet,
  TextInput,
  Modal,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/lib/theme-engine';
import { fonts as F } from '@/theme.config';
import { useProfileStore, SSHProfile } from '@/store/profile-store';
import { useTerminalStore } from '@/store/terminal-store';

// ─── Edit/Add modal ─────────────────────────────────────────────────────────

type EditModalProps = {
  visible: boolean;
  initial: Partial<SSHProfile>;
  onSave: (p: SSHProfile) => void;
  onClose: () => void;
};

function EditModal({ visible, initial, onSave, onClose }: EditModalProps) {
  const theme = useTheme();
  const c = theme.colors;
  // Match ModalHeader — keep the BACK affordance clear of the Android
  // status bar on tall/foldable devices (bug #33).
  const insets = useSafeAreaInsets();

  const [name, setName] = useState(initial.name ?? '');
  const [host, setHost] = useState(initial.host ?? '');
  const [port, setPort] = useState(String(initial.port ?? 22));
  const [user, setUser] = useState(initial.user ?? '');
  const [keyFile, setKeyFile] = useState(initial.keyFile ?? '');
  const [jumpHost, setJumpHost] = useState(initial.jumpHost ?? '');

  // Reset fields when modal reopens with new data
  React.useEffect(() => {
    if (visible) {
      setName(initial.name ?? '');
      setHost(initial.host ?? '');
      setPort(String(initial.port ?? 22));
      setUser(initial.user ?? '');
      setKeyFile(initial.keyFile ?? '');
      setJumpHost(initial.jumpHost ?? '');
    }
  }, [visible, initial.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSave() {
    if (!name.trim() || !host.trim()) {
      Alert.alert('Required', 'Name and Host are required.');
      return;
    }
    onSave({
      id: initial.id ?? `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: name.trim(),
      host: host.trim(),
      port: parseInt(port, 10) || 22,
      user: user.trim(),
      keyFile: keyFile.trim() || undefined,
      jumpHost: jumpHost.trim() || undefined,
    });
  }

  const inputStyle = [styles.input, { backgroundColor: c.surface, borderColor: c.border, color: c.foreground }];
  const labelStyle = [styles.label, { color: c.muted }];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalBox, { backgroundColor: c.background, borderColor: c.border }]}>
          {/* Leading BACK affordance for users whose device doesn't have
              an edge-swipe gesture enabled. Matches the ModalHeader used
              by the MCP / llama.cpp wrappers — see issue #11. */}
          <View style={[styles.modalHeaderRow, { paddingTop: insets.top }]}>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              style={styles.modalBackButton}
              accessibilityRole="button"
              accessibilityLabel="Back to profiles"
            >
              <MaterialIcons name="arrow-back" size={16} color={c.accent} />
              <Text style={[styles.modalBackText, { color: c.accent }]}>BACK</Text>
            </Pressable>
            <Text style={[styles.modalTitle, { color: c.foreground, flex: 1, textAlign: 'center' }]} numberOfLines={1}>
              {initial.id ? 'Edit Profile' : 'Add Profile'}
            </Text>
            <View style={styles.modalBackButton} />
          </View>

          <Text style={labelStyle}>Name *</Text>
          <TextInput style={inputStyle} value={name} onChangeText={setName} placeholder="my-server" placeholderTextColor={c.muted} autoCapitalize="none" />

          <Text style={labelStyle}>Host / HostName *</Text>
          <TextInput style={inputStyle} value={host} onChangeText={setHost} placeholder="192.168.1.10" placeholderTextColor={c.muted} autoCapitalize="none" keyboardType="url" />

          <View style={styles.row2}>
            <View style={styles.flex1}>
              <Text style={labelStyle}>Port</Text>
              <TextInput style={inputStyle} value={port} onChangeText={setPort} placeholder="22" placeholderTextColor={c.muted} keyboardType="number-pad" />
            </View>
            <View style={[styles.flex2, { marginLeft: 8 }]}>
              <Text style={labelStyle}>User</Text>
              <TextInput style={inputStyle} value={user} onChangeText={setUser} placeholder="root" placeholderTextColor={c.muted} autoCapitalize="none" />
            </View>
          </View>

          <Text style={labelStyle}>Identity File (optional)</Text>
          <TextInput style={inputStyle} value={keyFile} onChangeText={setKeyFile} placeholder="~/.ssh/id_rsa" placeholderTextColor={c.muted} autoCapitalize="none" />

          <Text style={labelStyle}>Jump Host (optional)</Text>
          <TextInput style={inputStyle} value={jumpHost} onChangeText={setJumpHost} placeholder="bastion.example.com" placeholderTextColor={c.muted} autoCapitalize="none" />

          <View style={styles.modalButtons}>
            <Pressable style={[styles.btn, { borderColor: c.border }]} onPress={onClose}>
              <Text style={{ color: c.muted, fontSize: 13 }}>Cancel</Text>
            </Pressable>
            <Pressable style={[styles.btn, { backgroundColor: c.accent, borderColor: c.accent }]} onPress={handleSave}>
              <Text style={{ color: '#000', fontSize: 13, fontWeight: '700' }}>Save</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── ProfilesSection ─────────────────────────────────────────────────────────

export function ProfilesSection() {
  const theme = useTheme();
  const c = theme.colors;

  const { profiles, removeProfile, addProfile, updateProfile, importFromSSHConfig } =
    useProfileStore();
  const insertCommand = useTerminalStore((s) => s.insertCommand);

  const [editTarget, setEditTarget] = useState<Partial<SSHProfile> | null>(null);
  const [importing, setImporting] = useState(false);

  const handleConnect = useCallback(
    (p: SSHProfile) => {
      const portArg = p.port !== 22 ? ` -p ${p.port}` : '';
      const keyArg = p.keyFile ? ` -i ${p.keyFile}` : '';
      const jumpArg = p.jumpHost ? ` -J ${p.jumpHost}` : '';
      const target = p.user ? `${p.user}@${p.host}` : p.host;
      insertCommand(`ssh${portArg}${keyArg}${jumpArg} ${target}`);
    },
    [insertCommand],
  );

  const handleLongPress = useCallback(
    (p: SSHProfile) => {
      Alert.alert(p.name, p.host, [
        { text: 'Edit', onPress: () => setEditTarget(p) },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            Alert.alert('Delete', `Remove "${p.name}"?`, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete', style: 'destructive', onPress: () => removeProfile(p.id) },
            ]),
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
    },
    [removeProfile],
  );

  const handleImport = useCallback(async () => {
    setImporting(true);
    try {
      const count = await importFromSSHConfig();
      if (count > 0) {
        Alert.alert('Imported', `Added ${count} profile${count > 1 ? 's' : ''} from ~/.ssh/config`);
      } else {
        Alert.alert('No new profiles', 'No new hosts found in ~/.ssh/config');
      }
    } finally {
      setImporting(false);
    }
  }, [importFromSSHConfig]);

  const handleSave = useCallback(
    (p: SSHProfile) => {
      if (editTarget?.id) {
        updateProfile(p.id, p);
      } else {
        addProfile(p);
      }
      setEditTarget(null);
    },
    [editTarget, addProfile, updateProfile],
  );

  return (
    <View>
      {profiles.length === 0 ? (
        <Text style={[styles.emptyText, { color: c.muted }]}>No saved profiles</Text>
      ) : (
        profiles.map((p) => (
          <Pressable
            key={p.id}
            style={({ pressed }) => [
              styles.profileRow,
              pressed && { backgroundColor: c.accent + '15' },
            ]}
            onPress={() => handleConnect(p)}
            onLongPress={() => handleLongPress(p)}
            delayLongPress={400}
          >
            <View style={[styles.profileSquare, { backgroundColor: p.name.toLowerCase().includes('prod') ? '#4ADE80' : '#60A5FA' }]} />
            <View style={styles.profileText}>
              <Text style={[styles.profileName, { color: c.foreground }]} numberOfLines={1}>
                {p.name}
              </Text>
              <Text style={[styles.profileHost, { color: c.muted }]} numberOfLines={1}>
                {p.user ? `${p.user}@${p.host}` : p.host}
                {p.port !== 22 ? `:${p.port}` : ''}
              </Text>
            </View>
          </Pressable>
        ))
      )}

      {/* Action buttons */}
      <Pressable
        style={[styles.actionBtn, { borderColor: c.border }]}
        onPress={handleImport}
        disabled={importing}
      >
        <MaterialIcons name="download" size={12} color={c.muted} />
        <Text style={[styles.actionBtnText, { color: c.muted }]}>
          {importing ? 'Importing…' : 'Import from ~/.ssh/config'}
        </Text>
      </Pressable>

      <Pressable
        style={[styles.actionBtn, { borderColor: c.border }]}
        onPress={() => setEditTarget({})}
      >
        <MaterialIcons name="add" size={12} color={c.accent} />
        <Text style={[styles.actionBtnText, { color: c.accent }]}>Add Profile</Text>
      </Pressable>

      {/* Edit / Add modal */}
      <EditModal
        visible={editTarget !== null}
        initial={editTarget ?? {}}
        onSave={handleSave}
        onClose={() => setEditTarget(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  emptyText: {
    fontFamily: F.family,
    fontSize: 11,
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontStyle: 'italic',
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 4,
    gap: 6,
  },
  profileSquare: {
    width: 12,
    height: 12,
    borderRadius: 2,
  },
  profileIcon: {
    width: 16,
  },
  profileText: {
    flex: 1,
  },
  profileName: {
    fontFamily: F.family,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  profileHost: {
    fontFamily: F.family,
    fontSize: 9,
    marginTop: 1,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginHorizontal: 10,
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  actionBtnText: {
    fontFamily: F.family,
    fontSize: 11,
  },
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalBox: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    paddingBottom: 32,
  },
  modalHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalBackButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    minWidth: 64,
    minHeight: 32,
  },
  modalBackText: {
    fontFamily: F.family,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  modalTitle: {
    fontFamily: F.family,
    fontSize: 16,
    fontWeight: '700',
  },
  label: {
    fontFamily: F.family,
    fontSize: 11,
    marginBottom: 4,
    marginTop: 10,
  },
  input: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontFamily: F.family,
    fontSize: 13,
  },
  row2: {
    flexDirection: 'row',
  },
  flex1: { flex: 1 },
  flex2: { flex: 2 },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 20,
  },
  btn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 9,
  },
});
