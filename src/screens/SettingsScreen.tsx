import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '../components/Button';
import { Header } from '../components/Header';
import { DicomwebClient } from '../lib/dicomClient';
import type { ServerConfig } from '../lib/settings';
import { colors, space, type } from '../theme';

interface Props {
  config: ServerConfig;
  onSave: (cfg: ServerConfig) => Promise<void>;
  onBack: () => void;
}

export function SettingsScreen({ config, onSave, onBack }: Props) {
  const [draft, setDraft] = useState(config);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof ServerConfig) => (value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setStatus(null);
  };

  const test = async () => {
    setBusy(true);
    try {
      await new DicomwebClient(draft).ping();
      setStatus({ ok: true, text: 'Connected. The server answered a study search.' });
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await onSave(draft);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Header title="Server" subtitle="DICOMweb connection" backLabel="Back" onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Field label="DICOMweb address">
          <TextInput
            style={styles.input}
            value={draft.baseUrl}
            onChangeText={set('baseUrl')}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="http://192.168.1.20:8042/dicom-web"
            placeholderTextColor={colors.muted}
          />
        </Field>
        <Text style={styles.hint}>
          Use your computer's network address, not localhost. On the Android emulator, 10.0.2.2 reaches the host machine.
        </Text>
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
        {status ? <Text style={status.ok ? styles.ok : styles.err}>{status.text}</Text> : null}
        <View style={styles.actions}>
          <Button label="Test connection" onPress={test} disabled={busy} />
          <Button label="Save" primary onPress={save} disabled={busy} />
        </View>
        <Text style={styles.hint}>Credentials are kept in the device keychain. Patient data is never stored on the device.</Text>
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
  hint: { color: colors.muted, fontSize: type.small, lineHeight: 18 },
  ok: { color: colors.accent, fontSize: type.body },
  err: { color: colors.danger, fontSize: type.body },
  actions: { flexDirection: 'row', gap: space(2), justifyContent: 'flex-end' },
});
