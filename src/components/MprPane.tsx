import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import {
  Canvas,
  Fill,
  FilterMode,
  Group,
  ImageShader,
  MipmapMode,
  Path,
  Rect,
  Shader,
  Skia,
  usePathValue,
} from '@shopify/react-native-skia';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { bytePlane, GRAY_EFFECT } from '../lib/skiaFrames';
import { reslice, type Plane, type PlaneName, type Volume } from '../lib/volume';
import { colors, space, type } from '../theme';

export type MprTool = 'cross' | 'scroll' | 'window' | 'pan';
const TOOL_INDEX: Record<MprTool, number> = { cross: 0, scroll: 1, window: 2, pan: 3 };
const CROSS = 0;
const SCROLL = 1;
const WINDOW = 2;

export const PLANE_LABELS: Record<PlaneName, string> = { axial: 'Axial', coronal: 'Coronal', sagittal: 'Sagittal' };
/** One colour per view; a view's reference lines in the other two use it. */
export const PLANE_COLORS: Record<PlaneName, string> = { axial: '#F0D98C', coronal: '#5EC2B7', sagittal: '#C59BE8' };

/** Pixels of vertical drag per slice in scroll mode. */
const STEP_PX = 10;
/** Half the opening left in the reference lines where they cross, so they don't hide what they point at. */
const GAP_PX = 10;
const NEAREST = { filter: FilterMode.Nearest, mipmap: MipmapMode.None };

/** Window, level and invert, shared by the three views. */
export interface MprWindow {
  wc: SharedValue<number>;
  ww: SharedValue<number>;
  invert: SharedValue<number>;
}

interface Props {
  volume: Volume;
  plane: Plane;
  /** The voxel all three views pass through, one index per voxel axis. Dragging here writes to it. */
  cross: SharedValue<number[]>;
  /** Where this view cuts the volume: the crosshair's index along the view's fixed axis. */
  at: number;
  /** Line colour for the view that looks along each voxel axis. */
  axisColors: string[];
  window: MprWindow;
  tool: MprTool;
  smooth: boolean;
  /** The main view; it gets a highlighted frame. */
  active: boolean;
  /** Changes when the view should go back to fitting its pane. */
  fitKey: number;
  /** The view's name tag was pressed. */
  onActivate: (name: PlaneName) => void;
  /** The view was double-tapped. */
  onSwap: (name: PlaneName) => void;
}

/** One of the three MPR views: a cut through the volume with the other two views' reference lines. */
export const MprPane = memo(function MprPane({
  volume,
  plane,
  cross,
  at,
  axisColors,
  window: win,
  tool,
  smooth,
  active,
  fitKey,
  onActivate,
  onSwap,
}: Props) {
  const { h, v, fixed, flipH, flipV, name } = plane;
  const W = volume.size[h];
  const H = volume.size[v];
  const count = volume.size[fixed];
  // Voxels are rarely cubes: one image pixel is pw × ph millimetres, and the view scales in points per mm.
  const pw = volume.spacing[h];
  const ph = volume.spacing[v];
  const mmW = W * pw;
  const mmH = H * ph;

  const image = useMemo(() => {
    try {
      const cut = reslice(volume, plane, at);
      return { hi: bytePlane(cut.hi, cut.width, cut.height), lo: bytePlane(cut.lo, cut.width, cut.height) };
    } catch {
      return null;
    }
  }, [volume, plane, at]);

  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const fitScale = useSharedValue(1);
  const canvas = useRef({ w: 0, h: 0 });

  const fit = useCallback(() => {
    const { w, h: ch } = canvas.current;
    if (w <= 0 || ch <= 0) return;
    const s = Math.min(w / mmW, ch / mmH);
    fitScale.set(s);
    scale.set(s);
    tx.set((w - mmW * s) / 2);
    ty.set((ch - mmH * s) / 2);
  }, [mmW, mmH, fitScale, scale, tx, ty]);

  useEffect(() => {
    fit();
  }, [fit, fitKey]);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (canvas.current.w === width && canvas.current.h === height) return;
    canvas.current = { w: width, h: height };
    fit();
  };

  const toolSV = useSharedValue(TOOL_INDEX[tool]);
  useEffect(() => {
    toolSV.set(TOOL_INDEX[tool]);
  }, [tool, toolSV]);

  const panStart = useSharedValue({ wc: 0, ww: 0, tx: 0, ty: 0, cross: [0, 0, 0] });
  const pinchStart = useSharedValue({ s: 1, tx: 0, ty: 0, fx: 0, fy: 0, k: 1, n: 2 });
  // As in the 2D viewport: a one-finger drag that began before the second finger landed is paused
  // until every finger lifts, so it can't fight the pinch.
  const panning = useSharedValue(false);
  const pinched = useSharedValue(false);
  // Touches started since the last pinch ended; a double tap needs both of its taps to be new ones.
  const touchesSincePinch = useSharedValue(2);

  const gesture = useMemo(() => {
    /** Moves the crosshair to the voxel under a point of the view. */
    const place = (x: number, y: number) => {
      'worklet';
      const s = scale.get();
      const col = Math.min(W - 1, Math.max(0, Math.floor((x - tx.get()) / (s * pw))));
      const row = Math.min(H - 1, Math.max(0, Math.floor((y - ty.get()) / (s * ph))));
      const a = flipH ? W - 1 - col : col;
      const b = flipV ? H - 1 - row : row;
      const cur = cross.get();
      if (cur[h] === a && cur[v] === b) return;
      const next = cur.slice();
      next[h] = a;
      next[v] = b;
      cross.set(next);
    };

    const anchorPinch = (e: { focalX: number; focalY: number; scale: number; numberOfPointers: number }) => {
      'worklet';
      pinchStart.set({ s: scale.get(), tx: tx.get(), ty: ty.get(), fx: e.focalX, fy: e.focalY, k: e.scale, n: e.numberOfPointers });
    };

    const pan = Gesture.Pan()
      .maxPointers(1)
      .minDistance(2)
      .onBegin(() => {
        pinched.set(false);
        touchesSincePinch.set(touchesSincePinch.get() + 1);
      })
      .onStart((e) => {
        panStart.set({ wc: win.wc.get(), ww: win.ww.get(), tx: tx.get(), ty: ty.get(), cross: cross.get() });
        panning.set(true);
        if (toolSV.get() === CROSS) place(e.x, e.y);
      })
      .onUpdate((e) => {
        if (pinched.get()) return;
        const start = panStart.get();
        const mode = toolSV.get();
        if (mode === CROSS) {
          place(e.x, e.y);
        } else if (mode === SCROLL) {
          const target = Math.min(count - 1, Math.max(0, start.cross[fixed] + Math.trunc(e.translationY / STEP_PX)));
          const cur = cross.get();
          if (cur[fixed] !== target) {
            const next = cur.slice();
            next[fixed] = target;
            cross.set(next);
          }
        } else if (mode === WINDOW) {
          // Horizontal drag = width, vertical drag = level. Sensitivity follows the current width.
          const k = Math.max(start.ww / 300, 0.25);
          win.ww.set(Math.max(1, start.ww + e.translationX * k));
          win.wc.set(start.wc + e.translationY * k);
        } else {
          tx.set(start.tx + e.translationX);
          ty.set(start.ty + e.translationY);
        }
      })
      .onFinalize(() => {
        panning.set(false);
      });

    // Pinch zooms about the fingers and also pans as they move, in every tool.
    const pinch = Gesture.Pinch()
      .onStart((e) => {
        pinched.set(true);
        // Undo what the drag did in its first few pixels before the second finger landed.
        if (panning.get()) {
          const start = panStart.get();
          const mode = toolSV.get();
          if (mode === CROSS || mode === SCROLL) {
            cross.set(start.cross);
          } else if (mode === WINDOW) {
            win.ww.set(start.ww);
            win.wc.set(start.wc);
          } else {
            tx.set(start.tx);
            ty.set(start.ty);
          }
        }
        anchorPinch(e);
      })
      .onUpdate((e) => {
        const p = pinchStart.get();
        // When a finger lifts, the focal point jumps to the remaining finger. Skip those updates,
        // and re-anchor when the finger count changes so the image doesn't jump.
        if (e.numberOfPointers !== p.n) {
          anchorPinch(e);
          return;
        }
        if (e.numberOfPointers < 2) return;
        const fitted = fitScale.get();
        const s = Math.min(Math.max((p.s * e.scale) / p.k, fitted * 0.25), fitted * 30);
        const r = s / p.s;
        scale.set(s);
        tx.set(e.focalX - (p.fx - p.tx) * r);
        ty.set(e.focalY - (p.fy - p.ty) * r);
      })
      .onEnd(() => {
        touchesSincePinch.set(0);
      });

    // A double tap trades places with the main view. The limits keep two quick pinches or short
    // drags in a row from counting as one.
    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .maxDistance(12)
      .maxDuration(250)
      .maxDelay(300)
      .onEnd((e, success) => {
        if (!success || e.numberOfPointers > 1 || touchesSincePinch.get() < 2) return;
        scheduleOnRN(onSwap, name);
      });

    // A single tap puts the crosshair there, once it's clear a second tap isn't coming.
    const tap = Gesture.Tap()
      .maxDistance(12)
      .maxDuration(250)
      .onEnd((e, success) => {
        if (success && e.numberOfPointers <= 1 && toolSV.get() === CROSS) place(e.x, e.y);
      });

    return Gesture.Simultaneous(pan, pinch, Gesture.Exclusive(doubleTap, tap));
  }, [
    W, H, count, pw, ph, h, v, fixed, flipH, flipV, name, cross, win, scale, tx, ty, fitScale, toolSV,
    panStart, pinchStart, panning, pinched, touchesSincePinch, onSwap,
  ]);

  const transform = useDerivedValue(() => [
    { translateX: tx.get() },
    { translateY: ty.get() },
    { scaleX: scale.get() * pw },
    { scaleY: scale.get() * ph },
  ]);

  const { offset, slope, intercept } = volume;
  const smoothFlag = smooth ? 1 : 0;
  const uniforms = useDerivedValue(
    () => ({
      size: [W, H],
      wc: win.wc.get(),
      ww: win.ww.get(),
      slope,
      intercept,
      offset,
      invert: win.invert.get(),
      smooth: smoothFlag,
    }),
    [W, H, slope, intercept, offset, smoothFlag],
  );
  const rect = useMemo(() => Skia.XYWHRect(0, 0, W, H), [W, H]);

  // Reference lines, in screen points so they stay one width at any zoom: where the other two
  // views cut this one, through the centre of the crosshair voxel.
  const acrossLine = usePathValue((path) => {
    'worklet';
    const c = cross.get();
    const sx = scale.get() * pw;
    const x = ((flipH ? W - 1 - c[h] : c[h]) + 0.5) * sx + tx.get();
    const y = ((flipV ? H - 1 - c[v] : c[v]) + 0.5) * scale.get() * ph + ty.get();
    const x0 = tx.get();
    const x1 = x0 + W * sx;
    if (x - GAP_PX > x0) {
      path.moveTo(x0, y);
      path.lineTo(x - GAP_PX, y);
    }
    if (x + GAP_PX < x1) {
      path.moveTo(x + GAP_PX, y);
      path.lineTo(x1, y);
    }
  });
  const downLine = usePathValue((path) => {
    'worklet';
    const c = cross.get();
    const sy = scale.get() * ph;
    const x = ((flipH ? W - 1 - c[h] : c[h]) + 0.5) * scale.get() * pw + tx.get();
    const y = ((flipV ? H - 1 - c[v] : c[v]) + 0.5) * sy + ty.get();
    const y0 = ty.get();
    const y1 = y0 + H * sy;
    if (y - GAP_PX > y0) {
      path.moveTo(x, y0);
      path.lineTo(x, y - GAP_PX);
    }
    if (y + GAP_PX < y1) {
      path.moveTo(x, y + GAP_PX);
      path.lineTo(x, y1);
    }
  });

  const tint = axisColors[fixed];
  const label = PLANE_LABELS[name];

  return (
    <View style={[styles.pane, active && { borderColor: tint }]}>
      <GestureDetector gesture={gesture}>
        <View style={styles.fill} onLayout={onLayout} collapsable={false}>
          <Canvas style={styles.fill}>
            <Fill color={colors.viewport} />
            {image ? (
              <Group transform={transform}>
                <Rect x={0} y={0} width={W} height={H}>
                  <Shader source={GRAY_EFFECT} uniforms={uniforms}>
                    <ImageShader image={image.hi} fit="none" rect={rect} sampling={NEAREST} />
                    <ImageShader image={image.lo} fit="none" rect={rect} sampling={NEAREST} />
                  </Shader>
                </Rect>
              </Group>
            ) : null}
            {/* The horizontal line is the view that looks along this one's vertical axis, and vice versa. */}
            <Path path={acrossLine} style="stroke" strokeWidth={1} color={axisColors[v]} />
            <Path path={downLine} style="stroke" strokeWidth={1} color={axisColors[h]} />
          </Canvas>
        </View>
      </GestureDetector>

      <View style={styles.edges} pointerEvents="none">
        <Text style={[styles.edge, styles.edgeTop]}>{plane.edges.top}</Text>
        <Text style={[styles.edge, styles.edgeBottom]}>{plane.edges.bottom}</Text>
        <View style={styles.edgeSides}>
          <Text style={styles.edge}>{plane.edges.left}</Text>
          <Text style={styles.edge}>{plane.edges.right}</Text>
        </View>
      </View>
      {image ? null : (
        <View style={styles.failed} pointerEvents="none">
          <Text style={styles.failedText}>This view could not be drawn on this device.</Text>
        </View>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label} view, image ${at + 1} of ${count}. Make this the main view.`}
        accessibilityState={{ selected: active }}
        onPress={() => onActivate(name)}
        hitSlop={8}
        style={styles.tag}
      >
        <Text style={[styles.tagText, { color: tint }]}>{label}</Text>
        <Text style={styles.tagIndex}>
          {at + 1}/{count}
        </Text>
      </Pressable>
    </View>
  );
});

const shadow = { textShadowColor: '#000', textShadowRadius: 2 } as const;

const styles = StyleSheet.create({
  pane: { flex: 1, backgroundColor: colors.viewport, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  fill: { flex: 1, backgroundColor: colors.viewport },
  edges: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', padding: space(1) },
  edgeSides: { flexDirection: 'row', justifyContent: 'space-between' },
  edge: { color: colors.overlay, fontSize: type.small, fontWeight: '600', ...shadow },
  edgeTop: { position: 'absolute', top: space(1), left: 0, right: 0, textAlign: 'center' },
  edgeBottom: { position: 'absolute', bottom: space(1), left: 0, right: 0, textAlign: 'center' },
  tag: {
    position: 'absolute',
    top: space(1),
    left: space(1),
    paddingHorizontal: space(1.5),
    paddingVertical: space(1),
    borderRadius: 4,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  tagText: { fontSize: type.small, fontWeight: '600' },
  tagIndex: { color: colors.overlay, fontSize: type.small, fontVariant: ['tabular-nums'] },
  failed: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: space(4) },
  failedText: { color: colors.muted, fontSize: type.small, textAlign: 'center' },
});
