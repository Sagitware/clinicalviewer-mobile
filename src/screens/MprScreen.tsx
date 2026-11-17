import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { useAnimatedReaction, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MprPane, PLANE_COLORS, type MprTool, type MprWindow } from '../components/MprPane';
import { WindowMenu } from '../components/WindowMenu';
import type { SliceSource } from '../lib/sources';
import { CT_PRESETS, NO_PRESETS, type WindowSetting } from '../lib/windowPresets';
import { loadVolume, planesFor, stackGeometry, type PlaneName, type Volume } from '../lib/volume';
import { colors, space, type } from '../theme';

const TOOLS: { id: MprTool; label: string }[] = [
  { id: 'cross', label: 'Crosshair' },
  { id: 'scroll', label: 'Scroll' },
  { id: 'window', label: 'Window' },
  { id: 'pan', label: 'Pan' },
];

const HINTS: Record<MprTool, string> = {
  cross: 'Tap or drag in a view to bring the other two to that point. Double-tap a view to swap it with the main view.',
  scroll: 'Drag up or down in a view to page through it.',
  window: 'Drag sideways for width, up or down for level.',
  pan: 'Drag to move a view. Pinch to zoom in any tool.',
};

const PANE_GAP = 2;

interface Props {
  source: SliceSource;
  /** The slice on screen in the 2D viewer; the crosshair starts there. */
  startSlice: number;
  /** The window in use in the 2D viewer. */
  startWindow: WindowSetting;
  /** What Reset goes back to. */
  defaultWindow: WindowSetting;
  onBack: () => void;
}

/** Axial, coronal and sagittal views of one series, linked by a crosshair. */
export function MprScreen({ source, startSlice, startWindow, defaultWindow, onBack }: Props) {
  const insets = useSafeAreaInsets();
  const geometry = useMemo(() => stackGeometry(source.geometry), [source]);
  const [loaded, setLoaded] = useState(0);
  const [volume, setVolume] = useState<Volume | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if ('problem' in geometry) return;
    const token = { cancelled: false };
    loadVolume(source, geometry, setLoaded, token)
      .then((v) => v && setVolume(v))
      .catch((e: unknown) => !token.cancelled && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      token.cancelled = true;
    };
  }, [source, geometry]);

  // Android's back button returns to the 2D viewer instead of leaving it as well.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  const error = 'problem' in geometry ? geometry.problem : loadError;

  return (
    <View style={styles.screen}>
      <View style={[styles.topBar, { paddingTop: insets.top + space(1) }]}>
        <Pressable accessibilityRole="button" onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>‹ Images</Text>
        </Pressable>
        <Text style={styles.topTitle} numberOfLines={1}>
          MPR{source.seriesDescription ? `  ${source.seriesDescription}` : ''}
        </Text>
      </View>

      {volume ? (
        <Workspace volume={volume} modality={source.modality} startSlice={startSlice} startWindow={startWindow} defaultWindow={defaultWindow} />
      ) : (
        <View style={[styles.center, { paddingBottom: insets.bottom }]}>
          {error ? (
            <>
              <Text style={styles.errorTitle}>MPR is not available for this series</Text>
              <Text style={styles.errorText}>{error}</Text>
            </>
          ) : (
            <>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.centerText}>
                Building the volume: {loaded} of {source.count} images
              </Text>
              <View style={styles.track} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: source.count, now: loaded }}>
                <View style={[styles.trackFill, { width: `${(100 * loaded) / source.count}%` }]} />
              </View>
            </>
          )}
        </View>
      )}
    </View>
  );
}

interface WorkspaceProps {
  volume: Volume;
  modality: string;
  startSlice: number;
  startWindow: WindowSetting;
  defaultWindow: WindowSetting;
}

function Workspace({ volume, modality, startSlice, startWindow: initial, defaultWindow }: WorkspaceProps) {
  const insets = useSafeAreaInsets();
  const planes = useMemo(() => planesFor(volume.axes), [volume]);
  // The view that looks along each voxel axis lends its colour to that axis's reference lines.
  const axisColors = useMemo(() => {
    const list = ['', '', ''];
    for (const p of planes) list[p.fixed] = PLANE_COLORS[p.name];
    return list;
  }, [planes]);

  const [start] = useState(() => [
    Math.floor(volume.size[0] / 2),
    Math.floor(volume.size[1] / 2),
    Math.min(volume.size[2] - 1, Math.max(0, startSlice)),
  ]);
  // The crosshair lives on the UI thread so the lines follow the finger; this copy picks the cuts.
  const crossSV = useSharedValue(start);
  const [cross, setCross] = useState(start);
  const pending = useRef<number[] | null>(null);
  // Re-cutting two views per move is the slow part, so moves that arrive faster than they can be
  // drawn collapse into the latest one.
  const follow = useCallback((next: number[]) => {
    const waiting = pending.current != null;
    pending.current = next;
    if (waiting) return;
    requestAnimationFrame(() => {
      const latest = pending.current;
      pending.current = null;
      if (latest) setCross(latest);
    });
  }, []);
  useAnimatedReaction(
    () => crossSV.get(),
    (cur, prev) => {
      if (!prev || cur[0] !== prev[0] || cur[1] !== prev[1] || cur[2] !== prev[2]) scheduleOnRN(follow, cur);
    },
  );

  const wc = useSharedValue(initial.c);
  const ww = useSharedValue(initial.w);
  const invert = useSharedValue(initial.invert ? 1 : 0);
  const win = useMemo<MprWindow>(() => ({ wc, ww, invert }), [wc, ww, invert]);
  const [inverted, setInverted] = useState(initial.invert);
  const [readout, setReadout] = useState({ w: Math.round(initial.w), c: Math.round(initial.c) });
  useAnimatedReaction(
    () => ({ w: Math.round(ww.get()), c: Math.round(wc.get()) }),
    (cur, prev) => {
      if (!prev || cur.w !== prev.w || cur.c !== prev.c) scheduleOnRN(setReadout, cur);
    },
  );

  const [tool, setTool] = useState<MprTool>('cross');
  const [smooth, setSmooth] = useState(true);
  // Which view sits where: the first is the main view.
  const [order, setOrder] = useState<PlaneName[]>(['axial', 'coronal', 'sagittal']);
  const [fitKey, setFitKey] = useState(0);
  const [area, setArea] = useState({ w: 0, h: 0 });

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setArea((a) => (a.w === width && a.h === height ? a : { w: width, h: height }));
  };

  const applyWindow = (w: number, c: number) => {
    ww.set(w);
    wc.set(c);
  };
  const setInvert = (on: boolean) => {
    invert.set(on ? 1 : 0);
    setInverted(on);
  };
  const reset = () => {
    applyWindow(defaultWindow.w, defaultWindow.c);
    setInvert(defaultWindow.invert);
    setFitKey((k) => k + 1);
  };

  // The name tag makes its view the main one.
  const promote = useCallback((name: PlaneName) => setOrder((o) => tradePlaces(o, name)), []);
  // A double tap does the same; on the main view it brings axial back.
  const swap = useCallback((name: PlaneName) => setOrder((o) => tradePlaces(o, o[0] === name ? 'axial' : name)), []);

  const rects = paneRects(area.w, area.h, order);

  return (
    <>
      <View style={styles.views} onLayout={onLayout}>
        {area.w > 0
          ? planes.map((p) => (
              <View key={p.name} style={[styles.paneSlot, rects[p.name]]}>
                <MprPane
                  volume={volume}
                  plane={p}
                  cross={crossSV}
                  at={cross[p.fixed]}
                  axisColors={axisColors}
                  window={win}
                  tool={tool}
                  smooth={smooth}
                  active={p.name === order[0]}
                  fitKey={fitKey}
                  onActivate={promote}
                  onSwap={swap}
                />
              </View>
            ))
          : null}
      </View>

      <View style={[styles.controls, { paddingBottom: insets.bottom + space(2) }]}>
        <View style={styles.toolRow}>
          {TOOLS.map((t) => (
            <Pressable
              key={t.id}
              accessibilityRole="button"
              accessibilityState={{ selected: tool === t.id }}
              onPress={() => setTool(t.id)}
              style={[styles.chip, styles.toolChip, tool === t.id && styles.chipActive]}
            >
              <Text style={[styles.chipText, tool === t.id && styles.chipTextActive]}>{t.label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.hintRow}>
          <Text style={styles.hint} numberOfLines={2}>
            {HINTS[tool]}
            {volume.reduction > 1 ? ` Detail within each slice is reduced ${volume.reduction}× to fit in memory.` : ''}
          </Text>
          <Text style={styles.readout}>
            W {readout.w}  L {readout.c}
          </Text>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          <Pressable onPress={() => setInvert(!inverted)} style={[styles.chip, inverted && styles.chipActive]}>
            <Text style={styles.chipText}>Invert</Text>
          </Pressable>
          <Pressable onPress={() => setSmooth((s) => !s)} style={[styles.chip, smooth && styles.chipActive]}>
            <Text style={styles.chipText}>Smooth</Text>
          </Pressable>
          <WindowMenu presets={modality === 'CT' ? CT_PRESETS : NO_PRESETS} onReset={reset} onPick={applyWindow} />
        </ScrollView>
      </View>
    </>
  );
}

type PaneRect = { left: number; top: number; width: number; height: number };

/** The order with `name` moved to the front and the view that was there put in its place. */
function tradePlaces(order: PlaneName[], name: PlaneName): PlaneName[] {
  const i = order.indexOf(name);
  if (i <= 0) return order;
  const next = order.slice();
  next[0] = name;
  next[i] = order[0];
  return next;
}

/**
 * Where each view goes, given their order. Upright: the first (main) view on top, the other two
 * side by side beneath it. On its side (or on a wide tablet): three in a row.
 */
function paneRects(w: number, h: number, order: PlaneName[]): Record<PlaneName, PaneRect> {
  const rects = {} as Record<PlaneName, PaneRect>;
  if (w > h) {
    const each = (w - 2 * PANE_GAP) / 3;
    order.forEach((name, i) => {
      rects[name] = { left: i * (each + PANE_GAP), top: 0, width: each, height: h };
    });
    return rects;
  }
  const mainHeight = Math.round((h - PANE_GAP) * 0.6);
  const half = (w - PANE_GAP) / 2;
  order.forEach((name, i) => {
    rects[name] =
      i === 0
        ? { left: 0, top: 0, width: w, height: mainHeight }
        : { left: (i - 1) * (half + PANE_GAP), top: mainHeight + PANE_GAP, width: half, height: h - mainHeight - PANE_GAP };
  });
  return rects;
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
  views: { flex: 1, backgroundColor: colors.ink },
  paneSlot: { position: 'absolute' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(8), gap: space(3) },
  centerText: { color: colors.muted, fontSize: type.small, fontVariant: ['tabular-nums'] },
  track: { width: '70%', maxWidth: 320, height: 4, borderRadius: 2, backgroundColor: colors.line, overflow: 'hidden' },
  trackFill: { height: 4, backgroundColor: colors.accent },
  errorTitle: { color: colors.danger, fontSize: type.body, fontWeight: '600', textAlign: 'center' },
  errorText: { color: colors.text, fontSize: type.small, textAlign: 'center' },
  controls: {
    backgroundColor: colors.ink,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    paddingTop: space(2),
    gap: space(2),
  },
  readout: { color: colors.overlay, fontSize: type.small, fontVariant: ['tabular-nums'] },
  toolRow: { flexDirection: 'row', gap: space(2), paddingHorizontal: space(3) },
  toolChip: { flex: 1, alignItems: 'center', paddingHorizontal: space(1) },
  hintRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space(3), paddingHorizontal: space(3) },
  hint: { flex: 1, color: colors.muted, fontSize: type.small },
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
  chipTextActive: { color: colors.accent, fontWeight: '600' },
});
