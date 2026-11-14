import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '../components/Button';
import { Header } from '../components/Header';
import { downloadAll, formatBytes, LIMITS, planImport } from '../lib/cloud/importer';
import { AuthExpiredError, SignInCancelled, type CloudEntry, type CloudProvider } from '../lib/cloud/types';
import { importBytes, type LocalImportResult } from '../lib/sources';
import { colors, space, type } from '../theme';

type Phase =
  | { name: 'idle' }
  | { name: 'scanning'; folders: number; files: number }
  | { name: 'downloading'; done: number; total: number }
  | { name: 'reading' };

interface Props {
  provider: CloudProvider;
  onBack: () => void;
  onImported: (result: LocalImportResult, label: string) => void;
}

export function CloudBrowserScreen({ provider, onBack, onImported }: Props) {
  const insets = useSafeAreaInsets();
  const [signedIn, setSignedIn] = useState(provider.account() != null);
  const [checking, setChecking] = useState(!signedIn);
  const [path, setPath] = useState<CloudEntry[]>([]);
  const [entries, setEntries] = useState<CloudEntry[] | null>(null);
  const [selected, setSelected] = useState<Map<string, CloudEntry>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const cancel = useRef<{ scan: { cancelled: boolean }; download: AbortController } | null>(null);
  const folder = path[path.length - 1] ?? null;

  useEffect(() => {
    if (signedIn) return;
    provider
      .restore()
      .then(setSignedIn)
      .catch(() => setSignedIn(false))
      .finally(() => setChecking(false));
  }, [provider, signedIn]);

  useEffect(() => () => cancelImport(), []);

  const signedOut = useCallback(() => {
    setSignedIn(false);
    setEntries(null);
  }, []);

  const handleError = useCallback(
    (e: unknown) => {
      if (e instanceof AuthExpiredError) signedOut();
      if (!(e instanceof SignInCancelled)) setError(e instanceof Error ? e.message : String(e));
    },
    [signedOut],
  );

  /** Changes folder; the listing effect below loads the new one. */
  const navigate = (update: (p: CloudEntry[]) => CloudEntry[]) => {
    setEntries(null);
    setError(null);
    setPath(update);
  };

  useEffect(() => {
    if (!signedIn) return;
    let stale = false;
    provider
      .list(folder)
      .then((r) => !stale && setEntries(r))
      .catch((e: unknown) => !stale && handleError(e));
    return () => {
      stale = true;
    };
  }, [provider, folder, signedIn, handleError]);

  const signIn = async () => {
    setError(null);
    try {
      await provider.signIn();
      setSignedIn(true);
    } catch (e) {
      handleError(e);
    }
  };

  const toggle = (e: CloudEntry) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(e.id)) next.delete(e.id);
      else next.set(e.id, e);
      return next;
    });

  function cancelImport() {
    if (!cancel.current) return;
    cancel.current.scan.cancelled = true;
    cancel.current.download.abort();
    cancel.current = null;
  }

  const confirm = (title: string, message: string) =>
    new Promise<boolean>((resolve) =>
      Alert.alert(title, message, [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Download', onPress: () => resolve(true) },
      ]),
    );

  const startImport = async () => {
    const selection = selected.size > 0 ? [...selected.values()] : folder ? [folder] : [];
    if (selection.length === 0) return;
    const label = selected.size > 0 ? `${selected.size} item${selected.size === 1 ? '' : 's'}` : (folder?.name ?? provider.label);
    const ctl = { scan: { cancelled: false }, download: new AbortController() };
    cancel.current = ctl;
    setError(null);
    try {
      setPhase({ name: 'scanning', folders: 0, files: 0 });
      const plan = await planImport(provider, selection, (folders, files) => setPhase({ name: 'scanning', folders, files }), ctl.scan);
      if (ctl.scan.cancelled) return;
      if (plan.files.length === 0) {
        setError('No files that could be DICOM were found here.');
        return;
      }
      if (plan.bytes > LIMITS.bytes) {
        setError(`That is ${formatBytes(plan.bytes)}, more than this device can hold in memory. Pick a single series folder.`);
        return;
      }
      const ok = await confirm(
        `Download ${plan.files.length} file${plan.files.length === 1 ? '' : 's'}?`,
        `About ${formatBytes(plan.bytes)}.${plan.truncated ? ` Only the first ${LIMITS.files} files will be imported.` : ''}`,
      );
      if (!ok) return;

      setPhase({ name: 'downloading', done: 0, total: plan.files.length });
      const { items, failed } = await downloadAll(
        provider,
        plan.files,
        (done, total) => setPhase({ name: 'downloading', done, total }),
        ctl.download,
      );
      if (ctl.download.signal.aborted) return;
      setPhase({ name: 'reading' });
      // Let the "Reading" state paint before the synchronous parse.
      await new Promise((r) => setTimeout(r, 30));
      const result = importBytes(items, failed);
      setSelected(new Map());
      onImported(result, label);
    } catch (e) {
      if (!ctl.download.signal.aborted && !ctl.scan.cancelled) handleError(e);
    } finally {
      if (cancel.current === ctl) cancel.current = null;
      setPhase({ name: 'idle' });
    }
  };

  const subtitle = signedIn ? ['Home', ...path.map((p) => p.name)].join(' / ') : 'Not signed in';
  const busy = phase.name !== 'idle';

  if (!signedIn) {
    return (
      <View style={styles.screen}>
        <Header title={provider.label} subtitle={subtitle} backLabel="Import" onBack={onBack} />
        <View style={styles.center}>
          {checking ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <>
              <Text style={styles.centerTitle}>Connect {provider.label}</Text>
              <Text style={styles.centerText}>Read-only access. fig-dicom can browse and download, never change or delete.</Text>
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Button label={`Sign in to ${provider.label}`} primary onPress={signIn} />
            </>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Header
        title={folder?.name ?? provider.label}
        subtitle={subtitle}
        backLabel={path.length ? 'Up' : 'Import'}
        onBack={() => (path.length ? navigate((p) => p.slice(0, -1)) : onBack())}
        right={<Button label="Sign out" onPress={() => provider.signOut().then(() => { signedOut(); setPath([]); })} />}
      />
      {error ? <Text style={[styles.error, styles.errorBanner]}>{error}</Text> : null}
      {!entries && !error ? <ActivityIndicator style={styles.spinner} color={colors.accent} /> : null}
      <FlatList
        data={entries ?? []}
        keyExtractor={(e) => e.id}
        ItemSeparatorComponent={Separator}
        ListEmptyComponent={entries ? <Text style={styles.empty}>This folder is empty.</Text> : undefined}
        renderItem={({ item }) => {
          const isSelected = selected.has(item.id);
          return (
            <View style={styles.row}>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: isSelected }}
                accessibilityLabel={`Select ${item.name}`}
                hitSlop={10}
                onPress={() => toggle(item)}
                style={[styles.check, isSelected && styles.checkOn]}
              >
                {isSelected ? <Text style={styles.checkMark}>✓</Text> : null}
              </Pressable>
              <Pressable
                style={styles.rowMain}
                onPress={() => (item.kind === 'folder' ? navigate((p) => [...p, item]) : toggle(item))}
              >
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.detail}>{item.kind === 'folder' ? 'Folder' : item.size != null ? formatBytes(item.size) : 'File'}</Text>
              </Pressable>
              {item.kind === 'folder' ? <Text style={styles.chev}>›</Text> : null}
            </View>
          );
        }}
      />
      <View style={[styles.footer, { paddingBottom: insets.bottom + space(3) }]}>
        {busy ? (
          <>
            <View style={styles.progressText}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.footerText}>
                {phase.name === 'scanning'
                  ? `Looking through folders: ${phase.files} files found`
                  : phase.name === 'downloading'
                    ? `Downloading ${phase.done} of ${phase.total}`
                    : 'Reading images'}
              </Text>
            </View>
            {phase.name !== 'reading' ? <Button label="Stop" onPress={cancelImport} /> : null}
          </>
        ) : (
          <>
            <Text style={styles.footerText}>
              {selected.size > 0
                ? `${selected.size} selected`
                : folder
                  ? 'Folders include their subfolders'
                  : 'Open a folder, or tick the items to import'}
            </Text>
            <Button
              label={selected.size > 0 ? 'Import selected' : 'Import this folder'}
              primary
              disabled={!entries || entries.length === 0 || (!folder && selected.size === 0)}
              onPress={startImport}
            />
          </>
        )}
      </View>
    </View>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(8), gap: space(3) },
  centerTitle: { color: colors.text, fontSize: type.title, fontWeight: '600' },
  centerText: { color: colors.muted, fontSize: type.body, textAlign: 'center', lineHeight: 21 },
  error: { color: colors.danger, fontSize: type.body },
  errorBanner: { padding: space(4), paddingBottom: 0 },
  spinner: { marginTop: space(10) },
  empty: { color: colors.muted, fontSize: type.body, padding: space(8), textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingHorizontal: space(4), paddingVertical: space(3) },
  check: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkMark: { color: colors.ink, fontSize: type.small, fontWeight: '700' },
  rowMain: { flex: 1, gap: 2 },
  name: { color: colors.text, fontSize: type.body },
  detail: { color: colors.muted, fontSize: type.small },
  chev: { color: colors.muted, fontSize: type.heading },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: space(13) },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space(3),
    paddingHorizontal: space(4),
    paddingTop: space(3),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: colors.ink,
  },
  progressText: { flexDirection: 'row', alignItems: 'center', gap: space(2), flex: 1 },
  footerText: { color: colors.muted, fontSize: type.small, flexShrink: 1 },
});
