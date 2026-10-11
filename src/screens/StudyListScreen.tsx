import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '../components/Button';
import { Header } from '../components/Header';
import { MenuButton } from '../components/MenuButton';
import { ModalityBadge } from '../components/ModalityBadge';
import type { DicomwebClient, StudySummary } from '../lib/dicomClient';
import { colors, space, type } from '../theme';

interface Props {
  client: DicomwebClient;
  onOpenStudy: (study: StudySummary) => void;
  onOpenFiles: () => void;
  onBack: () => void;
  onSettings: () => void;
}

export function StudyListScreen({ client, onOpenStudy, onOpenFiles, onBack, onSettings }: Props) {
  const [query, setQuery] = useState('');
  const [studies, setStudies] = useState<StudySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(
    async (patientName: string) => {
      setLoading(true);
      setError(null);
      try {
        setStudies(await client.searchStudies({ patientName }));
      } catch (e) {
        setStudies([]);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    search('');
  }, [search]);

  return (
    <View style={styles.screen}>
      <Header
        title="Server studies"
        backLabel="Local"
        onBack={onBack}
        subtitle={client.host}
        left={
          <MenuButton
            items={[
              { label: 'Import', onPress: onOpenFiles },
              { label: 'Settings', onPress: onSettings },
            ]}
          />
        }
      />
      <TextInput
        style={styles.search}
        placeholder="Search by patient name"
        placeholderTextColor={colors.muted}
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={() => search(query)}
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="characters"
        clearButtonMode="while-editing"
      />
      <FlatList
        data={studies}
        keyExtractor={(s) => s.studyUID}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={() => search(query)} tintColor={colors.accent} />
        }
        ItemSeparatorComponent={Separator}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          loading ? undefined : error ? (
            <View style={styles.empty}>
              <Text style={styles.errorTitle}>Studies could not be loaded</Text>
              <Text style={styles.emptyText}>{error}</Text>
              <View style={styles.emptyActions}>
                <Button label="Try again" primary onPress={() => search(query)} />
                <Button label="Check server" onPress={onSettings} />
              </View>
            </View>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No studies found</Text>
              <Text style={styles.emptyText}>
                {query ? 'Try a shorter part of the name.' : 'Send studies to the server, or import DICOM files from this device, Google Drive, or Dropbox.'}
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => onOpenStudy(item)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <View style={styles.rowMain}>
              <Text style={styles.name} numberOfLines={1}>
                {item.patientName}
              </Text>
              <Text style={styles.detail} numberOfLines={1}>
                {item.description || 'No description'}
              </Text>
              <Text style={styles.meta} numberOfLines={1}>
                {[item.patientId && `ID ${item.patientId}`, item.accession && `Acc ${item.accession}`]
                  .filter(Boolean)
                  .join('   ')}
              </Text>
            </View>
            <View style={styles.rowSide}>
              <Text style={styles.date}>{item.studyDate}</Text>
              <View style={styles.badges}>
                {item.modalities.map((m) => (
                  <ModalityBadge key={m} modality={m} />
                ))}
              </View>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  search: {
    margin: space(4),
    marginBottom: space(2),
    paddingHorizontal: space(3),
    paddingVertical: space(2.5),
    borderRadius: 8,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line,
    color: colors.text,
    fontSize: type.body,
  },
  list: { paddingBottom: space(10), flexGrow: 1 },
  row: { flexDirection: 'row', paddingHorizontal: space(4), paddingVertical: space(3), gap: space(3) },
  rowPressed: { backgroundColor: colors.panel },
  rowMain: { flex: 1, gap: 2 },
  rowSide: { alignItems: 'flex-end', gap: space(1.5) },
  name: { color: colors.text, fontSize: type.title, fontWeight: '600' },
  detail: { color: colors.text, fontSize: type.body, opacity: 0.85 },
  meta: { color: colors.muted, fontSize: type.small },
  date: { color: colors.muted, fontSize: type.small, fontVariant: ['tabular-nums'] },
  badges: { flexDirection: 'row', gap: space(1) },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: space(4) },
  empty: { padding: space(8), alignItems: 'center', gap: space(2) },
  emptyTitle: { color: colors.text, fontSize: type.title, fontWeight: '600' },
  errorTitle: { color: colors.danger, fontSize: type.title, fontWeight: '600' },
  emptyText: { color: colors.muted, fontSize: type.body, textAlign: 'center' },
  emptyActions: { flexDirection: 'row', gap: space(2), marginTop: space(2) },
});
