import { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import {
  Canvas,
  FilterMode,
  Fill,
  Group,
  Image,
  ImageShader,
  MipmapMode,
  Rect,
  Shader,
  Skia,
} from '@shopify/react-native-skia';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useAnimatedReaction, useDerivedValue, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { GRAY_EFFECT, type LoadedFrame } from '../lib/skiaFrames';
import { colors } from '../theme';

export type Tool = 'window' | 'pan' | 'scroll';
const TOOL_INDEX: Record<Tool, number> = { window: 0, pan: 1, scroll: 2 };

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
  if (v.canvasW.value <= 0 || v.imgW.value <= 0) return;
  const s = Math.min(v.canvasW.value / v.imgW.value, v.canvasH.value / v.imgH.value);
  v.scale.value = s;
  v.tx.value = (v.canvasW.value - v.imgW.value * s) / 2;
  v.ty.value = (v.canvasH.value - v.imgH.value * s) / 2;
}

interface Props {
  frame: LoadedFrame | null;
  view: ViewState;
  tool: Tool;
  smooth: boolean;
  onStep: (delta: number) => void;
}

export function DicomViewport({ frame, view: v, tool, smooth, onStep }: Props) {
  const toolSV = useSharedValue(TOOL_INDEX[tool]);
  useEffect(() => {
    toolSV.value = TOOL_INDEX[tool];
  }, [tool, toolSV]);

  const stepRef = useRef(onStep);
  stepRef.current = onStep;
  const step = useCallback((d: number) => stepRef.current(d), []);

  const panStart = useSharedValue({ wc: 0, ww: 0, tx: 0, ty: 0, steps: 0 });
  const pinchStart = useSharedValue({ s: 1, tx: 0, ty: 0, fx: 0, fy: 0, k: 1, n: 2 });
  // A one-finger pan that started before the second finger landed stays active through the
  // pinch and would overwrite its position, so it's paused until every finger lifts.
  const panning = useSharedValue(false);
  const pinched = useSharedValue(false);

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .maxPointers(1)
      .minDistance(2)
      .onBegin(() => {
        pinched.value = false;
      })
      .onStart(() => {
        panStart.value = { wc: v.wc.value, ww: v.ww.value, tx: v.tx.value, ty: v.ty.value, steps: 0 };
        panning.value = true;
      })
      .onUpdate((e) => {
        if (pinched.value) return;
        const start = panStart.value;
        const mode = toolSV.value;
        if (mode === 0) {
          // Horizontal drag = width, vertical drag = level. Sensitivity follows the current width.
          const k = Math.max(start.ww / 300, 0.25);
          v.ww.value = Math.max(1, start.ww + e.translationX * k);
          v.wc.value = start.wc + e.translationY * k;
        } else if (mode === 1) {
          v.tx.value = start.tx + e.translationX;
          v.ty.value = start.ty + e.translationY;
        } else {
          const steps = Math.trunc(e.translationY / STEP_PX);
          if (steps !== start.steps) {
            scheduleOnRN(step, steps - start.steps);
            panStart.value = { ...start, steps };
          }
        }
      })
      .onFinalize(() => {
        panning.value = false;
      });

    // Pinch zooms about the fingers and also pans as they move, in every tool.
    const pinch = Gesture.Pinch()
      .onStart((e) => {
        pinched.value = true;
        // Undo what the pan did in its first few pixels before the second finger landed.
        if (panning.value) {
          const start = panStart.value;
          if (toolSV.value === 0) {
            v.ww.value = start.ww;
            v.wc.value = start.wc;
          } else if (toolSV.value === 1) {
            v.tx.value = start.tx;
            v.ty.value = start.ty;
          }
        }
        pinchStart.value = {
          s: v.scale.value,
          tx: v.tx.value,
          ty: v.ty.value,
          fx: e.focalX,
          fy: e.focalY,
          k: e.scale,
          n: e.numberOfPointers,
        };
      })
      .onUpdate((e) => {
        const p = pinchStart.value;
        // When a finger lifts, the focal point jumps to the remaining finger. Skip those updates,
        // and re-anchor when the finger count changes so the image doesn't jump.
        if (e.numberOfPointers !== p.n) {
          pinchStart.value = {
            s: v.scale.value,
            tx: v.tx.value,
            ty: v.ty.value,
            fx: e.focalX,
            fy: e.focalY,
            k: e.scale,
            n: e.numberOfPointers,
          };
          return;
        }
        if (e.numberOfPointers < 2) return;
        const s = Math.min(Math.max((p.s * e.scale) / p.k, 0.1), 40);
        const r = s / p.s;
        v.scale.value = s;
        v.tx.value = e.focalX - (p.fx - p.tx) * r;
        v.ty.value = e.focalY - (p.fy - p.ty) * r;
      });

    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .onEnd(() => fitView(v));

    return Gesture.Simultaneous(pan, pinch, doubleTap);
  }, [v, toolSV, panStart, pinchStart, panning, pinched, step]);

  const transform = useDerivedValue(() => [
    { translateX: v.tx.value },
    { translateY: v.ty.value },
    { scale: v.scale.value },
  ]);

  const gray = frame?.kind === 'gray' ? frame : null;
  const width = gray?.width ?? 1;
  const height = gray?.height ?? 1;
  const offset = gray?.offset ?? 0;
  const slope = gray?.slope ?? 1;
  const intercept = gray?.intercept ?? 0;
  const smoothFlag = smooth ? 1 : 0;

  const uniforms = useDerivedValue(
    () => ({
      size: [width, height],
      wc: v.wc.value,
      ww: v.ww.value,
      slope,
      intercept,
      offset,
      invert: v.invert.value,
      smooth: smoothFlag,
    }),
    [width, height, slope, intercept, offset, smoothFlag],
  );

  const rect = useMemo(() => Skia.XYWHRect(0, 0, width, height), [width, height]);

  // Fit on the UI thread once both the canvas and the image sizes are known, in either order.
  useAnimatedReaction(
    () => v.canvasW.value + ':' + v.canvasH.value + ':' + v.imgW.value + ':' + v.imgH.value,
    (cur, prev) => {
      if (cur !== prev) fitView(v);
    },
  );

  const onLayout = (e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    const changed = v.canvasW.value !== w || v.canvasH.value !== h;
    v.canvasW.value = w;
    v.canvasH.value = h;
    // Re-centre whenever the viewport size settles or changes (rotation, toolbars appearing).
    if (changed) fitView(v);
  };

  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.fill} onLayout={onLayout} collapsable={false}>
        <Canvas style={styles.fill}>
          <Fill color={colors.viewport} />
          {frame ? (
            <Group transform={transform}>
              {frame.kind === 'gray' ? (
                <Rect x={0} y={0} width={frame.width} height={frame.height}>
                  <Shader source={GRAY_EFFECT} uniforms={uniforms}>
                    <ImageShader image={frame.hi} fit="none" rect={rect} sampling={NEAREST} />
                    <ImageShader image={frame.lo} fit="none" rect={rect} sampling={NEAREST} />
                  </Shader>
                </Rect>
              ) : (
                <Image
                  image={frame.image}
                  x={0}
                  y={0}
                  width={frame.width}
                  height={frame.height}
                  fit="fill"
                  sampling={smooth ? LINEAR : NEAREST}
                />
              )}
            </Group>
          ) : null}
        </Canvas>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.viewport },
});
