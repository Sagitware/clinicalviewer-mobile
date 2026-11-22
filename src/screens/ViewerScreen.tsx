import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { useAnimatedReaction } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DicomViewport, fitView, useViewState, type Tool } from '../components/DicomViewport';
import { MeasureMenu } from '../components/MeasureMenu';
import { TextPrompt } from '../components/TextPrompt';
import { FrameCache } from '../lib/frameCache';
import {
  ellipseStats,
  TOOL_LABELS,
  withPoints,
  type Annotation,
  type MeasureTool,
  type NewAnnotation,
} from '../lib/measure';
import { WindowMenu } from '../components/WindowMenu';
import { readModalityValues, type LoadedFrame } from '../lib/skiaFrames';
import type { SliceSource } from '../lib/sources';
import { stackGeometry } from '../lib/volume';
import { CT_PRESETS, NO_PRESETS, type WindowSetting } from '../lib/windowPresets';
import { colors, space, type } from '../theme';
import { MprScreen } from './MprScreen';

const TOOL_BUTTONS: { id: Tool; label: string; glyph: string; pos: 'tl' | 'bl' | 'br' }[] = [
  { id: 'pan', label: 'Pan', glyph: '✥', pos: 'tl' },
  { id: 'scroll', label: 'Scroll', glyph: '☰', pos: 'bl' },
  { id: 'window', label: 'Window', glyph: '◐', pos: 'br' },
];

const CINE_FPS = 12;

const MEASURE_HINTS: Record<MeasureTool, string> = {
  length: 'Drag between two points',
  angle: 'Drag the first arm, then drag the second',
  ellipse: 'Drag across the region',
  arrow: 'Drag from the point of interest, then add a label',
};

const isMeasureTool = (t: Tool): t is MeasureTool => t in TOOL_LABELS;

/** Fills in what depends on the pixels: ellipse statistics, for grayscale frames. */
function measured(ann: Annotation, f: LoadedFrame | null): Annotation {
  if (ann.kind !== 'ellipse' || f?.kind !== 'gray') return ann;
  return { ...ann, stats: ellipseStats(ann.a, ann.b, f.width, f.height, (x, y, w, h) => readModalityValues(f, x, y, w, h)) };
}

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
  // The slice whose load last finished, successfully or not.
  const [settled, setSettled] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('window');
  const [smooth, setSmooth] = useState(true);
  const [inverted, setInverted] = useState(false);
  const [cine, setCine] = useState(false);
  const [readout, setReadout] = useState({ w: 0, c: 0, zoom: 100 });
  const defaults = useRef<WindowSetting | null>(null);
  const shownSize = useRef({ w: 0, h: 0 });
  // The slice the frame on screen belongs to (index runs ahead while a slice loads).
  const [shownIndex, setShownIndex] = useState(0);
  // Per slice, for this viewing session.
  const [annotations, setAnnotations] = useState<Map<number, Annotation[]>>(() => new Map());
  const [menuOpen, setMenuOpen] = useState(false);
  const [labeling, setLabeling] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const nextId = useRef(1);
  // Set while the MPR view is open on top of this one: the slice and window it starts from.
  const [mpr, setMpr] = useState<{ slice: number; window: WindowSetting; defaultWindow: WindowSetting } | null>(null);
  const mprProblem = useMemo(() => {
    const g = stackGeometry(source.geometry);
    return 'problem' in g ? g.problem : null;
  }, [source]);
  // Read by onDraw, which must stay stable or the gesture would be rebuilt on every slice.
  const latest = useRef({ frame, shownIndex });
  useLayoutEffect(() => {
    latest.current = { frame, shownIndex };
  });

  const applyWindow = useCallback(
    (w: number, c: number) => {
      view.ww.set(w);
      view.wc.set(c);
    },
    [view],
  );

  const show = useCallback(
    (f: LoadedFrame) => {
      setError(null);
      setFrame(f);
      if (f.width !== shownSize.current.w || f.height !== shownSize.current.h) {
        shownSize.current = { w: f.width, h: f.height };
        view.imgW.set(f.width);
        view.imgH.set(f.height);
        fitView(view);
      }
      if (!defaults.current) {
        const d =
          f.kind === 'gray'
            ? { w: f.windowWidth, c: f.windowCenter, invert: f.invert }
            : { w: 256, c: 128, invert: false };
        defaults.current = d;
        applyWindow(d.w, d.c);
        view.invert.set(d.invert ? 1 : 0);
        setInverted(d.invert);
      }
    },
    [view, applyWindow],
  );

  useEffect(() => {
    let cancelled = false;
    cache
      .load(index)
      .then((f) => {
        if (cancelled) return;
        show(f);
        setShownIndex(index);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setSettled(index));
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
      w: Math.round(view.ww.get()),
      c: Math.round(view.wc.get()),
      zoom: Math.round(view.scale.get() * 100),
    }),
    (cur, prev) => {
      if (!prev || cur.w !== prev.w || cur.c !== prev.c || cur.zoom !== prev.zoom) {
        scheduleOnRN(setReadout, cur);
      }
    },
  );

  const updateSlice = useCallback((slice: number, update: (list: Annotation[]) => Annotation[]) => {
    setAnnotations((prev) => {
      const next = new Map(prev);
      const list = update(prev.get(slice) ?? []);
      if (list.length) next.set(slice, list);
      else next.delete(slice);
      return next;
    });
  }, []);

  const onDraw = useCallback(
    (drawn: NewAnnotation) => {
      const { frame: f, shownIndex: slice } = latest.current;
      const id = String(nextId.current++);
      const ann = measured({ ...drawn, id } as Annotation, f);
      updateSlice(slice, (list) => [...list, ann]);
      if (ann.kind === 'arrow') setLabeling(id);
    },
    [updateSlice],
  );

  const onEdit = useCallback(
    (id: string, pts: number[]) => {
      const { frame: f, shownIndex: slice } = latest.current;
      updateSlice(slice, (list) => list.map((a) => (a.id === id ? measured(withPoints(a, pts), f) : a)));
    },
    [updateSlice],
  );

  const setArrowText = (id: string, text: string) =>
    updateSlice(shownIndex, (list) => list.map((a) => (a.id === id && a.kind === 'arrow' ? { ...a, text } : a)));

  const shownAnnotations = annotations.get(shownIndex) ?? [];
  // Only annotations on the image shown can be selected; changing slice drops the selection.
  const selected = shownAnnotations.find((a) => a.id === selectedId) ?? null;
  const measureTool = isMeasureTool(tool) ? tool : null;

  const toggleInvert = () => {
    const next = !inverted;
    view.invert.set(next ? 1 : 0);
    setInverted(next);
  };

  const reset = () => {
    const d = defaults.current;
    if (d) {
      applyWindow(d.w, d.c);
      view.invert.set(d.invert ? 1 : 0);
      setInverted(d.invert);
    }
    fitView(view);
  };

  const openMpr = () => {
    const problem = frame?.kind === 'color' ? 'MPR works on grayscale series only.' : mprProblem;
    if (problem) {
      Alert.alert('MPR is not available for this series', problem);
      return;
    }
    setCine(false);
    const current = { w: view.ww.get(), c: view.wc.get(), invert: inverted };
    setMpr({ slice: shownIndex, window: current, defaultWindow: defaults.current ?? current });
  };
  const closeMpr = useCallback(() => setMpr(null), []);

  const isGray = frame?.kind !== 'color';
  // Cached slices show within a microtask, so only uncached ones get a spinner (keeps cine flicker-free).
  const loading = settled !== index && !cache.has(index);

  return (
    <View style={styles.screen}>
      {/* Stays mounted under MPR so the image, zoom and annotations are as they were on the way back,
          but is neither drawn nor touchable, so none of it can show through or sit on top. */}
      <View
        style={[styles.body, mpr != null && styles.hidden]}
        pointerEvents={mpr ? 'none' : 'auto'}
        accessibilityElementsHidden={mpr != null}
        importantForAccessibility={mpr ? 'no-hide-descendants' : 'auto'}
      >
        <View style={[styles.topBar, { paddingTop: insets.top + space(1) }]}>
          <Pressable accessibilityRole="button" onPress={onBack} hitSlop={12}>
            <Text style={styles.back}>‹ {backLabel}</Text>
          </Pressable>
          <Text style={styles.topTitle} numberOfLines={1}>
            {source.seriesDescription || source.modality || 'Series'}
          </Text>
        </View>

        <View style={styles.viewport}>
          <DicomViewport
            frame={frame}
            view={view}
            tool={tool}
            smooth={smooth}
            modality={source.modality}
            annotations={shownAnnotations}
            selectedId={selected?.id ?? null}
            onStep={step}
            onDraw={onDraw}
            onSelect={setSelectedId}
            onEdit={onEdit}
          />

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

          {selected ? (
            <View style={styles.hint} pointerEvents="box-none">
              <View style={styles.selectionBar}>
                <Text style={styles.selectionText}>{TOOL_LABELS[selected.kind]}: drag a handle or the shape</Text>
                <View style={styles.selectionActions}>
                  {selected.kind === 'arrow' ? (
                    <Pressable onPress={() => setLabeling(selected.id)} style={styles.selectionBtn} accessibilityRole="button">
                      <Text style={styles.selectionBtnText}>Edit label</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    onPress={() => {
                      updateSlice(shownIndex, (list) => list.filter((a) => a.id !== selected.id));
                      setSelectedId(null);
                    }}
                    style={styles.selectionBtn}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.selectionBtnText, styles.danger]}>Delete</Text>
                  </Pressable>
                  <Pressable onPress={() => setSelectedId(null)} style={styles.selectionBtn} accessibilityRole="button">
                    <Text style={[styles.selectionBtnText, styles.done]}>Done</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          ) : measureTool ? (
            <View style={styles.hint} pointerEvents="none">
              <Text style={styles.hintText}>
                {TOOL_LABELS[measureTool]}: {MEASURE_HINTS[measureTool]}
              </Text>
            </View>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Measure and annotate"
            accessibilityState={{ selected: measureTool != null, expanded: menuOpen }}
            onPress={() => setMenuOpen((o) => !o)}
            style={[styles.toolBtn, styles.tr, measureTool && styles.toolBtnActive]}
          >
            <Text style={[styles.toolGlyph, measureTool && styles.toolGlyphActive]}>✎</Text>
          </Pressable>

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
          {menuOpen ? (
            <MeasureMenu
              active={measureTool}
              count={shownAnnotations.length}
              onPick={setTool}
              onUndo={() => updateSlice(shownIndex, (list) => list.slice(0, -1))}
              onClear={() => updateSlice(shownIndex, () => [])}
              onClose={() => setMenuOpen(false)}
            />
          ) : null}
          {error ? (
            <View style={styles.center} pointerEvents="none">
              <Text style={styles.errorTitle}>Image {index + 1} could not be shown</Text>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}
        </View>

        {labeling ? (
          <TextPrompt
            title="Arrow label"
            placeholder="For example: lesion"
            initialValue={(shownAnnotations.find((a) => a.id === labeling && a.kind === 'arrow') as { text?: string } | undefined)?.text}
            onSubmit={(text) => {
              setArrowText(labeling, text);
              setLabeling(null);
            }}
            onCancel={() => setLabeling(null)}
          />
        ) : null}

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

          {source.count > 1 ? (
            <View style={styles.toolRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="MPR view"
                accessibilityHint="Shows axial, coronal and sagittal views of this series"
                onPress={openMpr}
                style={styles.chip}
              >
                <Text style={[styles.chipText, mprProblem != null && styles.chipTextDim]}>MPR</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => setCine((c) => !c)}
                style={[styles.chip, cine && styles.chipActive]}
              >
                <Text style={styles.chipText}>{cine ? 'Stop' : 'Play'}</Text>
              </Pressable>
            </View>
          ) : null}

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {isGray ? (
              <Pressable onPress={toggleInvert} style={[styles.chip, inverted && styles.chipActive]}>
                <Text style={styles.chipText}>Invert</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={() => setSmooth((s) => !s)} style={[styles.chip, smooth && styles.chipActive]}>
              <Text style={styles.chipText}>Smooth</Text>
            </Pressable>
            <WindowMenu presets={isGray && source.modality === 'CT' ? CT_PRESETS : NO_PRESETS} onReset={reset} onPick={applyWindow} />
          </ScrollView>
        </View>
      </View>

      {mpr ? (
        <View style={styles.mprLayer} collapsable={false} accessibilityViewIsModal>
          <MprScreen
            source={source}
            startSlice={mpr.slice}
            startWindow={mpr.window}
            defaultWindow={mpr.defaultWindow}
            onBack={closeMpr}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  body: { flex: 1 },
  hidden: { opacity: 0 },
  mprLayer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1 },
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
  rowTop: { paddingHorizontal: 52 },
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
  tr: { top: space(2), right: space(2) },
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
  hint: { position: 'absolute', top: space(14), left: space(14), right: space(14), alignItems: 'center' },
  hintText: {
    color: colors.text,
    fontSize: type.small,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: space(2),
    paddingVertical: space(1),
    borderRadius: 4,
    overflow: 'hidden',
  },
  selectionBar: {
    backgroundColor: 'rgba(11,22,32,0.92)',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    paddingHorizontal: space(3),
    paddingVertical: space(2),
    gap: space(2),
    alignItems: 'center',
  },
  selectionText: { color: colors.muted, fontSize: type.small },
  selectionActions: { flexDirection: 'row', gap: space(2) },
  selectionBtn: { paddingHorizontal: space(3), paddingVertical: space(1.5), borderRadius: 6, backgroundColor: colors.panel },
  selectionBtnText: { color: colors.text, fontSize: type.small, fontWeight: '600' },
  danger: { color: colors.danger },
  done: { color: colors.accent },
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
  toolRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: space(2), paddingHorizontal: space(3) },
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
  chipTextDim: { color: colors.muted },
});
