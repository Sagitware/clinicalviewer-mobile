/**
 * Helpers for DICOM JSON (PS3.18 F.2) as returned by QIDO-RS / WADO-RS metadata.
 */
export type DicomJsonElement = { vr?: string; Value?: unknown[]; BulkDataURI?: string };
export type DicomJson = Record<string, DicomJsonElement>;

export const Tag = {
  StudyDate: '00080020',
  AccessionNumber: '00080050',
  ModalitiesInStudy: '00080061',
  Modality: '00080060',
  StudyDescription: '00081030',
  SeriesDescription: '0008103E',
  SOPInstanceUID: '00080018',
  PatientName: '00100010',
  PatientID: '00100020',
  StudyInstanceUID: '0020000D',
  SeriesInstanceUID: '0020000E',
  SeriesNumber: '00200011',
  InstanceNumber: '00200013',
  ImagePositionPatient: '00200032',
  ImageOrientationPatient: '00200037',
  ImagerPixelSpacing: '00181164',
  PixelSpacing: '00280030',
  NumberOfStudyRelatedInstances: '00201208',
  NumberOfSeriesRelatedInstances: '00201209',
  SamplesPerPixel: '00280002',
  PhotometricInterpretation: '00280004',
  PlanarConfiguration: '00280006',
  NumberOfFrames: '00280008',
  Rows: '00280010',
  Columns: '00280011',
  BitsAllocated: '00280100',
  BitsStored: '00280101',
  PixelRepresentation: '00280103',
  WindowCenter: '00281050',
  WindowWidth: '00281051',
  RescaleIntercept: '00281052',
  RescaleSlope: '00281053',
} as const;

export function getString(ds: DicomJson | undefined, tag: string): string {
  const v = ds?.[tag]?.Value?.[0];
  if (v == null) return '';
  if (typeof v === 'object') return (v as { Alphabetic?: string }).Alphabetic ?? '';
  return String(v);
}

export function getStrings(ds: DicomJson | undefined, tag: string): string[] {
  return (ds?.[tag]?.Value ?? []).map((v) => String(v));
}

export function getNumbers(ds: DicomJson | undefined, tag: string): number[] {
  const out: number[] = [];
  for (const v of ds?.[tag]?.Value ?? []) {
    // Some servers send DS/IS as backslash-joined strings.
    for (const part of String(v).split('\\')) {
      const n = Number(part);
      if (part.trim() !== '' && Number.isFinite(n)) out.push(n);
    }
  }
  return out;
}

export function getNumber(ds: DicomJson | undefined, tag: string): number | undefined {
  return getNumbers(ds, tag)[0];
}

/** "DOE^JANE^M" -> "DOE, JANE M" */
export function formatPersonName(raw: string): string {
  const [family = '', given = '', middle = ''] = raw.split('^');
  const rest = [given, middle].filter(Boolean).join(' ');
  return [family, rest].filter(Boolean).join(', ') || 'Anonymous';
}

/** "20240131" -> "2024-01-31" */
export function formatDate(raw: string): string {
  return /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
}
