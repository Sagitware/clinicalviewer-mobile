/**
 * DICOMweb client (QIDO-RS + WADO-RS). All network access goes through here,
 * mirroring src/lib/dicomClient.js in the ClinicalView web workstation.
 */
import { fetch } from 'expo/fetch';
import { Tag, formatDate, formatPersonName, getNumber, getString, getStrings, type DicomJson } from './dicomJson';
import type { ServerConfig } from './settings';
import { openRemoteSeries, type SliceSource } from './sources';
import type { StudyServer } from './studyServer';

export interface StudySummary {
  studyUID: string;
  patientName: string;
  patientId: string;
  studyDate: string;
  description: string;
  modalities: string[];
  accession: string;
  instanceCount?: number;
}

export interface SeriesSummary {
  seriesUID: string;
  modality: string;
  description: string;
  number?: number;
  instanceCount?: number;
}

/** Explicit VR Little Endian: the server transcodes compressed frames for us. */
const UNCOMPRESSED_FRAME =
  'multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.1';
const ANY_FRAME = 'multipart/related; type="application/octet-stream"; transfer-syntax=*';
const UNCOMPRESSED_SYNTAXES = ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1'];

export class DicomwebClient implements StudyServer {
  private readonly base: string;

  constructor(private readonly cfg: ServerConfig) {
    this.base = cfg.baseUrl.trim().replace(/\/+$/, '');
  }

  get host(): string {
    return this.base.replace(/^https?:\/\//, '');
  }

  async searchStudies(query: { patientName?: string; limit?: number } = {}): Promise<StudySummary[]> {
    const params = new URLSearchParams();
    params.set('limit', String(query.limit ?? 50));
    for (const t of [Tag.StudyDescription, Tag.ModalitiesInStudy, Tag.NumberOfStudyRelatedInstances]) {
      params.append('includefield', t);
    }
    const name = query.patientName?.trim();
    if (name) {
      params.set('PatientName', `*${name}*`);
      params.set('fuzzymatching', 'true');
    }
    const rows = await this.json<DicomJson[]>(`/studies?${params.toString()}`);
    return rows
      .map((ds) => ({
        studyUID: getString(ds, Tag.StudyInstanceUID),
        patientName: formatPersonName(getString(ds, Tag.PatientName)),
        patientId: getString(ds, Tag.PatientID),
        studyDate: formatDate(getString(ds, Tag.StudyDate)),
        description: getString(ds, Tag.StudyDescription),
        modalities: getStrings(ds, Tag.ModalitiesInStudy),
        accession: getString(ds, Tag.AccessionNumber),
        instanceCount: getNumber(ds, Tag.NumberOfStudyRelatedInstances),
      }))
      .sort((a, b) => b.studyDate.localeCompare(a.studyDate));
  }

  async searchSeries(studyUID: string): Promise<SeriesSummary[]> {
    const params = new URLSearchParams();
    params.append('includefield', Tag.SeriesDescription);
    params.append('includefield', Tag.NumberOfSeriesRelatedInstances);
    const rows = await this.json<DicomJson[]>(`/studies/${studyUID}/series?${params.toString()}`);
    return rows
      .map((ds) => ({
        seriesUID: getString(ds, Tag.SeriesInstanceUID),
        modality: getString(ds, Tag.Modality),
        description: getString(ds, Tag.SeriesDescription),
        number: getNumber(ds, Tag.SeriesNumber),
        instanceCount: getNumber(ds, Tag.NumberOfSeriesRelatedInstances),
      }))
      .sort((a, b) => (a.number ?? 9999) - (b.number ?? 9999));
  }

  openSeries(study: StudySummary, series: SeriesSummary): Promise<SliceSource> {
    return openRemoteSeries(this, study, series);
  }

  seriesMetadata(studyUID: string, seriesUID: string): Promise<DicomJson[]> {
    return this.json<DicomJson[]>(`/studies/${studyUID}/series/${seriesUID}/metadata`);
  }

  /** Returns raw, uncompressed little-endian pixel bytes for one frame (1-based). */
  async frame(studyUID: string, seriesUID: string, sopUID: string, frame: number): Promise<Uint8Array> {
    const path = `/studies/${studyUID}/series/${seriesUID}/instances/${sopUID}/frames/${frame}`;
    let res = await this.request(path, UNCOMPRESSED_FRAME);
    if (res.status === 406 || res.status === 400) res = await this.request(path, ANY_FRAME);
    if (!res.ok) throw new Error(`Frame request failed (${res.status}) for ${path}`);

    const contentType = res.headers.get('content-type') ?? '';
    const body = new Uint8Array(await res.arrayBuffer());
    const part = extractFirstPart(body, contentType);
    const syntax = /transfer-syntax=([\d.]+)/i.exec(part.contentType || contentType)?.[1];
    if (syntax && !UNCOMPRESSED_SYNTAXES.includes(syntax)) {
      throw new Error(
        `The server sent compressed pixels (${syntax}). Enable transcoding on the DICOMweb server; see SETUP.md.`,
      );
    }
    return part.body;
  }

  async ping(): Promise<void> {
    await this.json<DicomJson[]>('/studies?limit=1');
  }

  private headers(accept: string): Record<string, string> {
    const h: Record<string, string> = { Accept: accept };
    if (this.cfg.username) h.Authorization = `Basic ${base64(`${this.cfg.username}:${this.cfg.password}`)}`;
    return h;
  }

  private request(path: string, accept: string) {
    return fetch(`${this.base}${path}`, { headers: this.headers(accept) });
  }

  private async json<T>(path: string): Promise<T> {
    let res;
    try {
      res = await this.request(path, 'application/dicom+json');
    } catch {
      throw new Error(`Cannot reach ${this.host}. Check the server address and that this device is on the same network.`);
    }
    if (res.status === 401 || res.status === 403) throw new Error('The server rejected the credentials. Update them under Server.');
    if (res.status === 204) return [] as T;
    if (!res.ok) throw new Error(`Server returned ${res.status} for ${path}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : []) as T;
  }
}

/* ---------- multipart/related parsing ---------- */

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function toAscii(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function lastIndexOf(hay: Uint8Array, needle: Uint8Array, minIndex: number): number {
  outer: for (let i = hay.length - needle.length; i >= minIndex; i--) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function extractFirstPart(body: Uint8Array, contentType: string): { contentType: string; body: Uint8Array } {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (!boundary) return { contentType, body };

  const delimiter = ascii(`--${boundary}`);
  const first = indexOf(body, delimiter, 0);
  if (first < 0) throw new Error('Malformed multipart response: boundary not found.');
  const headerStart = first + delimiter.length;
  const headerEnd = indexOf(body, ascii('\r\n\r\n'), headerStart);
  if (headerEnd < 0) throw new Error('Malformed multipart response: part headers not terminated.');
  const headers = toAscii(body.subarray(headerStart, headerEnd));
  const dataStart = headerEnd + 4;

  // Search from the end so pixel bytes never need to be scanned.
  const end = lastIndexOf(body, ascii(`\r\n--${boundary}`), dataStart);
  const partType = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1] ?? '';
  return { contentType: partType, body: body.subarray(dataStart, end < 0 ? body.length : end) };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(input: string): string {
  const bytes = utf8(input);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}
