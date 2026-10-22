import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { useAnimatedReaction } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DicomViewport, fitView, useViewState, type Tool } from '../components/DicomViewport';
import { FrameCache } from '../lib/frameCache';
import type { LoadedFrame } from '../lib/skiaFrames';
import type { SliceSource } from '../lib/sources';
import { colors, space, type } from '../theme';

const CT_PRESETS = [
  { label: 'Soft tissue', w: 400, c: 40 },
  { label: 'Lung', w: 1500, c: -600 },
  { label: 'Bone', w: 1800, c: 400 },
  { label: 'Brain', w: 80, c: 40 },
  { label: 'Angio', w: 700, c: 200 },
  { label: 'Liver', w: 150, c: 90 },
];

const TOOL_BUTTONS: { id: Tool; label: string; glyph: string; pos: 'tl' | 'bl' | 'br' }[] = [
  { id: 'pan', label: 'Pan', glyph: '✥', pos: 'tl' },
  { id: 'scroll', label: 'Scroll', glyph: '☰', pos: 'bl' },
  { id: 'window', label: 'Window', glyph: '◐', pos: 'br' },
];

const CINE_FPS = 12;

interface Props {
  source: SliceSource;
  backLabel: string;
  onBack: () => void;
}

export function ViewerScreen({ source, backLabel, onBack }: Props) {
  const insets = useSafeAreaInsets();
  const view = useViewState();
  const cache = useMemo(() => new FrameCache(source), [source]);
  useEffect(() => () => cache.dispose(), [cache]);

  const [index, setIndex] = useState(0);
  const [frame, setFrame] = useState<LoadedFrame | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('window');
  const [smooth, setSmooth] = useState(true);
  const [inverted, setInverted] = useState(false);
  const [cine, setCine] = useState(false);
  const [readout, setReadout] = useState({ w: 0, c: 0, zoom: 100 });
  const defaults = useRef<{ w: number; c: number; invert: boolean } | null>(null);
  const shownSize = useRef({ w: 0, h: 0 });

  const applyWindow = useCallback(
    (w: number, c: number) => {
      view.ww.value = w;
      view.wc.value = c;
    },
    [view],
  );

  const show = useCallback(
    (f: LoadedFrame) => {
      setError(null);
      setFrame(f);
      if (f.width !== shownSize.current.w || f.height !== shownSize.current.h) {
        shownSize.current = { w: f.width, h: f.height };
        view.imgW.value = f.width;
        view.imgH.value = f.height;
        fitView(view);
      }
      if (!defaults.current) {
        const d =
          f.kind === 'gray'
            ? { w: f.windowWidth, c: f.windowCenter, invert: f.invert }
            : { w: 256, c: 128, invert: false };
        defaults.current = d;
        applyWindow(d.w, d.c);
        view.invert.value = d.invert ? 1 : 0;
        setInverted(d.invert);
      }
    },
    [view, applyWindow],
  );

  useEffect(() => {
    let cancelled = false;
    const cached = cache.peek(index);
    if (cached) {
      show(cached);
      setLoading(false);
    } else {
      setLoading(true);
      cache
        .load(index)
        .then((f) => !cancelled && show(f))
        .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
        .finally(() => !cancelled && setLoading(false));
    }
    cache.prefetch(index);
    return () => {
      cancelled = true;
    };
  }, [index, cache, show]);

  useEffect(() => {
    if (!cine || source.count < 2) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % source.count), 1000 / CINE_FPS);
    return () => clearInterval(id);
  }, [cine, source.count]);

  const step = useCallback(
    (d: number) => setIndex((i) => Math.min(source.count - 1, Math.max(0, i + d))),
    [source.count],
  );

  // Mirror window/zoom onto the overlay without re-rendering on every gesture frame.
  useAnimatedReaction(
    () => ({
      w: Math.round(view.ww.value),
      c: Math.round(view.wc.value),
      zoom: Math.round(view.scale.value * 100),
    }),
    (cur, prev) => {
      if (!prev || cur.w !== prev.w || cur.c !== prev.c || cur.zoom !== prev.zoom) {
        scheduleOnRN(setReadout, cur);
      }
    },
  );

  const toggleInvert = () => {
    const next = !inverted;
    view.invert.value = next ? 1 : 0;
    setInverted(next);
  };

  const reset = () => {
    const d = defaults.current;
    if (d) {
      applyWindow(d.w, d.c);
      view.invert.value = d.invert ? 1 : 0;
      setInverted(d.invert);
    }
    fitView(view);
  };

  const isGray = frame?.kind !== 'color';

  return (
    <View style={styles.screen}>
      <View style={[styles.topBar, { paddingTop: insets.top + space(1) }]}>
        <Pressable accessibilityRole="button" onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>‹ {backLabel}</Text>
        </Pressable>
        <Text style={styles.topTitle} numberOfLines={1}>
          {source.seriesDescription || source.modality || 'Series'}
        </Text>
      </View>

      <View style={styles.viewport}>
        <DicomViewport frame={frame} view={view} tool={tool} smooth={smooth} onStep={step} />

        <View style={styles.overlay} pointerEvents="none">
          <View style={[styles.overlayRow, styles.rowTop]}>
            <View>
              <Text style={styles.overlayText}>{source.patientName}</Text>
              <Text style={styles.overlayText}>{source.studyDate}</Text>
            </View>
            <View style={styles.alignEnd}>
              <Text style={styles.overlayText}>{source.modality}</Text>
              <Text style={styles.overlayText} numberOfLines={1}>
                {source.seriesDescription}
              </Text>
            </View>
          </View>
          <View style={[styles.overlayRow, styles.rowBottom]}>
            <View>
              <Text style={styles.overlayText}>
                Im {index + 1} / {source.count}
              </Text>
              {isGray ? (
                <Text style={styles.overlayText}>
                  W {readout.w}  L {readout.c}
                </Text>
              ) : null}
            </View>
            <Text style={styles.overlayText}>{readout.zoom}%</Text>
          </View>
        </View>

        {TOOL_BUTTONS.map((t) => (
          <Pressable
            key={t.id}
            accessibilityRole="button"
            accessibilityLabel={t.label}
            accessibilityState={{ selected: tool === t.id }}
            onPress={() => setTool(t.id)}
            style={[styles.toolBtn, styles[t.pos], tool === t.id && styles.toolBtnActive]}
          >
            <Text style={[styles.toolGlyph, tool === t.id && styles.toolGlyphActive]}>{t.glyph}</Text>
          </Pressable>
        ))}

        {loading && !frame ? (
          <View style={styles.center} pointerEvents="none">
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.centerText}>Loading image</Text>
          </View>
        ) : null}
        {loading && frame ? (
          <ActivityIndicator style={styles.cornerSpinner} color={colors.overlay} size="small" />
        ) : null}
        {error ? (
          <View style={styles.center} pointerEvents="none">
            <Text style={styles.errorTitle}>Image {index + 1} could not be shown</Text>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}
      </View>

      <View style={[styles.controls, { paddingBottom: insets.bottom + space(2) }]}>
        {source.count > 1 ? (
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={source.count - 1}
            step={1}
            value={index}
            onValueChange={(val) => setIndex(Math.round(val))}
            minimumTrackTintColor={colors.accent}
            maximumTrackTintColor={colors.line}
            thumbTintColor={colors.accent}
            accessibilityLabel="Slice"
          />
        ) : null}

        <View style={styles.toolRow}>
          {source.count > 1 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setCine((c) => !c)}
              style={[styles.chip, cine && styles.chipActive]}
            >
              <Text style={styles.chipText}>{cine ? 'Stop' : 'Play'}</Text>
            </Pressable>
          ) : null}
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {isGray ? (
            <Pressable onPress={toggleInvert} style={[styles.chip, inverted && styles.chipActive]}>
              <Text style={styles.chipText}>Invert</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => setSmooth((s) => !s)} style={[styles.chip, smooth && styles.chipActive]}>
            <Text style={styles.chipText}>Smooth</Text>
          </Pressable>
          <Pressable onPress={reset} style={styles.chip}>
            <Text style={styles.chipText}>Reset</Text>
          </Pressable>
          {isGray && source.modality === 'CT'
            ? CT_PRESETS.map((p) => (
                <Pressable key={p.label} onPress={() => applyWindow(p.w, p.c)} style={styles.chip}>
                  <Text style={styles.chipText}>{p.label}</Text>
                </Pressable>
              ))
            : null}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    paddingHorizontal: space(4),
    paddingBottom: space(2),
  },
  back: { color: colors.accent, fontSize: type.body },
  topTitle: { flex: 1, color: colors.text, fontSize: type.title, fontWeight: '600', textAlign: 'right' },
  viewport: { flex: 1, backgroundColor: colors.viewport },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, padding: space(2), justifyContent: 'space-between' },
  rowTop: { paddingLeft: 52 },
  rowBottom: { paddingHorizontal: 52 },
  toolBtn: {
    position: 'absolute',
    width: 44,
    height: 44,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.line,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolBtnActive: { borderColor: colors.accent },
  toolGlyph: { color: colors.overlay, fontSize: 24 },
  toolGlyphActive: { color: colors.accent },
  tl: { top: space(2), left: space(2) },
  bl: { bottom: space(2), left: space(2) },
  br: { bottom: space(2), right: space(2) },
  overlayRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', gap: space(4) },
  alignEnd: { alignItems: 'flex-end', flexShrink: 1 },
  overlayText: {
    color: colors.overlay,
    fontSize: type.small,
    fontVariant: ['tabular-nums'],
    textShadowColor: '#000',
    textShadowRadius: 2,
  },
  center: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: space(8) },
  centerText: { color: colors.muted, marginTop: space(2), fontSize: type.small },
  cornerSpinner: { position: 'absolute', top: space(12), right: space(3) },
  errorTitle: { color: colors.danger, fontSize: type.body, fontWeight: '600', textAlign: 'center' },
  errorText: { color: colors.text, fontSize: type.small, marginTop: space(2), textAlign: 'center' },
  controls: {
    backgroundColor: colors.ink,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    paddingTop: space(1),
    gap: space(2),
  },
  slider: { marginHorizontal: space(3), height: 32 },
  toolRow: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: space(3) },
  chips: { gap: space(2), paddingHorizontal: space(3) },
  chip: {
    paddingHorizontal: space(3),
    paddingVertical: space(2),
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  chipActive: { borderColor: colors.accent, backgroundColor: colors.raised },
  chipText: { color: colors.text, fontSize: type.small },
});
