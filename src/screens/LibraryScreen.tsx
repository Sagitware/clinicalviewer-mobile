import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button } from '../components/Button';
import { Header } from '../components/Header';
import { MenuButton } from '../components/MenuButton';
import { ModalityBadge } from '../components/ModalityBadge';
import { onScpStored } from '../lib/dicomScp';
import { clearLibrary, deleteStudy, listStudies, type SavedStudy } from '../lib/localDb';
import { colors, space, type } from '../theme';

interface Props {
  onOpenStudy: (study: SavedStudy) => void;
  onOpenServer: () => void;
  onOpenFiles: () => void;
  onSettings: () => void;
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function LibraryScreen({ onOpenStudy, onOpenServer, onOpenFiles, onSettings }: Props) {
  const [studies, setStudies] = useState<SavedStudy[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      listStudies().then(
        (found) => {
          setError(null);
          setStudies(found);
        },
        (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      ),
    [],
  );

  useEffect(() => {
    refresh();
    return onScpStored(() => {
      refresh();
    });
  }, [refresh]);

  const confirm = (title: string, message: string, action: () => Promise<void>) =>
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          action()
            .then(refresh)
            .catch((e) => setError(e instanceof Error ? e.message : String(e)));
        },
      },
    ]);

  const total = studies?.reduce((sum, s) => sum + s.bytes, 0) ?? 0;

  return (
    <View style={styles.screen}>
      <Header
        title="Local studies"
        subtitle={studies ? `${studies.length} stored on this device · ${formatBytes(total)}` : undefined}
        left={
          <MenuButton
            items={[
              { label: 'Import', onPress: onOpenFiles },
              { label: 'Settings', onPress: onSettings },
            ]}
          />
        }
        right={
          <>
            {studies && studies.length > 0 ? (
              <Button
                label="Clear all"
                onPress={() => confirm('Delete all stored studies?', 'This removes every saved image from this device.', clearLibrary)}
              />
            ) : null}
            <Button label="Server" onPress={onOpenServer} />
          </>
        }
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <FlatList
        data={studies ?? []}
        keyExtractor={(s) => s.studyUid}
        ItemSeparatorComponent={Separator}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          studies ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Nothing stored yet</Text>
              <Text style={styles.emptyText}>Files you import are saved here so you can reopen them offline.</Text>
            </View>
          ) : undefined
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => onOpenStudy(item)}
            onLongPress={() =>
              confirm('Delete this study?', `${item.patientName} will be removed from this device.`, () =>
                deleteStudy(item.studyUid),
              )
            }
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <View style={styles.rowMain}>
              <Text style={styles.name} numberOfLines={1}>
                {item.patientName}
              </Text>
              <Text style={styles.detail} numberOfLines={1}>
                {item.description || 'No description'}
              </Text>
              <Text style={styles.meta}>
                {`${item.seriesCount} series · ${item.instanceCount} images · ${formatBytes(item.bytes)}`}
              </Text>
            </View>
            <View style={styles.rowSide}>
              <Text style={styles.meta}>{item.studyDate}</Text>
              <View style={styles.badges}>
                {item.modalities.map((m) => (
                  <ModalityBadge key={m} modality={m} />
                ))}
              </View>
            </View>
          </Pressable>
        )}
      />
      {studies && studies.length > 0 ? <Text style={styles.hint}>Long-press a study to delete it.</Text> : null}
    </View>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  list: { flexGrow: 1 },
  error: { color: colors.danger, fontSize: type.body, padding: space(4) },
  row: { flexDirection: 'row', paddingHorizontal: space(4), paddingVertical: space(3), gap: space(3) },
  rowPressed: { backgroundColor: colors.panel },
  rowMain: { flex: 1, gap: 2 },
  rowSide: { alignItems: 'flex-end', gap: space(1.5) },
  name: { color: colors.text, fontSize: type.title, fontWeight: '600' },
  detail: { color: colors.text, fontSize: type.body, opacity: 0.85 },
  meta: { color: colors.muted, fontSize: type.small },
  badges: { flexDirection: 'row', gap: space(1) },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: space(4) },
  empty: { padding: space(8), alignItems: 'center', gap: space(2) },
  emptyTitle: { color: colors.text, fontSize: type.title, fontWeight: '600' },
  emptyText: { color: colors.muted, fontSize: type.body, textAlign: 'center' },
  hint: { color: colors.muted, fontSize: type.small, textAlign: 'center', padding: space(3) },
});
