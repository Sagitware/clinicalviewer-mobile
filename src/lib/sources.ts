/**
 * A SliceSource is an ordered stack of frames, from the server or from local files.
 * The viewer only knows this interface.
 */
import { File } from 'expo-file-system';
import { expandArchives, type NamedBytes } from './archive';
import dicomParser from 'dicom-parser';
import type { DicomwebClient, SeriesSummary, StudySummary } from './dicomClient';
import { Tag, formatDate, formatPersonName, getNumber, getNumbers, getString, type DicomJson } from './dicomJson';
import { decodeFrame, frameByteLength, type DecodedFrame, type PixelMeta } from './pixels';

export interface SliceSource {
  readonly count: number;
  readonly modality: string;
  readonly seriesDescription: string;
  readonly patientName: string;
  readonly studyDate: string;
  load(index: number): Promise<DecodedFrame>;
}

interface SliceRef {
  instanceNumber: number;
  frame: number;
  position?: number[];
  orientation?: number[];
}

/** Sort along the slice normal when geometry exists, else by instance number. */
function sortSlices<T extends SliceRef>(refs: T[]): T[] {
  const o = refs.find((r) => r.orientation?.length === 6)?.orientation;
  const geometric = o && refs.every((r) => r.position?.length === 3);
  if (o && geometric) {
    const n = [o[1] * o[5] - o[2] * o[4], o[2] * o[3] - o[0] * o[5], o[0] * o[4] - o[1] * o[3]];
    const key = (r: T) => (r.position as number[]).reduce((s, p, i) => s + p * n[i], 0);
    return [...refs].sort((a, b) => key(a) - key(b) || a.frame - b.frame);
  }
  return [...refs].sort((a, b) => a.instanceNumber - b.instanceNumber || a.frame - b.frame);
}

/* ---------- Remote (DICOMweb) ---------- */

function metaFromJson(ds: DicomJson): PixelMeta {
  return {
    rows: getNumber(ds, Tag.Rows) ?? 0,
    columns: getNumber(ds, Tag.Columns) ?? 0,
    bitsAllocated: getNumber(ds, Tag.BitsAllocated) ?? 16,
    bitsStored: getNumber(ds, Tag.BitsStored) ?? getNumber(ds, Tag.BitsAllocated) ?? 16,
    pixelRepresentation: getNumber(ds, Tag.PixelRepresentation) ?? 0,
    samplesPerPixel: getNumber(ds, Tag.SamplesPerPixel) ?? 1,
    planarConfiguration: getNumber(ds, Tag.PlanarConfiguration) ?? 0,
    photometric: getString(ds, Tag.PhotometricInterpretation) || 'MONOCHROME2',
    slope: getNumber(ds, Tag.RescaleSlope) ?? 1,
    intercept: getNumber(ds, Tag.RescaleIntercept) ?? 0,
    windowCenter: getNumber(ds, Tag.WindowCenter),
    windowWidth: getNumber(ds, Tag.WindowWidth),
  };
}

export async function openRemoteSeries(
  client: DicomwebClient,
  study: StudySummary,
  series: SeriesSummary,
): Promise<SliceSource> {
  const instances = await client.seriesMetadata(study.studyUID, series.seriesUID);
  type RemoteRef = SliceRef & { sop: string; meta: PixelMeta };
  const refs: RemoteRef[] = [];
  for (const ds of instances) {
    const meta = metaFromJson(ds);
    if (!meta.rows || !meta.columns) continue; // SR, KO, PR and other non-image objects
    const frames = getNumber(ds, Tag.NumberOfFrames) ?? 1;
    for (let f = 1; f <= frames; f++) {
      refs.push({
        sop: getString(ds, Tag.SOPInstanceUID),
        frame: f,
        meta,
        instanceNumber: getNumber(ds, Tag.InstanceNumber) ?? 0,
        position: frames === 1 ? getNumbers(ds, Tag.ImagePositionPatient) : undefined,
        orientation: getNumbers(ds, Tag.ImageOrientationPatient),
      });
    }
  }
  if (refs.length === 0) throw new Error('This series has no displayable images.');
  const sorted = sortSlices(refs);

  return {
    count: sorted.length,
    modality: series.modality,
    seriesDescription: series.description,
    patientName: study.patientName,
    studyDate: study.studyDate,
    async load(i) {
      const r = sorted[i];
      const bytes = await client.frame(study.studyUID, series.seriesUID, r.sop, r.frame);
      return decodeFrame(bytes, r.meta);
    },
  };
}

/* ---------- Local files (Part 10, uncompressed) ---------- */

export interface LocalSeries {
  uid: string;
  description: string;
  modality: string;
  source: SliceSource;
}

/** A displayable DICOM file with the metadata the local library indexes it by. */
export interface StoredInstance {
  sopUid: string;
  studyUid: string;
  seriesUid: string;
  patientName: string;
  studyDate: string;
  studyDescription: string;
  modality: string;
  seriesDescription: string;
  seriesNumber: number | null;
  fileName: string;
  bytes: Uint8Array;
}

export interface LocalImportResult {
  series: LocalSeries[];
  skipped: { name: string; reason: string }[];
  /** Every accepted file, for saving to the local library. */
  instances?: StoredInstance[];
}

const LOCAL_SYNTAXES = ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1'];

/** Parses in-memory DICOM Part 10 files (zips already expanded) and groups them by series. */
export function importDicomBuffers(files: NamedBytes[], initialSkipped: LocalImportResult['skipped'] = []): LocalImportResult {
  type LocalRef = SliceRef & { bytes: Uint8Array; meta: PixelMeta };
  const groups = new Map<
    string,
    { description: string; modality: string; patientName: string; studyDate: string; refs: LocalRef[] }
  >();
  const skipped: LocalImportResult['skipped'] = [...initialSkipped];
  const instances: StoredInstance[] = [];

  for (const file of files) {
    try {
      const bytes = file.bytes;
      const ds = dicomParser.parseDicom(bytes);
      const syntax = ds.string('x00020010') ?? '1.2.840.10008.1.2';
      const pixel = ds.elements.x7fe00010;
      if (!pixel) {
        skipped.push({ name: file.name, reason: 'No image data' });
        continue;
      }
      if (pixel.encapsulatedPixelData || !LOCAL_SYNTAXES.includes(syntax)) {
        skipped.push({ name: file.name, reason: `Compressed (${syntax}); load it through the server instead` });
        continue;
      }
      const num = (tag: string, fallback: number) => {
        const v = ds.uint16(tag);
        return v == null ? fallback : v;
      };
      const float = (tag: string) => {
        const v = ds.floatString(tag, 0);
        return v == null || Number.isNaN(v) ? undefined : v;
      };
      const meta: PixelMeta = {
        rows: num('x00280010', 0),
        columns: num('x00280011', 0),
        bitsAllocated: num('x00280100', 16),
        bitsStored: num('x00280101', num('x00280100', 16)),
        pixelRepresentation: num('x00280103', 0),
        samplesPerPixel: num('x00280002', 1),
        planarConfiguration: num('x00280006', 0),
        photometric: (ds.string('x00280004') ?? 'MONOCHROME2').trim(),
        slope: float('x00281053') ?? 1,
        intercept: float('x00281052') ?? 0,
        windowCenter: float('x00281050'),
        windowWidth: float('x00281051'),
      };
      const frameLen = frameByteLength(meta);
      const frames = Number(ds.intString('x00280008') ?? 1) || 1;
      const uid = ds.string('x0020000e') ?? file.name;
      const group = groups.get(uid) ?? {
        description: ds.string('x0008103e') ?? '',
        modality: ds.string('x00080060') ?? '',
        patientName: formatPersonName(ds.string('x00100010') ?? ''),
        studyDate: formatDate(ds.string('x00080020') ?? ''),
        refs: [],
      };
      groups.set(uid, group);
      const seriesNumber = ds.intString('x00200011');
      instances.push({
        sopUid: ds.string('x00080018') ?? `${uid}/${file.name}`,
        studyUid: ds.string('x0020000d') ?? 'unknown-study',
        seriesUid: uid,
        patientName: group.patientName,
        studyDate: group.studyDate,
        studyDescription: ds.string('x00081030') ?? '',
        modality: group.modality,
        seriesDescription: group.description,
        seriesNumber: seriesNumber == null || Number.isNaN(seriesNumber) ? null : seriesNumber,
        fileName: file.name,
        bytes,
      });
      const split = (tag: string) => ds.string(tag)?.split('\\').map(Number);
      for (let f = 0; f < frames; f++) {
        const start = pixel.dataOffset + f * frameLen;
        group.refs.push({
          bytes: bytes.subarray(start, start + frameLen),
          meta,
          frame: f + 1,
          instanceNumber: Number(ds.intString('x00200013') ?? 0) || 0,
          position: frames === 1 ? split('x00200032') : undefined,
          orientation: split('x00200037'),
        });
      }
    } catch {
      skipped.push({ name: file.name, reason: 'Not a DICOM file' });
    }
  }

  const series: LocalSeries[] = [];
  for (const [uid, g] of groups) {
    const sorted = sortSlices(g.refs);
    series.push({
      uid,
      description: g.description,
      modality: g.modality,
      source: {
        count: sorted.length,
        modality: g.modality,
        seriesDescription: g.description,
        patientName: g.patientName,
        studyDate: g.studyDate,
        load: async (i) => decodeFrame(sorted[i].bytes, sorted[i].meta),
      },
    });
  }
  return { series, skipped, instances };
}

/** Files picked with the system picker (device, iCloud, or any provider in the Files app). */
export async function importLocalFiles(files: { uri: string; name: string }[]): Promise<LocalImportResult> {
  const items: NamedBytes[] = [];
  const skipped: LocalImportResult['skipped'] = [];
  for (const f of files) {
    try {
      items.push({ name: f.name, bytes: new Uint8Array(await new File(f.uri).arrayBuffer()) });
    } catch (e) {
      skipped.push({ name: f.name, reason: e instanceof Error ? e.message : 'Could not read the file' });
    }
  }
  return importBytes(items, skipped);
}

/** Entry point for every import path: expands zips, then parses. */
export function importBytes(items: NamedBytes[], skipped: LocalImportResult['skipped'] = []): LocalImportResult {
  const { files, errors } = expandArchives(items);
  return importDicomBuffers(files, [...skipped, ...errors]);
}

const MAX_URL_BYTES = 1024 * 1024 * 1024;

/** Downloads a DICOM file or .zip from a direct http(s) link and imports it. */
export async function importFromUrl(rawUrl: string): Promise<LocalImportResult> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error('Enter a valid link starting with http:// or https://');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http:// and https:// links are supported.');
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_URL_BYTES) throw new Error('The file is larger than 1 GB.');
  const bytes = new Uint8Array(await res.arrayBuffer());
  const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
  return importBytes([{ name: last || 'download', bytes }]);
}
