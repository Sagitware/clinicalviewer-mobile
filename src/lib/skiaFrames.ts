import { AlphaType, ColorType, Skia, type SkImage } from '@shopify/react-native-skia';
import type { DecodedFrame } from './pixels';

export type LoadedFrame =
  | {
      kind: 'gray';
      width: number;
      height: number;
      hi: SkImage;
      lo: SkImage;
      offset: number;
      slope: number;
      intercept: number;
      windowCenter: number;
      windowWidth: number;
      invert: boolean;
      pixelSpacing?: [number, number];
    }
  | { kind: 'color'; width: number; height: number; image: SkImage; pixelSpacing?: [number, number] };

function makeImage(
  bytes: Uint8Array,
  width: number,
  height: number,
  colorType: ColorType,
  alphaType: AlphaType,
  bytesPerPixel: number,
): SkImage {
  const image = Skia.Image.MakeImage(
    { width, height, colorType, alphaType },
    Skia.Data.fromBytes(bytes),
    width * bytesPerPixel,
  );
  if (!image) throw new Error(`Could not create a ${width}x${height} image on this device.`);
  return image;
}

/** One byte plane (the high or low bytes of a grayscale frame) as an image the shader can sample. */
export function bytePlane(bytes: Uint8Array, width: number, height: number): SkImage {
  return makeImage(bytes, width, height, ColorType.Alpha_8, AlphaType.Premul, 1);
}

/** 1x1 stand-in for hi/lo before the first frame, so the shader can stay mounted. */
export const EMPTY_PLANE = bytePlane(new Uint8Array(1), 1, 1);

export function toLoadedFrame(d: DecodedFrame): LoadedFrame {
  if (d.kind === 'color') {
    return {
      kind: 'color',
      width: d.width,
      height: d.height,
      image: makeImage(d.rgba, d.width, d.height, ColorType.RGBA_8888, AlphaType.Opaque, 4),
      pixelSpacing: d.pixelSpacing,
    };
  }
  const { hi, lo, ...rest } = d;
  return {
    ...rest,
    hi: bytePlane(hi, d.width, d.height),
    lo: bytePlane(lo, d.width, d.height),
  };
}

/**
 * Modality values (after rescale) of a box of pixels, row by row, read back from the
 * frame's two planes exactly as the shader rebuilds them. Null if the read fails.
 */
export function readModalityValues(
  f: Extract<LoadedFrame, { kind: 'gray' }>,
  x: number,
  y: number,
  w: number,
  h: number,
): Float64Array | null {
  const info = { width: w, height: h, colorType: ColorType.Alpha_8, alphaType: AlphaType.Premul };
  const hi = f.hi.readPixels(x, y, info);
  const lo = f.lo.readPixels(x, y, info);
  if (!hi || !lo || hi.length < w * h || lo.length < w * h) return null;
  const out = new Float64Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = (hi[i] * 256 + lo[i] + f.offset) * f.slope + f.intercept;
  return out;
}

/**
 * Rebuilds the 16-bit stored value from two Alpha_8 planes, applies modality
 * rescale and the DICOM linear VOI function. Interpolation (when smooth) happens
 * on real values, not on packed bytes, so edges stay correct at any zoom.
 */
const GRAY_SKSL = `
uniform shader hi;
uniform shader lo;
uniform float2 size;
uniform float wc;
uniform float ww;
uniform float slope;
uniform float intercept;
uniform float offset;
uniform float invert;
uniform float smooth;

float decodeAt(float2 p) {
  float h = floor(hi.eval(p).a * 255.0 + 0.5);
  float l = floor(lo.eval(p).a * 255.0 + 0.5);
  return h * 256.0 + l;
}

half4 main(float2 xy) {
  float v;
  if (smooth > 0.5) {
    float2 p = xy - 0.5;
    float2 i = floor(p);
    float2 f = p - i;
    float2 a = clamp(i + 0.5, float2(0.5), size - 0.5);
    float2 b = clamp(i + 1.5, float2(0.5), size - 0.5);
    float top = mix(decodeAt(a), decodeAt(float2(b.x, a.y)), f.x);
    float bottom = mix(decodeAt(float2(a.x, b.y)), decodeAt(b), f.x);
    v = mix(top, bottom, f.y);
  } else {
    v = decodeAt(floor(xy) + 0.5);
  }
  v = (v + offset) * slope + intercept;
  float y = clamp((v - (wc - 0.5)) / max(ww - 1.0, 1.0) + 0.5, 0.0, 1.0);
  if (invert > 0.5) { y = 1.0 - y; }
  return half4(half3(y), 1.0);
}
`;

const effect = Skia.RuntimeEffect.Make(GRAY_SKSL);
if (!effect) throw new Error('Grayscale shader failed to compile.');
export const GRAY_EFFECT = effect;
