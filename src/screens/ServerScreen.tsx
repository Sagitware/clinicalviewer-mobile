import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '../components/Button';
import { Header } from '../components/Header';
import { serverAddress, serverProblem, type ServerConfig, type ServerProtocol } from '../lib/settings';
import { createStudyServer } from '../lib/studyServer';
import { colors, space, type } from '../theme';

interface Props {
  server: ServerConfig;
  isNew: boolean;
  onSave: (server: ServerConfig) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onBack: () => void;
}

type TextKey = 'name' | 'baseUrl' | 'username' | 'password' | 'host' | 'calledAe' | 'callingAe';

const PROTOCOLS: { id: ServerProtocol; label: string }[] = [
  { id: 'dicomweb', label: 'DICOMweb' },
  { id: 'dimse', label: 'DICOM (DIMSE)' },
];

export function ServerScreen({ server, isNew, onSave, onDelete, onBack }: Props) {
  const [draft, setDraft] = useState(server);
  const [portText, setPortText] = useState(String(server.port));
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const current: ServerConfig = {
    ...draft,
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    host: draft.host.trim(),
    port: Number(portText),
    calledAe: draft.calledAe.trim(),
    callingAe: draft.callingAe.trim(),
  };
  const problem = serverProblem(current);
  const dimse = draft.protocol === 'dimse';

  const set = (key: TextKey) => (value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setStatus(null);
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const test = () =>
    run(async () => {
      await createStudyServer(current).ping();
      setStatus({ ok: true, text: dimse ? 'Connected. The server answered a C-ECHO.' : 'Connected. The server answered a study search.' });
    });

  const save = () => run(() => onSave(current));

  const remove = () =>
    Alert.alert('Delete this server?', `${current.name || serverAddress(current)} and its saved settings will be removed from this device.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => run(() => onDelete(draft.id)) },
    ]);

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Header title={isNew ? 'Add server' : 'Edit server'} subtitle={dimse ? 'Traditional DICOM' : 'DICOMweb connection'} backLabel="Back" onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Field label="Connection type">
          <View style={styles.segments} accessibilityRole="radiogroup">
            {PROTOCOLS.map((p) => {
              const active = draft.protocol === p.id;
              return (
                <Pressable
                  key={p.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  onPress={() => {
                    setDraft((d) => ({ ...d, protocol: p.id }));
                    setStatus(null);
                  }}
                  style={[styles.segment, active && styles.segmentActive]}
                >
                  <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{p.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </Field>
        <Field label="Name">
          <TextInput
            style={styles.input}
            value={draft.name}
            onChangeText={set('name')}
            autoCorrect={false}
            placeholder={serverAddress(current) || 'For example: Hospital PACS'}
            placeholderTextColor={colors.muted}
          />
        </Field>

        {dimse ? (
          <>
            <View style={styles.row}>
              <View style={styles.grow}>
                <Field label="Host">
                  <TextInput
                    style={styles.input}
                    value={draft.host}
                    onChangeText={set('host')}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    placeholder="192.168.1.20 or pacs.example.org"
                    placeholderTextColor={colors.muted}
                  />
                </Field>
              </View>
              <View style={styles.port}>
                <Field label="Port">
                  <TextInput
                    style={styles.input}
                    value={portText}
                    onChangeText={(v) => {
                      setPortText(v.replace(/[^0-9]/g, ''));
                      setStatus(null);
                    }}
                    keyboardType="number-pad"
                    placeholder="104"
                    placeholderTextColor={colors.muted}
                  />
                </Field>
              </View>
            </View>
            <Field label="Server AE title">
              <TextInput
                style={styles.input}
                value={draft.calledAe}
                onChangeText={set('calledAe')}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={16}
                placeholder="For example: ORTHANC"
                placeholderTextColor={colors.muted}
              />
            </Field>
            <Field label="This device’s AE title">
              <TextInput
                style={styles.input}
                value={draft.callingAe}
                onChangeText={set('callingAe')}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={16}
                placeholderTextColor={colors.muted}
              />
            </Field>
            <Text style={styles.hint}>
              Add this device&apos;s AE title on the PACS and allow it to query (C-FIND) and retrieve (C-GET). Images are
              requested uncompressed, so the PACS must be able to transcode compressed studies.
            </Text>
          </>
        ) : (
          <>
            <Field label="DICOMweb address">
              <TextInput
                style={styles.input}
                value={draft.baseUrl}
                onChangeText={set('baseUrl')}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="https://pacs.example.org/dicom-web"
                placeholderTextColor={colors.muted}
              />
            </Field>
            <Field label="Username">
              <TextInput
                style={styles.input}
                value={draft.username}
                onChangeText={set('username')}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Leave empty if the server is open"
                placeholderTextColor={colors.muted}
              />
            </Field>
            <Field label="Password">
              <TextInput
                style={styles.input}
                value={draft.password}
                onChangeText={set('password')}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            </Field>
          </>
        )}
        <Text style={styles.hint}>
          On a local network, use the computer&apos;s network address, not localhost. On the Android emulator, 10.0.2.2 reaches the host machine.
        </Text>

        {status ? <Text style={status.ok ? styles.ok : styles.err}>{status.text}</Text> : null}
        <View style={styles.actions}>
          <Button label="Test connection" onPress={test} disabled={busy || problem != null} />
          <Button label="Save" primary onPress={save} disabled={busy || problem != null} />
        </View>
        <Text style={styles.hint}>Settings are kept in the device keychain.</Text>
        {!isNew ? (
          <View style={styles.danger}>
            <Button label="Delete server" onPress={remove} disabled={busy} />
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  body: { padding: space(4), gap: space(3) },
  field: { gap: space(1.5) },
  label: { color: colors.muted, fontSize: type.small },
  input: {
    paddingHorizontal: space(3),
    paddingVertical: space(2.5),
    borderRadius: 8,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line,
    color: colors.text,
    fontSize: type.body,
  },
  segments: {
    flexDirection: 'row',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: 'hidden',
  },
  segment: { flex: 1, paddingVertical: space(2.5), alignItems: 'center', backgroundColor: colors.panel },
  segmentActive: { backgroundColor: colors.raised },
  segmentText: { color: colors.muted, fontSize: type.body },
  segmentTextActive: { color: colors.accent, fontWeight: '600' },
  row: { flexDirection: 'row', gap: space(3) },
  grow: { flex: 1 },
  port: { width: 96 },
  hint: { color: colors.muted, fontSize: type.small, lineHeight: 18 },
  ok: { color: colors.accent, fontSize: type.body },
  err: { color: colors.danger, fontSize: type.body },
  actions: { flexDirection: 'row', gap: space(2), justifyContent: 'flex-end' },
  danger: { marginTop: space(6), alignItems: 'flex-start' },
});
