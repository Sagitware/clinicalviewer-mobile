/**
 * Turns uncompressed DICOM pixel data into GPU-friendly planes.
 *
 * Grayscale stored values (8 or 16 bit, signed or unsigned) are shifted by their
 * minimum so they fit in 0..65535, then split into a high-byte and low-byte plane.
 * Each plane becomes an Alpha_8 Skia image; alpha is never colour-managed, so the
 * shader can rebuild the exact integer and do rescale + window/level on the GPU.
 */
export interface PixelMeta {
  rows: number;
  columns: number;
  bitsAllocated: number;
  bitsStored: number;
  pixelRepresentation: number;
  samplesPerPixel: number;
  planarConfiguration: number;
  photometric: string;
  slope: number;
  intercept: number;
  windowCenter?: number;
  windowWidth?: number;
}

export interface GrayFrame {
  kind: 'gray';
  width: number;
  height: number;
  hi: Uint8Array;
  lo: Uint8Array;
  /** Added back to the decoded 16-bit value to recover the stored value. */
  offset: number;
  slope: number;
  intercept: number;
  windowCenter: number;
  windowWidth: number;
  invert: boolean;
}

export interface ColorFrame {
  kind: 'color';
  width: number;
  height: number;
  rgba: Uint8Array;
}

export type DecodedFrame = GrayFrame | ColorFrame;

export function frameByteLength(m: PixelMeta): number {
  return m.rows * m.columns * m.samplesPerPixel * (m.bitsAllocated / 8);
}

export function decodeFrame(bytes: Uint8Array, m: PixelMeta): DecodedFrame {
  if (m.samplesPerPixel === 1) return decodeGray(bytes, m);
  if (m.samplesPerPixel === 3 && m.bitsAllocated === 8) return decodeColor(bytes, m);
  throw new Error(
    `Unsupported pixel format: ${m.samplesPerPixel} samples per pixel at ${m.bitsAllocated} bits.`,
  );
}

function decodeGray(bytes: Uint8Array, m: PixelMeta): GrayFrame {
  if (m.bitsAllocated !== 8 && m.bitsAllocated !== 16) {
    throw new Error(`Unsupported bits allocated: ${m.bitsAllocated}. Only 8 and 16 are handled.`);
  }
  const n = m.rows * m.columns;
  const need = n * (m.bitsAllocated / 8);
  if (bytes.length < need) {
    throw new Error(
      `Pixel data is ${bytes.length} bytes but ${need} were expected. The frame may still be compressed.`,
    );
  }

  const bitsStored = Math.min(m.bitsStored || m.bitsAllocated, m.bitsAllocated);
  const mask = (1 << bitsStored) - 1;
  const signBit = 1 << (bitsStored - 1);
  const signed = m.pixelRepresentation === 1;
  const values = new Int32Array(n);
  let min = Infinity;
  let max = -Infinity;

  if (m.bitsAllocated === 16) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, need);
    for (let i = 0; i < n; i++) {
      let v = dv.getUint16(i * 2, true) & mask;
      if (signed && v & signBit) v -= mask + 1;
      values[i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  } else {
    for (let i = 0; i < n; i++) {
      let v = bytes[i] & mask;
      if (signed && v & signBit) v -= mask + 1;
      values[i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  const hi = new Uint8Array(n);
  const lo = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = values[i] - min;
    hi[i] = p >> 8;
    lo[i] = p & 0xff;
  }

  const a = min * m.slope + m.intercept;
  const b = max * m.slope + m.intercept;
  const lowValue = Math.min(a, b);
  const highValue = Math.max(a, b);
  const hasWindow = m.windowWidth != null && m.windowWidth > 1 && m.windowCenter != null;

  return {
    kind: 'gray',
    width: m.columns,
    height: m.rows,
    hi,
    lo,
    offset: min,
    slope: m.slope,
    intercept: m.intercept,
    windowCenter: hasWindow ? (m.windowCenter as number) : (lowValue + highValue) / 2,
    windowWidth: hasWindow ? (m.windowWidth as number) : Math.max(highValue - lowValue, 1),
    invert: m.photometric === 'MONOCHROME1',
  };
}

function decodeColor(bytes: Uint8Array, m: PixelMeta): ColorFrame {
  const n = m.rows * m.columns;
  if (bytes.length < n * 3) {
    throw new Error(`Colour pixel data is ${bytes.length} bytes but ${n * 3} were expected.`);
  }
  // Transcoded JPEG data arrives as RGB even when the header still says YBR_FULL_422,
  // so only true uncompressed YBR_FULL is converted here.
  const ybr = m.photometric === 'YBR_FULL';
  const planar = m.planarConfiguration === 1;
  const rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    let r = planar ? bytes[i] : bytes[i * 3];
    let g = planar ? bytes[n + i] : bytes[i * 3 + 1];
    let b = planar ? bytes[2 * n + i] : bytes[i * 3 + 2];
    if (ybr) {
      const y = r;
      const cb = g - 128;
      const cr = b - 128;
      r = clamp255(y + 1.402 * cr);
      g = clamp255(y - 0.344136 * cb - 0.714136 * cr);
      b = clamp255(y + 1.772 * cb);
    }
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return { kind: 'color', width: m.columns, height: m.rows, rgba };
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
