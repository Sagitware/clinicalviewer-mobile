/**
 * A stack of parallel slices as one block of voxels, and the three orthogonal views cut from it
 * (multiplanar reconstruction). Pure TypeScript: no React Native or Skia imports.
 *
 * Voxel axes: 0 runs along an image row (column index), 1 down a column (row index), 2 through
 * the slices. Patient directions are DICOM's: +x is the patient's left, +y their back, +z their head.
 */
import type { DecodedFrame } from './pixels';

export type Vec3 = [number, number, number];
export type Axis = 0 | 1 | 2;

/** Where one slice sits in the patient: ImagePositionPatient and ImageOrientationPatient. */
export interface SliceGeometry {
  position?: number[];
  orientation?: number[];
}

export interface StackGeometry {
  /** Unit direction in the patient of each voxel axis. */
  axes: [Vec3, Vec3, Vec3];
  /** Millimetres between slice centres. */
  sliceSpacing: number;
}

export interface Volume {
  /** Voxels along each axis. */
  size: Vec3;
  /** Millimetres per voxel along each axis. */
  spacing: Vec3;
  axes: [Vec3, Vec3, Vec3];
  /** High and low bytes of every voxel's shifted stored value (see pixels.ts), axis 0 fastest. */
  hi: Uint8Array;
  lo: Uint8Array;
  offset: number;
  slope: number;
  intercept: number;
  /** How much each slice was shrunk in both directions to fit in memory (1 = not at all). */
  reduction: number;
}

export const MIN_SLICES = 3;
/** Two bytes each, so about 256 MB. Larger stacks are shrunk within each slice. */
export const MAX_VOXELS = 128 * 1024 * 1024;
const MAX_REDUCTION = 8;
const LOAD_CONCURRENCY = 6;

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function unit(v: number[]): Vec3 | null {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-6 ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

const finite = (v: number[] | undefined, n: number): v is number[] => v?.length === n && v.every(Number.isFinite);

/**
 * Checks that slices (already in stack order) form a regular block: parallel, evenly spaced and
 * stacked straight. Returns the block's geometry, or why it can't be reconstructed.
 */
export function stackGeometry(slices: SliceGeometry[] | undefined): StackGeometry | { problem: string } {
  if (!slices || slices.length < MIN_SLICES) {
    return { problem: `MPR needs a stack of at least ${MIN_SLICES} slices.` };
  }
  if (!slices.every((s) => finite(s.position, 3) && finite(s.orientation, 6))) {
    return { problem: "This series doesn't record where its slices are in the patient, so they can't be stacked into a volume." };
  }
  const first = slices[0].orientation as number[];
  const row = unit(first.slice(0, 3));
  const col = unit(first.slice(3, 6));
  const normal = row && col && unit([row[1] * col[2] - row[2] * col[1], row[2] * col[0] - row[0] * col[2], row[0] * col[1] - row[1] * col[0]]);
  if (!row || !col || !normal) return { problem: 'The slice orientation in this series is not valid.' };
  if (slices.some((s) => (s.orientation as number[]).some((v, i) => Math.abs(v - first[i]) > 0.01))) {
    return { problem: "The slices in this series aren't parallel, so they can't be stacked into a volume." };
  }

  const depth = slices.map((s) => dot(s.position as number[], normal));
  const gaps = depth.slice(1).map((d, i) => d - depth[i]);
  const median = [...gaps].sort((a, b) => a - b)[gaps.length >> 1];
  // Positions are often rounded, so gaps wobble a little; a missing or repeated slice is far outside this.
  if (!(median > 1e-4) || gaps.some((g) => g < median * 0.8 || g > median * 1.2)) {
    return { problem: 'The slices are not evenly spaced (some may be missing or repeated), so MPR would be distorted.' };
  }
  const origin = slices[0].position as number[];
  const sideways = Math.min(1, median);
  for (const s of slices) {
    const p = s.position as number[];
    const d = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
    if (Math.hypot(dot(d, row), dot(d, col)) > sideways) {
      return { problem: 'The slices are shifted sideways from one another (for example a tilted CT gantry), which MPR does not correct for.' };
    }
  }
  return { axes: [row, col, normal], sliceSpacing: (depth[depth.length - 1] - depth[0]) / (slices.length - 1) };
}

/** The smallest whole factor to shrink each slice by so the block stays within maxVoxels. */
export function reductionFor(width: number, height: number, slices: number, maxVoxels = MAX_VOXELS): number {
  for (let f = 1; f <= MAX_REDUCTION; f++) {
    if (Math.floor(width / f) * Math.floor(height / f) * slices <= maxVoxels) return f;
  }
  throw new Error('This series is too large to reconstruct on this device.');
}

export interface VolumeSource {
  readonly count: number;
  load(index: number): Promise<DecodedFrame>;
}

/**
 * Loads every slice into one block. Resolves with null if `token.cancelled` is set meanwhile.
 * Rejects when the slices can't share a block (colour, mixed sizes or mixed rescale values).
 */
export async function loadVolume(
  source: VolumeSource,
  geometry: StackGeometry,
  onProgress: (loaded: number) => void,
  token: { cancelled: boolean },
  maxVoxels = MAX_VOXELS,
): Promise<Volume | null> {
  const first = await source.load(0);
  if (token.cancelled) return null;
  if (first.kind !== 'gray') throw new Error('MPR works on grayscale series only.');
  if (!first.pixelSpacing) {
    throw new Error("This series has no pixel spacing, so MPR can't give its views the right proportions.");
  }
  const { width, height } = first;
  const [rowSpacing, colSpacing] = first.pixelSpacing;
  const f = reductionFor(width, height, source.count, maxVoxels);
  const w = Math.floor(width / f);
  const h = Math.floor(height / f);
  const plane = w * h;
  const hi = new Uint8Array(plane * source.count);
  const lo = new Uint8Array(plane * source.count);

  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  const place = (frame: DecodedFrame, k: number) => {
    const mismatch = (what: string) =>
      new Error(`Image ${k + 1} doesn't match the rest of the series (${what}), so the slices can't be stacked.`);
    if (frame.kind !== 'gray') throw mismatch('it is in colour');
    if (frame.width !== width || frame.height !== height) throw mismatch(`${frame.width}×${frame.height} instead of ${width}×${height}`);
    if (frame.offset !== first.offset || !close(frame.slope, first.slope) || !close(frame.intercept, first.intercept)) {
      throw mismatch('different rescale values');
    }
    if (!frame.pixelSpacing || !close(frame.pixelSpacing[0], rowSpacing) || !close(frame.pixelSpacing[1], colSpacing)) {
      throw mismatch('different pixel spacing');
    }
    const at = k * plane;
    if (f === 1) {
      hi.set(frame.hi, at);
      lo.set(frame.lo, at);
      return;
    }
    // Average each f×f block of real values, then split into bytes again.
    const n = f * f;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let dy = 0; dy < f; dy++) {
          let p = (y * f + dy) * width + x * f;
          for (let dx = 0; dx < f; dx++, p++) sum += frame.hi[p] * 256 + frame.lo[p];
        }
        const v = Math.round(sum / n);
        hi[at + y * w + x] = v >> 8;
        lo[at + y * w + x] = v & 0xff;
      }
    }
  };

  place(first, 0);
  let loaded = 1;
  onProgress(loaded);
  let next = 1;
  let failed = false;
  let lastPause = Date.now();
  const worker = async () => {
    while (!token.cancelled && !failed) {
      const k = next++;
      if (k >= source.count) return;
      try {
        const frame = await source.load(k);
        if (token.cancelled || failed) return;
        place(frame, k);
      } catch (e) {
        failed = true;
        throw e;
      }
      onProgress(++loaded);
      // Local files decode without ever waiting, so step aside regularly to let the screen update.
      if (Date.now() - lastPause > 12) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        lastPause = Date.now();
      }
    }
  };
  await Promise.all(Array.from({ length: LOAD_CONCURRENCY }, worker));
  if (token.cancelled) return null;

  return {
    size: [w, h, source.count],
    spacing: [colSpacing * f, rowSpacing * f, geometry.sliceSpacing],
    axes: geometry.axes,
    hi,
    lo,
    offset: first.offset,
    slope: first.slope,
    intercept: first.intercept,
    reduction: f,
  };
}

/* ---------- The three views ---------- */

export type PlaneName = 'axial' | 'coronal' | 'sagittal';

/** One view: the voxel axis it looks along, and how the other two are laid out on screen. */
export interface Plane {
  name: PlaneName;
  /** The axis this view looks along; its index picks the cut. */
  fixed: Axis;
  /** The axes drawn across and down the screen. */
  h: Axis;
  v: Axis;
  /** Whether that axis runs right-to-left / bottom-to-top on screen. */
  flipH: boolean;
  flipV: boolean;
  /** Patient direction at each edge of the view, for example L, A or SP. */
  edges: { left: string; right: string; top: string; bottom: string };
}

/**
 * Radiological convention per view: which patient axis the view looks along, which one runs across
 * the screen (always towards its positive end: patient's left, or back) and which one runs down.
 */
const CONVENTION: { name: PlaneName; along: Axis; across: Axis; down: Axis; downSign: 1 | -1 }[] = [
  { name: 'axial', along: 2, across: 0, down: 1, downSign: 1 }, // left on the right, back at the bottom
  { name: 'coronal', along: 1, across: 0, down: 2, downSign: -1 }, // left on the right, feet at the bottom
  { name: 'sagittal', along: 0, across: 1, down: 2, downSign: -1 }, // back on the right, feet at the bottom
];

const LETTERS = [
  ['R', 'L'],
  ['A', 'P'],
  ['I', 'S'],
];

/** Patient direction letters for a vector, strongest first (two when it is clearly oblique). */
export function directionLetters(d: ArrayLike<number>): string {
  return [0, 1, 2]
    .filter((i) => Math.abs(d[i]) > 0.3)
    .sort((a, b) => Math.abs(d[b]) - Math.abs(d[a]))
    .slice(0, 2)
    .map((i) => LETTERS[i][d[i] > 0 ? 1 : 0])
    .join('');
}

/** Pairs each patient axis with the voxel axis closest to it, each used once. */
function matchAxes(axes: [Vec3, Vec3, Vec3]): [Axis, Axis, Axis] {
  const all: Axis[] = [0, 1, 2];
  const result: Axis[] = [0, 1, 2];
  const voxelUsed = new Set<Axis>();
  const patientUsed = new Set<Axis>();
  for (let round = 0; round < 3; round++) {
    let best = -1;
    let pick: [Axis, Axis] = [0, 0];
    for (const a of all) {
      if (voxelUsed.has(a)) continue;
      for (const p of all) {
        if (patientUsed.has(p)) continue;
        const strength = Math.abs(axes[a][p]);
        if (strength > best) {
          best = strength;
          pick = [a, p];
        }
      }
    }
    voxelUsed.add(pick[0]);
    patientUsed.add(pick[1]);
    result[pick[1]] = pick[0];
  }
  return result as [Axis, Axis, Axis];
}

/** The axial, coronal and sagittal views of a block, however it was acquired. */
export function planesFor(axes: [Vec3, Vec3, Vec3]): Plane[] {
  const voxelAxis = matchAxes(axes);
  return CONVENTION.map((c) => {
    const h = voxelAxis[c.across];
    const v = voxelAxis[c.down];
    const flipH = axes[h][c.across] < 0;
    const flipV = axes[v][c.down] * c.downSign < 0;
    const right = axes[h].map((x) => (flipH ? -x : x));
    const bottom = axes[v].map((x) => (flipV ? -x : x));
    return {
      name: c.name,
      fixed: voxelAxis[c.along],
      h,
      v,
      flipH,
      flipV,
      edges: {
        left: directionLetters(right.map((x) => -x)),
        right: directionLetters(right),
        top: directionLetters(bottom.map((x) => -x)),
        bottom: directionLetters(bottom),
      },
    };
  });
}

export interface Reslice {
  width: number;
  height: number;
  hi: Uint8Array;
  lo: Uint8Array;
}

/** The image a view shows when cut at voxel index `at` along its fixed axis. */
export function reslice(vol: Volume, plane: Plane, at: number): Reslice {
  const stride = [1, vol.size[0], vol.size[0] * vol.size[1]];
  const width = vol.size[plane.h];
  const height = vol.size[plane.v];
  const hi = new Uint8Array(width * height);
  const lo = new Uint8Array(width * height);
  const stepH = plane.flipH ? -stride[plane.h] : stride[plane.h];
  const stepV = plane.flipV ? -stride[plane.v] : stride[plane.v];
  const cut = Math.min(vol.size[plane.fixed] - 1, Math.max(0, Math.round(at)));
  let row =
    cut * stride[plane.fixed] +
    (plane.flipH ? (width - 1) * stride[plane.h] : 0) +
    (plane.flipV ? (height - 1) * stride[plane.v] : 0);
  let out = 0;
  for (let y = 0; y < height; y++, row += stepV) {
    if (stepH === 1) {
      // Rows of the original slices are contiguous: copy them whole.
      hi.set(vol.hi.subarray(row, row + width), out);
      lo.set(vol.lo.subarray(row, row + width), out);
      out += width;
    } else {
      for (let x = 0, p = row; x < width; x++, p += stepH, out++) {
        hi[out] = vol.hi[p];
        lo[out] = vol.lo[p];
      }
    }
  }
  return { width, height, hi, lo };
}
