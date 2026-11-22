/**
 * Measurements and annotations on one image. Points are in image pixel coordinates
 * (0,0 is the top-left corner of the top-left pixel), so they stay put when zooming.
 * Pure TypeScript: no React Native or Skia imports.
 */

export type MeasureTool = 'length' | 'angle' | 'ellipse' | 'arrow';

export interface Point {
  x: number;
  y: number;
}

export interface RoiStats {
  /** Pixels inside the ellipse. */
  count: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
}

export type Annotation =
  | { id: string; kind: 'length'; a: Point; b: Point }
  /** Angle at b, between b→a and b→c. */
  | { id: string; kind: 'angle'; a: Point; b: Point; c: Point }
  /** Ellipse inscribed in the box with corners a and b. */
  | { id: string; kind: 'ellipse'; a: Point; b: Point; stats?: RoiStats }
  | { id: string; kind: 'arrow'; tip: Point; tail: Point; text: string };

/** An annotation before it gets an id (keeps each kind's own fields). */
export type NewAnnotation = Annotation extends infer A ? (A extends unknown ? Omit<A, 'id'> : never) : never;

/** What turns pixels into real units for one image. */
export interface Calibration {
  /** [row spacing, column spacing] in mm, when the image has it. */
  pixelSpacing?: [number, number];
  modality: string;
}

export const TOOL_LABELS: Record<MeasureTool, string> = {
  length: 'Length',
  angle: 'Angle',
  ellipse: 'Ellipse ROI',
  arrow: 'Arrow + label',
};

/** Distance in mm when the spacing is known, else in pixels. */
export function length(a: Point, b: Point, cal: Calibration): { value: number; unit: 'mm' | 'px' } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (cal.pixelSpacing) {
    const [row, col] = cal.pixelSpacing;
    return { value: Math.hypot(dx * col, dy * row), unit: 'mm' };
  }
  return { value: Math.hypot(dx, dy), unit: 'px' };
}

/** Angle at b in degrees (0–180), in physical space when pixels aren't square. */
export function angle(a: Point, b: Point, c: Point, cal: Calibration): number {
  const [row, col] = cal.pixelSpacing ?? [1, 1];
  const ux = (a.x - b.x) * col;
  const uy = (a.y - b.y) * row;
  const vx = (c.x - b.x) * col;
  const vy = (c.y - b.y) * row;
  const n = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (n === 0) return 0;
  const cos = Math.min(1, Math.max(-1, (ux * vx + uy * vy) / n));
  return (Math.acos(cos) * 180) / Math.PI;
}

export function ellipseBox(a: Point, b: Point) {
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}

/** Ellipse area in mm² (or px² without spacing). */
export function ellipseArea(a: Point, b: Point, cal: Calibration): { value: number; unit: 'mm²' | 'px²' } {
  const { x0, y0, x1, y1 } = ellipseBox(a, b);
  const rx = (x1 - x0) / 2;
  const ry = (y1 - y0) / 2;
  if (cal.pixelSpacing) {
    const [row, col] = cal.pixelSpacing;
    return { value: Math.PI * rx * col * ry * row, unit: 'mm²' };
  }
  return { value: Math.PI * rx * ry, unit: 'px²' };
}

/**
 * Statistics of the pixels whose centres fall inside the ellipse.
 * `read` returns the modality values (after rescale) for the clipped box, row by row.
 */
export function ellipseStats(
  a: Point,
  b: Point,
  imageWidth: number,
  imageHeight: number,
  read: (x: number, y: number, w: number, h: number) => ArrayLike<number> | null,
): RoiStats | undefined {
  const box = ellipseBox(a, b);
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const rx = (box.x1 - box.x0) / 2;
  const ry = (box.y1 - box.y0) / 2;
  if (rx < 0.5 || ry < 0.5) return undefined;
  const x = Math.max(0, Math.floor(box.x0));
  const y = Math.max(0, Math.floor(box.y0));
  const w = Math.min(imageWidth, Math.ceil(box.x1)) - x;
  const h = Math.min(imageHeight, Math.ceil(box.y1)) - y;
  if (w <= 0 || h <= 0) return undefined;
  const values = read(x, y, w, h);
  if (!values) return undefined;

  let count = 0;
  let sum = 0;
  let sumSq = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < h; j++) {
    const dy = (y + j + 0.5 - cy) / ry;
    for (let i = 0; i < w; i++) {
      const dx = (x + i + 0.5 - cx) / rx;
      if (dx * dx + dy * dy > 1) continue;
      const v = values[j * w + i];
      count++;
      sum += v;
      sumSq += v * v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (count === 0) return undefined;
  const mean = sum / count;
  return { count, mean, sd: Math.sqrt(Math.max(0, sumSq / count - mean * mean)), min, max };
}

/**
 * The editable points of an annotation as [x0, y0, x1, y1, ...]: the ends of a length, the three
 * points of an angle (vertex in the middle), the corners of an ellipse's box, an arrow's tip then tail.
 */
export function annotationPoints(ann: Annotation): number[] {
  switch (ann.kind) {
    case 'length':
    case 'ellipse':
      return [ann.a.x, ann.a.y, ann.b.x, ann.b.y];
    case 'angle':
      return [ann.a.x, ann.a.y, ann.b.x, ann.b.y, ann.c.x, ann.c.y];
    case 'arrow':
      return [ann.tip.x, ann.tip.y, ann.tail.x, ann.tail.y];
  }
}

/** The annotation moved to new points (same order as annotationPoints). Ellipse stats are dropped. */
export function withPoints(ann: Annotation, pts: number[]): Annotation {
  const p = (i: number): Point => ({ x: pts[i], y: pts[i + 1] });
  switch (ann.kind) {
    case 'length':
      return { ...ann, a: p(0), b: p(2) };
    case 'ellipse':
      return { ...ann, a: p(0), b: p(2), stats: undefined };
    case 'angle':
      return { ...ann, a: p(0), b: p(2), c: p(4) };
    case 'arrow':
      return { ...ann, tip: p(0), tail: p(2) };
  }
}

const fixed = (v: number, digits: number) => v.toFixed(digits);

/** Label lines shown next to an annotation. */
export function describe(ann: Annotation, cal: Calibration): string[] {
  switch (ann.kind) {
    case 'length': {
      const l = length(ann.a, ann.b, cal);
      return [`${fixed(l.value, l.value < 10 ? 2 : 1)} ${l.unit}`];
    }
    case 'angle':
      return [`${fixed(angle(ann.a, ann.b, ann.c, cal), 1)}°`];
    case 'ellipse': {
      const area = ellipseArea(ann.a, ann.b, cal);
      const lines = [`Area ${fixed(area.value, area.value < 100 ? 1 : 0)} ${area.unit}`];
      const s = ann.stats;
      if (s) {
        const unit = cal.modality === 'CT' ? ' HU' : '';
        lines.push(`Mean ${fixed(s.mean, 1)}${unit}  SD ${fixed(s.sd, 1)}`);
        lines.push(`Min ${fixed(s.min, 0)}  Max ${fixed(s.max, 0)}`);
      }
      return lines;
    }
    case 'arrow':
      return ann.text ? [ann.text] : [];
  }
}

/** Where the label sits, in image coordinates. */
export function labelAnchor(ann: Annotation): Point {
  switch (ann.kind) {
    case 'length':
      return ann.a.x > ann.b.x ? ann.a : ann.b;
    case 'angle':
      return ann.b;
    case 'ellipse':
      return { x: Math.max(ann.a.x, ann.b.x), y: Math.min(ann.a.y, ann.b.y) };
    case 'arrow':
      return ann.tail;
  }
}
