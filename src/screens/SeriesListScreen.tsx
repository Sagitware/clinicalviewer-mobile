import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button } from '../components/Button';
import { Header } from '../components/Header';
import { ModalityBadge } from '../components/ModalityBadge';
import type { SliceSource } from '../lib/sources';
import { colors, space, type } from '../theme';

export interface SeriesItem {
  key: string;
  modality: string;
  title: string;
  detail: string;
  open: () => Promise<SliceSource>;
}

interface Props {
  title: string;
  subtitle?: string;
  backLabel: string;
  load: () => Promise<{ items: SeriesItem[]; notice?: string }>;
  onBack: () => void;
  onOpen: (source: SliceSource, item: SeriesItem) => void;
}

export function SeriesListScreen({ title, subtitle, backLabel, load, onBack, onOpen }: Props) {
  const [items, setItems] = useState<SeriesItem[] | null>(null);
  const [notice, setNotice] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setItems(null);
    load()
      .then((r) => {
        if (cancelled) return;
        setItems(r.items);
        setNotice(r.notice);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [load, attempt]);

  const open = async (item: SeriesItem) => {
    if (opening) return;
    setOpening(item.key);
    setError(null);
    try {
      onOpen(await item.open(), item);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(null);
    }
  };

  return (
    <View style={styles.screen}>
      <Header title={title} subtitle={subtitle} backLabel={backLabel} onBack={onBack} />
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          {!items ? <Button label="Try again" onPress={() => setAttempt((a) => a + 1)} /> : null}
        </View>
      ) : null}
      {!items && !error ? <ActivityIndicator style={styles.spinner} color={colors.accent} /> : null}
      <FlatList
        data={items ?? []}
        keyExtractor={(s) => s.key}
        ItemSeparatorComponent={Separator}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => open(item)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <ModalityBadge modality={item.modality} />
            <View style={styles.rowMain}>
              <Text style={styles.title} numberOfLines={2}>
                {item.title}
              </Text>
              <Text style={styles.detail}>{item.detail}</Text>
            </View>
            {opening === item.key ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.chev}>›</Text>}
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
  notice: { color: colors.muted, fontSize: type.small, padding: space(4), paddingBottom: 0 },
  spinner: { marginTop: space(10) },
  errorBox: { margin: space(4), gap: space(3), alignItems: 'flex-start' },
  errorText: { color: colors.danger, fontSize: type.body },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingHorizontal: space(4), paddingVertical: space(3.5) },
  rowPressed: { backgroundColor: colors.panel },
  rowMain: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: type.title },
  detail: { color: colors.muted, fontSize: type.small },
  chev: { color: colors.muted, fontSize: type.heading },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: space(4) },
});
