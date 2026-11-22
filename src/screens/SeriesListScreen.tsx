import { memo, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button } from '../components/Button';
import { Header } from '../components/Header';
import { ModalityBadge } from '../components/ModalityBadge';
import type { DecodedFrame } from '../lib/pixels';
import { thumbnailUri } from '../lib/skiaFrames';
import type { SliceSource } from '../lib/sources';
import { colors, space, type } from '../theme';

export interface SeriesItem {
  key: string;
  modality: string;
  title: string;
  detail: string;
  open: () => Promise<SliceSource>;
  /** The image in the middle of the series, for its thumbnail. */
  thumbnail?: () => Promise<DecodedFrame>;
}

const THUMB = 64;
/** Fetches at once; more would compete with opening a series. */
const THUMB_CONCURRENCY = 2;
/** Kept for the session so going back to a study doesn't fetch them again. */
const thumbCache = new Map<string, string | null>();
const THUMB_CACHE_MAX = 300;

function remember(key: string, uri: string | null) {
  if (thumbCache.size >= THUMB_CACHE_MAX) thumbCache.delete(thumbCache.keys().next().value as string);
  thumbCache.set(key, uri);
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
  // Thumbnails live in thumbCache; this changes when a new one arrives so the list redraws.
  const [thumbsMade, setThumbsMade] = useState(0);

  useEffect(() => {
    let cancelled = false;
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

  // Thumbnails, top of the list first, a couple at a time.
  useEffect(() => {
    if (!items) return;
    let cancelled = false;
    const queue = items.filter((it) => it.thumbnail && !thumbCache.has(it.key));
    const worker = async () => {
      for (let it = queue.shift(); it && !cancelled; it = queue.shift()) {
        let uri: string | null = null;
        try {
          uri = thumbnailUri(await (it.thumbnail as () => Promise<DecodedFrame>)());
        } catch {
          uri = null;
        }
        remember(it.key, uri);
        if (!cancelled) setThumbsMade((n) => n + 1);
      }
    };
    for (let i = 0; i < THUMB_CONCURRENCY; i++) void worker();
    return () => {
      cancelled = true;
    };
  }, [items]);

  const retry = () => {
    setError(null);
    setItems(null);
    setAttempt((a) => a + 1);
  };

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
          {!items ? <Button label="Try again" onPress={retry} /> : null}
        </View>
      ) : null}
      {!items && !error ? <ActivityIndicator style={styles.spinner} color={colors.accent} /> : null}
      <FlatList
        data={items ?? []}
        extraData={thumbsMade}
        keyExtractor={(s) => s.key}
        ItemSeparatorComponent={Separator}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => open(item)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <Thumbnail uri={thumbCache.get(item.key)} waiting={item.thumbnail != null && !thumbCache.has(item.key)} />
            <View style={styles.rowMain}>
              <Text style={styles.title} numberOfLines={2}>
                {item.title}
              </Text>
              <View style={styles.metaRow}>
                <ModalityBadge modality={item.modality} />
                <Text style={styles.detail} numberOfLines={1}>
                  {item.detail}
                </Text>
              </View>
            </View>
            {opening === item.key ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.chev}>›</Text>}
          </Pressable>
        )}
      />
    </View>
  );
}

const Thumbnail = memo(function Thumbnail({ uri, waiting }: { uri: string | null | undefined; waiting: boolean }) {
  return (
    <View style={styles.thumb} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {uri ? (
        <Image source={{ uri }} style={styles.thumbImage} resizeMode="contain" fadeDuration={0} />
      ) : waiting ? (
        <ActivityIndicator size="small" color={colors.muted} />
      ) : (
        <Text style={styles.thumbNone}>No preview</Text>
      )}
    </View>
  );
});

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  notice: { color: colors.muted, fontSize: type.small, padding: space(4), paddingBottom: 0 },
  spinner: { marginTop: space(10) },
  errorBox: { margin: space(4), gap: space(3), alignItems: 'flex-start' },
  errorText: { color: colors.danger, fontSize: type.body },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingHorizontal: space(4), paddingVertical: space(2.5) },
  rowPressed: { backgroundColor: colors.panel },
  rowMain: { flex: 1, gap: space(1.5) },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: 6,
    backgroundColor: colors.viewport,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbImage: { width: '100%', height: '100%' },
  thumbNone: { color: colors.muted, fontSize: 10, textAlign: 'center' },
  title: { color: colors.text, fontSize: type.title },
  detail: { flex: 1, color: colors.muted, fontSize: type.small },
  chev: { color: colors.muted, fontSize: type.heading },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: space(4) },
});
