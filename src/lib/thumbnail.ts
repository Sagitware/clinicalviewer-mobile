/**
 * Small preview images for the series list: a decoded frame, windowed and shrunk on the CPU to an
 * 8-bit RGBA picture a few dozen points across.
 */
import type { DecodedFrame } from './pixels';

export interface ThumbnailPixels {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Index of the image in the middle of a stack of `count`. */
export const middleIndex = (count: number) => Math.max(0, Math.floor((count - 1) / 2));

/**
 * Shrinks a frame to fit in `maxSize` × `maxSize` (never enlarges), keeping its shape. Grayscale
 * frames use their own window (from the file, else their full range), so they look as they
 * first do in the viewer. Each output pixel averages the block of source pixels it covers.
 */
export function thumbnailPixels(frame: DecodedFrame, maxSize = 128): ThumbnailPixels {
  const { width: sw, height: sh } = frame;
  if (sw < 1 || sh < 1) throw new Error('Empty image');
  const k = Math.min(1, maxSize / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * k));
  const height = Math.max(1, Math.round(sh * k));
  const rgba = new Uint8Array(width * height * 4);
  // Averaging every source pixel is wasteful on big images; a few samples per side is plenty.
  const samples = (n: number, out: number) => Math.max(1, Math.min(4, Math.floor(n / out)));
  const nx = samples(sw, width);
  const ny = samples(sh, height);

  let lowV = 0;
  let scale = 0;
  let invert = false;
  if (frame.kind === 'gray') {
    const w = Math.max(frame.windowWidth, 1);
    lowV = frame.windowCenter - w / 2;
    scale = 255 / w;
    invert = frame.invert;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < ny; j++) {
        const sy = Math.min(sh - 1, Math.floor(((y + (j + 0.5) / ny) * sh) / height));
        for (let i = 0; i < nx; i++) {
          const sx = Math.min(sw - 1, Math.floor(((x + (i + 0.5) / nx) * sw) / width));
          const p = sy * sw + sx;
          if (frame.kind === 'gray') {
            const stored = frame.hi[p] * 256 + frame.lo[p] + frame.offset;
            const v = (stored * frame.slope + frame.intercept - lowV) * scale;
            r += v < 0 ? 0 : v > 255 ? 255 : v;
          } else {
            r += frame.rgba[p * 4];
            g += frame.rgba[p * 4 + 1];
            b += frame.rgba[p * 4 + 2];
          }
        }
      }
      const n = nx * ny;
      const o = (y * width + x) * 4;
      if (frame.kind === 'gray') {
        const v = Math.round(r / n);
        const shade = invert ? 255 - v : v;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = shade;
      } else {
        rgba[o] = Math.round(r / n);
        rgba[o + 1] = Math.round(g / n);
        rgba[o + 2] = Math.round(b / n);
      }
      rgba[o + 3] = 255;
    }
  }
  return { width, height, rgba };
}
