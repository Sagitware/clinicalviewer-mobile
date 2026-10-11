import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Button } from '../components/Button';
import { Header } from '../components/Header';
import {
  getScpState,
  loadScpConfig,
  saveScpConfig,
  startScp,
  stopScp,
  subscribeScp,
  type ScpConfig,
  type ScpState,
} from '../lib/dicomScp';
import { colors, space, type } from '../theme';

interface Props {
  onBack: () => void;
  onOpenLibrary: () => void;
}

export function ReceiveScreen({ onBack, onOpenLibrary }: Props) {
  const [state, setState] = useState<ScpState>(getScpState());
  const [config, setConfig] = useState<ScpConfig | null>(null);
  const [port, setPort] = useState('11112');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    loadScpConfig().then((c) => {
      setConfig(c);
      setPort(String(c.port));
    });
    return subscribeScp(setState);
  }, []);

  const parsedPort = Number(port);
  const portValid = Number.isInteger(parsedPort) && parsedPort >= 1024 && parsedPort <= 65535;

  const toggle = async () => {
    if (!config) return;
    setFormError(null);
    if (state.running) {
      stopScp();
      return;
    }
    if (!portValid) {
      setFormError('Enter a port between 1024 and 65535.');
      return;
    }
    setBusy(true);
    try {
      const next = { ...config, port: parsedPort };
      setConfig(next);
      await saveScpConfig(next);
      await startScp(parsedPort);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setAutoStart = (autoStart: boolean) => {
    if (!config) return;
    const next = { ...config, autoStart, port: portValid ? parsedPort : config.port };
    setConfig(next);
    saveScpConfig(next).catch(() => undefined);
  };

  const target = state.running ? `${state.address ?? '<device address>'}:${state.port}` : null;

  return (
    <View style={styles.screen}>
      <Header title="Receive" subtitle="DICOM Storage (C-STORE)" backLabel="Back" onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.field}>
          <Text style={styles.label}>Port</Text>
          <TextInput
            style={styles.input}
            value={port}
            onChangeText={setPort}
            keyboardType="number-pad"
            editable={!state.running}
            placeholder="11112"
            placeholderTextColor={colors.muted}
          />
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Start automatically when the app opens</Text>
          <Switch value={config?.autoStart ?? false} onValueChange={setAutoStart} disabled={!config} />
        </View>
        <Text style={state.running ? styles.ok : styles.hint}>
          {state.running ? `Listening on ${target}` : 'Not listening'}
        </Text>
        {formError || state.error ? <Text style={styles.err}>{formError ?? state.error}</Text> : null}
        <View style={styles.actions}>
          <Button label="Local studies" onPress={onOpenLibrary} />
          <Button label={state.running ? 'Stop' : 'Start'} primary onPress={toggle} disabled={busy || !config} />
        </View>
        {state.running ? (
          <Text style={styles.hint}>
            {state.received} image{state.received === 1 ? '' : 's'} received
            {state.lastFrom ? ` (last from ${state.lastFrom})` : ''}. {state.activeAssociations} active connection
            {state.activeAssociations === 1 ? '' : 's'}.
          </Text>
        ) : null}
        <Text style={styles.hint}>
          Point your sender (PACS, modality, or a tool such as storescu) at this address. Any AE title is accepted, so use any
          Called AE. For example: storescu {state.address ?? '<device address>'} {port} -aec CLINICALVIEW series-folder
        </Text>
        <Text style={styles.hint}>
          Uncompressed images (Implicit or Explicit VR Little Endian) are stored in Local studies. The phone and the sender must be
          on the same network, and the app must stay open: iOS and Android suspend listening in the background. There is no
          authentication or encryption, so use it on trusted networks only.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  body: { padding: space(4), gap: space(3) },
  field: { gap: space(1.5) },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space(3) },
  label: { color: colors.muted, fontSize: type.small, flexShrink: 1 },
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
