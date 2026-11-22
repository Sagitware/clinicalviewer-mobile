import { useCallback, useEffect, useMemo } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import {
  Canvas,
  FilterMode,
  Fill,
  Group,
  Image,
  ImageShader,
  MipmapMode,
  Path,
  Rect,
  Shader,
  Skia,
  usePathValue,
  type SkImage,
  type SkPath,
  type SkPathBuilder,
} from '@shopify/react-native-skia';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import {
  annotationPoints,
  describe,
  labelAnchor,
  type Annotation,
  type MeasureTool,
  type NewAnnotation,
  type Point,
} from '../lib/measure';
import { EMPTY_PLANE, GRAY_EFFECT, type LoadedFrame } from '../lib/skiaFrames';
import { colors, space, type } from '../theme';

/** What the grayscale layer draws: changed together so the planes never meet stale uniforms. */
interface GrayLayer {
  hi: SkImage;
  lo: SkImage;
  w: number;
  h: number;
  slope: number;
  intercept: number;
  offset: number;
}
/** Nothing to draw (no frame yet, or a colour frame): a zero-size rect. */
const EMPTY_LAYER: GrayLayer = { hi: EMPTY_PLANE, lo: EMPTY_PLANE, w: 0, h: 0, slope: 1, intercept: 0, offset: 0 };

export type Tool = 'window' | 'pan' | 'scroll' | MeasureTool;
const TOOL_INDEX: Record<Tool, number> = { window: 0, pan: 1, scroll: 2, length: 3, angle: 4, ellipse: 5, arrow: 6 };
const MODE_TOOL: MeasureTool[] = ['length', 'angle', 'ellipse', 'arrow'];
const FIRST_MEASURE_MODE = 3;
const ANGLE = 4;
const ELLIPSE = 5;
const ARROW = 6;
/** Taps this close to a shape (screen px) select it. */
const HIT_PX = 16;
/** Drags starting this close to a handle (screen px) move that point. */
const GRAB_PX = 22;
const HANDLE_RADIUS_PX = 5;
/** Drags shorter than this on screen are ignored (taps, jitter). */
const MIN_DRAG_PX = 6;
/** Gap between a label and its anchor. A plain number: worklets can't call space(), it isn't a worklet. */
const LABEL_OFFSET = space(2);

/** The shape being drawn, in image pixels. Angles keep their first arm (phase 2) between drags. */
interface Draft {
  mode: number;
  phase: 1 | 2;
  pts: number[];
  active: boolean;
}

/** A finished annotation as the UI thread sees it: tool mode and flat points (see annotationPoints). */
interface ShapePoints {
  id: string;
  mode: number;
  pts: number[];
}

/** While dragging a selected shape: the point index being moved (-1 = the whole shape) and where it started. */
interface EditDrag {
  index: number;
  start: number[];
  sx: number;
  sy: number;
}

/** Pixels of vertical drag per slice in scroll mode. */
const STEP_PX = 10;
const NEAREST = { filter: FilterMode.Nearest, mipmap: MipmapMode.None };
const LINEAR = { filter: FilterMode.Linear, mipmap: MipmapMode.None };

export interface ViewState {
  wc: SharedValue<number>;
  ww: SharedValue<number>;
  invert: SharedValue<number>;
  scale: SharedValue<number>;
  tx: SharedValue<number>;
  ty: SharedValue<number>;
  canvasW: SharedValue<number>;
  canvasH: SharedValue<number>;
  imgW: SharedValue<number>;
  imgH: SharedValue<number>;
}

export function useViewState(): ViewState {
  const wc = useSharedValue(40);
  const ww = useSharedValue(400);
  const invert = useSharedValue(0);
  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const canvasW = useSharedValue(0);
  const canvasH = useSharedValue(0);
  const imgW = useSharedValue(0);
  const imgH = useSharedValue(0);
  // Shared values are stable, so one object for the component's lifetime.
  return useMemo(
    () => ({ wc, ww, invert, scale, tx, ty, canvasW, canvasH, imgW, imgH }),
    [wc, ww, invert, scale, tx, ty, canvasW, canvasH, imgW, imgH],
  );
}

/** Fit the image to the viewport, centred. Callable from JS or the UI thread. */
export function fitView(v: ViewState) {
  'worklet';
  if (v.canvasW.get() <= 0 || v.imgW.get() <= 0) return;
  const s = Math.min(v.canvasW.get() / v.imgW.get(), v.canvasH.get() / v.imgH.get());
  v.scale.set(s);
  v.tx.set((v.canvasW.get() - v.imgW.get() * s) / 2);
  v.ty.set((v.canvasH.get() - v.imgH.get() * s) / 2);
}

interface Props {
  frame: LoadedFrame | null;
  view: ViewState;
  tool: Tool;
  smooth: boolean;
  modality: string;
  /** Measurements and annotations on the frame shown. */
  annotations: Annotation[];
  /** The annotation being edited; it gets handles and can be dragged. */
  selectedId: string | null;
  onStep: (delta: number) => void;
  onDraw: (annotation: NewAnnotation) => void;
  /** A tap on a shape (its id) or on empty image (null). */
  onSelect: (id: string | null) => void;
  /** New points for an annotation after a handle or the whole shape was dragged. */
  onEdit: (id: string, pts: number[]) => void;
}

export function DicomViewport({
  frame,
  view: v,
  tool,
  smooth,
  modality,
  annotations,
  selectedId,
  onStep,
  onDraw,
  onSelect,
  onEdit,
}: Props) {
  const toolSV = useSharedValue(TOOL_INDEX[tool]);
  const draft = useSharedValue<Draft | null>(null);
  useEffect(() => {
    toolSV.set(TOOL_INDEX[tool]);
    draft.set(null);
  }, [tool, toolSV, draft]);
  // A half-drawn angle belongs to the image it was started on.
  useEffect(() => {
    draft.set(null);
  }, [frame, draft]);

  // Copies of the annotations for hit-testing and dragging on the UI thread.
  const shapesSV = useSharedValue<ShapePoints[]>([]);
  const selectedSV = useSharedValue<ShapePoints | null>(null);
  const editDrag = useSharedValue<EditDrag | null>(null);
  useEffect(() => {
    const list = annotations.map((a) => ({ id: a.id, mode: TOOL_INDEX[a.kind], pts: annotationPoints(a) }));
    shapesSV.set(list);
    selectedSV.set(list.find((a) => a.id === selectedId) ?? null);
  }, [annotations, selectedId, shapesSV, selectedSV]);

  const commit = useCallback(
    (mode: number, pts: number[]) => {
      const p = (i: number): Point => ({ x: pts[i], y: pts[i + 1] });
      const kind = MODE_TOOL[mode - FIRST_MEASURE_MODE];
      if (kind === 'angle') onDraw({ kind, a: p(0), b: p(2), c: p(4) });
      else if (kind === 'arrow') onDraw({ kind, tip: p(0), tail: p(2), text: '' });
      else onDraw({ kind, a: p(0), b: p(2) });
    },
    [onDraw],
  );

  const panStart = useSharedValue({ wc: 0, ww: 0, tx: 0, ty: 0, steps: 0 });
  const pinchStart = useSharedValue({ s: 1, tx: 0, ty: 0, fx: 0, fy: 0, k: 1, n: 2 });
  // A one-finger pan that started before the second finger landed stays active through the
  // pinch and would overwrite its position, so it's paused until every finger lifts.
  const panning = useSharedValue(false);
  const pinched = useSharedValue(false);
  // Touches started since the last pinch ended; a double tap needs both of its taps to be new ones.
  const touchesSincePinch = useSharedValue(2);

  const gesture = useMemo(() => {
    const anchorPinch = (e: { focalX: number; focalY: number; scale: number; numberOfPointers: number }) => {
      'worklet';
      pinchStart.set({
        s: v.scale.get(),
        tx: v.tx.get(),
        ty: v.ty.get(),
        fx: e.focalX,
        fy: e.focalY,
        k: e.scale,
        n: e.numberOfPointers,
      });
    };

    const toImage = (sx: number, sy: number) => {
      'worklet';
      const s = v.scale.get();
      return [(sx - v.tx.get()) / s, (sy - v.ty.get()) / s];
    };

    const pan = Gesture.Pan()
      .maxPointers(1)
      .minDistance(2)
      .onBegin(() => {
        pinched.set(false);
        touchesSincePinch.set(touchesSincePinch.get() + 1);
      })
      .onStart((e) => {
        panStart.set({ wc: v.wc.get(), ww: v.ww.get(), tx: v.tx.get(), ty: v.ty.get(), steps: 0 });
        panning.set(true);
        // The drag only starts after a few pixels, so use where the finger went down.
        const [x0, y0] = toImage(e.x - e.translationX, e.y - e.translationY);
        // On the selected shape, in any tool: drag a handle, or the whole shape.
        const sel = selectedSV.get();
        editDrag.set(null);
        if (sel) {
          const grab = GRAB_PX / v.scale.get();
          let index = -2;
          for (let i = 0; i < sel.pts.length; i += 2) {
            if (Math.hypot(sel.pts[i] - x0, sel.pts[i + 1] - y0) <= grab) {
              index = i;
              break;
            }
          }
          if (index === -2 && hitShape(sel.mode, sel.pts, x0, y0, HIT_PX / v.scale.get())) index = -1;
          if (index !== -2) {
            editDrag.set({ index, start: sel.pts, sx: x0, sy: y0 });
            return;
          }
        }
        const mode = toolSV.get();
        if (mode < FIRST_MEASURE_MODE) return;
        const [x1, y1] = toImage(e.x, e.y);
        const d = draft.get();
        if (mode === ANGLE && d && d.mode === ANGLE && d.phase === 2) {
          draft.set({ ...d, pts: [d.pts[0], d.pts[1], d.pts[2], d.pts[3], x1, y1], active: true });
        } else {
          draft.set({ mode, phase: 1, pts: [x0, y0, x1, y1], active: true });
        }
      })
      .onUpdate((e) => {
        if (pinched.get()) return;
        const ed = editDrag.get();
        const sel = selectedSV.get();
        if (ed && sel) {
          const [x, y] = toImage(e.x, e.y);
          const pts = ed.start.slice();
          if (ed.index >= 0) {
            pts[ed.index] = x;
            pts[ed.index + 1] = y;
          } else {
            for (let i = 0; i < pts.length; i += 2) {
              pts[i] += x - ed.sx;
              pts[i + 1] += y - ed.sy;
            }
          }
          selectedSV.set({ ...sel, pts });
          return;
        }
        const start = panStart.get();
        const mode = toolSV.get();
        if (mode >= FIRST_MEASURE_MODE) {
          const d = draft.get();
          if (!d || !d.active) return;
          const [x, y] = toImage(e.x, e.y);
          const pts = d.pts.slice();
          pts[pts.length - 2] = x;
          pts[pts.length - 1] = y;
          draft.set({ ...d, pts });
        } else if (mode === 0) {
          // Horizontal drag = width, vertical drag = level. Sensitivity follows the current width.
          const k = Math.max(start.ww / 300, 0.25);
          v.ww.set(Math.max(1, start.ww + e.translationX * k));
          v.wc.set(start.wc + e.translationY * k);
        } else if (mode === 1) {
          v.tx.set(start.tx + e.translationX);
          v.ty.set(start.ty + e.translationY);
        } else if (mode === 2) {
          const steps = Math.trunc(e.translationY / STEP_PX);
          if (steps !== start.steps) {
            scheduleOnRN(onStep, steps - start.steps);
            panStart.set({ ...start, steps });
          }
        }
      })
      .onEnd(() => {
        if (editDrag.get()) {
          editDrag.set(null);
          const sel = selectedSV.get();
          if (sel) scheduleOnRN(onEdit, sel.id, sel.pts);
          return;
        }
        const d = draft.get();
        if (toolSV.get() < FIRST_MEASURE_MODE || pinched.get() || !d || !d.active) return;
        const n = d.pts.length;
        const dragged = Math.hypot(d.pts[n - 2] - d.pts[n - 4], d.pts[n - 1] - d.pts[n - 3]) * v.scale.get();
        if (dragged < MIN_DRAG_PX) {
          draft.set(d.phase === 2 ? { ...d, pts: d.pts.slice(0, 4), active: false } : null);
        } else if (d.mode === ANGLE && d.phase === 1) {
          // First arm done; the next drag draws the second arm from its end.
          draft.set({ ...d, phase: 2, active: false });
        } else {
          scheduleOnRN(commit, d.mode, d.pts);
          draft.set(null);
        }
      })
      .onFinalize(() => {
        panning.set(false);
      });

    // Pinch zooms about the fingers and also pans as they move, in every tool.
    const pinch = Gesture.Pinch()
      .onStart((e) => {
        pinched.set(true);
        // Zooming cancels a shape mid-drag (an angle keeps its finished first arm).
        const d = draft.get();
        if (d && d.active) draft.set(d.phase === 2 ? { ...d, pts: d.pts.slice(0, 4), active: false } : null);
        // ...and puts a shape being edited back where it was.
        const ed = editDrag.get();
        const sel = selectedSV.get();
        if (ed && sel) selectedSV.set({ ...sel, pts: ed.start });
        editDrag.set(null);
        // Undo what the pan did in its first few pixels before the second finger landed.
        if (panning.get()) {
          const start = panStart.get();
          if (toolSV.get() === 0) {
            v.ww.set(start.ww);
            v.wc.set(start.wc);
          } else if (toolSV.get() === 1) {
            v.tx.set(start.tx);
            v.ty.set(start.ty);
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
        const s = Math.min(Math.max((p.s * e.scale) / p.k, 0.1), 40);
        const r = s / p.s;
        v.scale.set(s);
        v.tx.set(e.focalX - (p.fx - p.tx) * r);
        v.ty.set(e.focalY - (p.fy - p.ty) * r);
      })
      .onEnd(() => {
        touchesSincePinch.set(0);
      });

    // Only a real double tap resets the view. Without limits, two quick pinches or short drags in a
    // row also count as a double tap (Tap allows movement by default) and the zoom snaps back on release.
    // A pinch's own touch can't be the first tap either.
    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .maxDistance(12)
      .maxDuration(250)
      .maxDelay(300)
      .onEnd((e, success) => {
        if (!success || e.numberOfPointers > 1 || touchesSincePinch.get() < 2) return;
        fitView(v);
      });

    // A single tap selects the annotation under the finger (top-most first), or clears the selection.
    // It waits for the double tap to fail, so double-tap-to-fit still works.
    const tap = Gesture.Tap()
      .maxDistance(12)
      .maxDuration(250)
      .onEnd((e, success) => {
        if (!success || e.numberOfPointers > 1) return;
        const [x, y] = toImage(e.x, e.y);
        const tol = HIT_PX / v.scale.get();
        const list = shapesSV.get();
        let hit: string | null = null;
        for (let i = list.length - 1; i >= 0; i--) {
          if (hitShape(list[i].mode, list[i].pts, x, y, tol)) {
            hit = list[i].id;
            break;
          }
        }
        scheduleOnRN(onSelect, hit);
      });

    return Gesture.Simultaneous(pan, pinch, Gesture.Exclusive(doubleTap, tap));
  }, [
    v,
    toolSV,
    panStart,
    pinchStart,
    panning,
    pinched,
    touchesSincePinch,
    draft,
    shapesSV,
    selectedSV,
    editDrag,
    onStep,
    onSelect,
    onEdit,
    commit,
  ]);

  const transform = useDerivedValue(() => [
    { translateX: v.tx.get() },
    { translateY: v.ty.get() },
    { scale: v.scale.get() },
  ]);

  // Everything the grayscale layer draws from (the two byte planes, their size and rescale) goes to
  // the canvas in ONE shared value. Passed as separate React props, the new planes and size arrived
  // a frame before the shader's derived uniforms caught up, so the first image of a series was drawn
  // once with the placeholder offset, slope and size: a white or flat flash.
  const layer = useSharedValue<GrayLayer>(EMPTY_LAYER);
  useEffect(() => {
    layer.set(
      frame?.kind === 'gray'
        ? { hi: frame.hi, lo: frame.lo, w: frame.width, h: frame.height, slope: frame.slope, intercept: frame.intercept, offset: frame.offset }
        : EMPTY_LAYER,
    );
  }, [frame, layer]);
  const smoothFlag = smooth ? 1 : 0;

  const uniforms = useDerivedValue(() => {
    const l = layer.get();
    return {
      size: [Math.max(l.w, 1), Math.max(l.h, 1)],
      wc: v.wc.get(),
      ww: v.ww.get(),
      slope: l.slope,
      intercept: l.intercept,
      offset: l.offset,
      invert: v.invert.get(),
      smooth: smoothFlag,
    };
  }, [smoothFlag]);
  const layerHi = useDerivedValue(() => layer.get().hi);
  const layerLo = useDerivedValue(() => layer.get().lo);
  const layerW = useDerivedValue(() => layer.get().w);
  const layerH = useDerivedValue(() => layer.get().h);

  // Constant on-screen line width at any zoom.
  const stroke = useDerivedValue(() => 1.5 / v.scale.get());
  const frameW = frame?.width ?? 1;
  const frameH = frame?.height ?? 1;
  const imageSize = Math.max(frameW, frameH);
  // Skia's hook for paths built on the UI thread: it reuses one builder made on the JS thread.
  const draftPath = usePathValue((path) => {
    'worklet';
    const d = draft.get();
    if (d) traceShape(path, d.mode, d.pts, imageSize);
  });
  const selectedPath = usePathValue((path) => {
    'worklet';
    const sel = selectedSV.get();
    if (sel) traceShape(path, sel.mode, sel.pts, imageSize);
  });
  const handlesPath = usePathValue((path) => {
    'worklet';
    const sel = selectedSV.get();
    if (!sel) return;
    const r = HANDLE_RADIUS_PX / v.scale.get();
    for (let i = 0; i < sel.pts.length; i += 2) path.addCircle(sel.pts[i], sel.pts[i + 1], r);
  });
  // The selected annotation is drawn from its live copy instead, so it follows a drag.
  const shapes = useMemo(
    () =>
      annotations
        .filter((a) => a.id !== selectedId)
        .map((a) => ({ id: a.id, path: annotationPath(a, imageSize) })),
    [annotations, selectedId, imageSize],
  );
  const cal = { pixelSpacing: frame?.pixelSpacing, modality };

  // Fit on the UI thread once both the canvas and the image sizes are known, in either order.
  useAnimatedReaction(
    () => v.canvasW.get() + ':' + v.canvasH.get() + ':' + v.imgW.get() + ':' + v.imgH.get(),
    (cur, prev) => {
      if (cur !== prev) fitView(v);
    },
  );

  const onLayout = (e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    const changed = v.canvasW.get() !== w || v.canvasH.get() !== h;
    v.canvasW.set(w);
    v.canvasH.set(h);
    // Re-centre whenever the viewport size settles or changes (rotation, toolbars appearing).
    if (changed) fitView(v);
  };

  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.fill} onLayout={onLayout} collapsable={false}>
        <Canvas style={styles.fill}>
          <Fill color={colors.viewport} />
          <Group transform={transform}>
            {/* Mounted before the first frame arrives (empty until then): a shader mounted in the same
                commit as its first real uniforms could keep the placeholder values and draw flat gray. */}
            <Rect x={0} y={0} width={layerW} height={layerH}>
              <Shader source={GRAY_EFFECT} uniforms={uniforms}>
                <ImageShader image={layerHi} fit="none" x={0} y={0} width={layerW} height={layerH} sampling={NEAREST} />
                <ImageShader image={layerLo} fit="none" x={0} y={0} width={layerW} height={layerH} sampling={NEAREST} />
              </Shader>
            </Rect>
            {frame?.kind === 'color' ? (
              <Image
                image={frame.image}
                x={0}
                y={0}
                width={frame.width}
                height={frame.height}
                fit="fill"
                sampling={smooth ? LINEAR : NEAREST}
              />
            ) : null}
            {shapes.map((s) => (
              <Path key={s.id} path={s.path} style="stroke" strokeWidth={stroke} color={colors.overlay} strokeCap="round" strokeJoin="round" />
            ))}
            <Path path={selectedPath} style="stroke" strokeWidth={stroke} color={colors.accent} strokeCap="round" strokeJoin="round" />
            <Path path={handlesPath} style="fill" color={colors.accent} />
            <Path path={draftPath} style="stroke" strokeWidth={stroke} color={colors.accent} strokeCap="round" strokeJoin="round" />
          </Group>
        </Canvas>
        {annotations.map((a) => {
          const lines = describe(a, cal);
          return lines.length ? <Label key={a.id} anchor={labelAnchor(a)} lines={lines} view={v} /> : null;
        })}
      </View>
    </GestureDetector>
  );
}

/** Measurement text that follows its anchor point through pan and zoom. */
function Label({ anchor, lines, view: v }: { anchor: Point; lines: string[]; view: ViewState }) {
  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: anchor.x * v.scale.get() + v.tx.get() + LABEL_OFFSET },
      { translateY: anchor.y * v.scale.get() + v.ty.get() - LABEL_OFFSET },
    ],
  }));
  return (
    <Animated.View pointerEvents="none" style={[styles.label, style]}>
      {lines.map((l, i) => (
        <Text key={i} style={styles.labelText}>
          {l}
        </Text>
      ))}
    </Animated.View>
  );
}

/** Outline of a finished annotation in image pixels. */
function annotationPath(a: Annotation, imageSize: number): SkPath {
  const path = Skia.PathBuilder.Make();
  traceShape(path, TOOL_INDEX[a.kind], annotationPoints(a), imageSize);
  return path.build();
}

/** Adds a shape's outline to a path. Runs on either thread; points as in annotationPoints. */
function traceShape(path: SkPathBuilder, mode: number, p: number[], imageSize: number) {
  'worklet';
  if (mode === ELLIPSE) {
    // A plain rect object: no Skia factory calls needed on the UI thread.
    path.addOval({ x: Math.min(p[0], p[2]), y: Math.min(p[1], p[3]), width: Math.abs(p[2] - p[0]), height: Math.abs(p[3] - p[1]) });
    return;
  }
  path.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) path.lineTo(p[i], p[i + 1]);
  if (mode === ARROW && p.length >= 4) {
    // Two barbs at ±30° from the shaft, at the tip (the first point).
    const dx = p[0] - p[2];
    const dy = p[1] - p[3];
    const len = Math.hypot(dx, dy) || 1;
    const head = Math.min(len * 0.4, imageSize * 0.03);
    const ux = dx / len;
    const uy = dy / len;
    const cos = Math.cos(Math.PI / 6);
    const sin = Math.sin(Math.PI / 6);
    path.moveTo(p[0] - head * (ux * cos - uy * sin), p[1] - head * (uy * cos + ux * sin));
    path.lineTo(p[0], p[1]);
    path.lineTo(p[0] - head * (ux * cos + uy * sin), p[1] - head * (uy * cos - ux * sin));
  }
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  'worklet';
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether (x, y) is on a shape: within tol of a line, or inside an ellipse (grown by tol). */
function hitShape(mode: number, p: number[], x: number, y: number, tol: number) {
  'worklet';
  if (mode === ELLIPSE) {
    const rx = Math.abs(p[2] - p[0]) / 2 + tol;
    const ry = Math.abs(p[3] - p[1]) / 2 + tol;
    const dx = (x - (p[0] + p[2]) / 2) / rx;
    const dy = (y - (p[1] + p[3]) / 2) / ry;
    return dx * dx + dy * dy <= 1;
  }
  for (let i = 0; i + 3 < p.length; i += 2) {
    if (distanceToSegment(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= tol) return true;
  }
  return false;
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.viewport },
  label: {
    position: 'absolute',
    left: 0,
    top: 0,
    paddingHorizontal: space(1.5),
    paddingVertical: space(0.5),
    borderRadius: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  labelText: { color: colors.overlay, fontSize: type.small, fontVariant: ['tabular-nums'] },
});
