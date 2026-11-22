/**
 * Traditional DICOM (DIMSE) client: C-FIND to search, C-GET to retrieve, C-ECHO to test.
 * Each operation opens its own association and releases it when done.
 */
import type TcpSocketType from 'react-native-tcp-socket';
import dicomParser from 'dicom-parser';
import type { SeriesSummary, StudySummary } from './dicomClient';
import { formatDate, formatPersonName } from './dicomJson';
import { IMPLICIT_LE, VERIFICATION } from './dicomScpProtocol';
import {
  IMAGE_STORAGE_CLASSES,
  IMAGE_SYNTAXES,
  QUERY_SYNTAXES,
  STUDY_ROOT_FIND,
  STUDY_ROOT_GET,
  ScuAssociation,
  type ProposedContext,
  type QueryKey,
} from './dicomScu';
import type { ServerConfig } from './settings';
import type { DecodedFrame } from './pixels';
import { importDicomBuffers, type SliceSource } from './sources';
import { middleIndex } from './thumbnail';
import type { StudyServer } from './studyServer';

/** No bytes from the server for this long (including connecting) ends the operation. */
const IDLE_TIMEOUT_MS = 30_000;

const T = {
  SpecificCharacterSet: 0x00080005,
  StudyDate: 0x00080020,
  AccessionNumber: 0x00080050,
  QueryRetrieveLevel: 0x00080052,
  Modality: 0x00080060,
  ModalitiesInStudy: 0x00080061,
  StudyDescription: 0x00081030,
  SeriesDescription: 0x0008103e,
  PatientName: 0x00100010,
  PatientID: 0x00100020,
  StudyInstanceUID: 0x0020000d,
  SeriesInstanceUID: 0x0020000e,
  SOPInstanceUID: 0x00080018,
  InstanceNumber: 0x00200013,
  SeriesNumber: 0x00200011,
  NumberOfStudyRelatedInstances: 0x00201208,
  NumberOfSeriesRelatedInstances: 0x00201209,
};

export class DimseClient implements StudyServer {
  constructor(private readonly cfg: ServerConfig) {}

  get host(): string {
    return `${this.cfg.calledAe}@${this.cfg.host}:${this.cfg.port}`;
  }

  async ping(): Promise<void> {
    await this.run([{ abstractSyntax: VERIFICATION, transferSyntaxes: QUERY_SYNTAXES }], (a) => a.echo());
  }

  async searchStudies(query: { patientName?: string; limit?: number } = {}): Promise<StudySummary[]> {
    const name = query.patientName?.trim() ?? '';
    const keys: QueryKey[] = [
      [T.QueryRetrieveLevel, 'STUDY'],
      [T.StudyInstanceUID, '', true],
      [T.PatientName, name ? `*${name}*` : ''],
      [T.PatientID, ''],
      [T.StudyDate, ''],
      [T.AccessionNumber, ''],
      [T.StudyDescription, ''],
      [T.ModalitiesInStudy, ''],
      [T.NumberOfStudyRelatedInstances, ''],
    ];
    if (/[^\x20-\x7e]/.test(name)) keys.push([T.SpecificCharacterSet, 'ISO_IR 192']);
    const rows = await this.run([{ abstractSyntax: STUDY_ROOT_FIND, transferSyntaxes: QUERY_SYNTAXES }], (a) =>
      a.find(keys, query.limit ?? 50),
    );
    return rows
      .map(parseRow)
      .map((r) => ({
        studyUID: r.text(T.StudyInstanceUID),
        patientName: formatPersonName(r.text(T.PatientName)),
        patientId: r.text(T.PatientID),
        studyDate: formatDate(r.text(T.StudyDate)),
        description: r.text(T.StudyDescription),
        modalities: r.text(T.ModalitiesInStudy).split('\\').filter(Boolean),
        accession: r.text(T.AccessionNumber),
        instanceCount: r.number(T.NumberOfStudyRelatedInstances),
      }))
      .filter((s) => s.studyUID)
      .sort((a, b) => b.studyDate.localeCompare(a.studyDate));
  }

  async searchSeries(studyUID: string): Promise<SeriesSummary[]> {
    const keys: QueryKey[] = [
      [T.QueryRetrieveLevel, 'SERIES'],
      [T.StudyInstanceUID, studyUID, true],
      [T.SeriesInstanceUID, '', true],
      [T.Modality, ''],
      [T.SeriesDescription, ''],
      [T.SeriesNumber, ''],
      [T.NumberOfSeriesRelatedInstances, ''],
    ];
    const rows = await this.run([{ abstractSyntax: STUDY_ROOT_FIND, transferSyntaxes: QUERY_SYNTAXES }], (a) =>
      a.find(keys, 1000),
    );
    return rows
      .map(parseRow)
      .map((r) => ({
        seriesUID: r.text(T.SeriesInstanceUID),
        modality: r.text(T.Modality),
        description: r.text(T.SeriesDescription),
        number: r.number(T.SeriesNumber),
        instanceCount: r.number(T.NumberOfSeriesRelatedInstances),
      }))
      .filter((s) => s.seriesUID)
      .sort((a, b) => (a.number ?? 9999) - (b.number ?? 9999));
  }

  /** Retrieves the whole series into memory with C-GET, then decodes it like local files. */
  async openSeries(study: StudySummary, series: SeriesSummary): Promise<SliceSource> {
    const contexts: ProposedContext[] = [
      { abstractSyntax: STUDY_ROOT_GET, transferSyntaxes: QUERY_SYNTAXES },
      ...IMAGE_STORAGE_CLASSES.map((c) => ({ abstractSyntax: c, transferSyntaxes: IMAGE_SYNTAXES, scpRole: true })),
    ];
    const result = await this.run(contexts, (a) =>
      a.get([
        [T.QueryRetrieveLevel, 'SERIES'],
        [T.StudyInstanceUID, study.studyUID, true],
        [T.SeriesInstanceUID, series.seriesUID, true],
      ]),
    );
    if (result.files.length === 0) {
      if (result.failed > 0 || result.status === 0xa702) {
        const count = result.failed === 1 ? 'this image' : result.failed > 1 ? `these ${result.failed} images` : 'the images';
        throw new Error(
          `The server could not send ${count}. They are probably stored compressed: allow the PACS to transcode to uncompressed (Explicit or Implicit VR Little Endian). Non-image objects can't be shown either.`,
        );
      }
      throw new Error('The server sent no images for this series.');
    }
    const { series: parsed } = importDicomBuffers(result.files.map((bytes, i) => ({ name: `image-${i + 1}.dcm`, bytes })));
    if (parsed.length === 0) throw new Error('The images from the server could not be displayed.');
    return parsed.find((s) => s.uid === series.seriesUID)?.source ?? parsed[0].source;
  }

  /**
   * Finds the series' images (C-FIND at image level), then retrieves only the middle one by
   * instance number (C-GET), rather than the whole series.
   */
  async middleImage(study: StudySummary, series: SeriesSummary): Promise<DecodedFrame> {
    const rows = await this.run([{ abstractSyntax: STUDY_ROOT_FIND, transferSyntaxes: QUERY_SYNTAXES }], (a) =>
      a.find(
        [
          [T.QueryRetrieveLevel, 'IMAGE'],
          [T.StudyInstanceUID, study.studyUID, true],
          [T.SeriesInstanceUID, series.seriesUID, true],
          [T.SOPInstanceUID, '', true],
          [T.InstanceNumber, ''],
        ],
        5000,
      ),
    );
    const images = rows
      .map(parseRow)
      .map((r) => ({ sop: r.text(T.SOPInstanceUID), number: r.number(T.InstanceNumber) ?? 0 }))
      .filter((r) => r.sop)
      .sort((a, b) => a.number - b.number);
    if (images.length === 0) throw new Error('No images found in this series.');
    const pick = images[middleIndex(images.length)];

    const contexts: ProposedContext[] = [
      { abstractSyntax: STUDY_ROOT_GET, transferSyntaxes: QUERY_SYNTAXES },
      ...IMAGE_STORAGE_CLASSES.map((c) => ({ abstractSyntax: c, transferSyntaxes: IMAGE_SYNTAXES, scpRole: true })),
    ];
    const result = await this.run(contexts, (a) =>
      a.get([
        [T.QueryRetrieveLevel, 'IMAGE'],
        [T.StudyInstanceUID, study.studyUID, true],
        [T.SeriesInstanceUID, series.seriesUID, true],
        [T.SOPInstanceUID, pick.sop, true],
      ]),
    );
    if (result.files.length === 0) throw new Error('The server sent no image.');
    const { series: parsed } = importDicomBuffers(result.files.map((bytes, i) => ({ name: `image-${i + 1}.dcm`, bytes })));
    const source = parsed[0]?.source;
    if (!source) throw new Error('The image could not be read.');
    return source.load(middleIndex(source.count));
  }

  private async run<T>(contexts: ProposedContext[], op: (a: ScuAssociation) => Promise<T>): Promise<T> {
    let TcpSocket: typeof TcpSocketType;
    try {
      TcpSocket = (await import('react-native-tcp-socket')).default;
    } catch {
      throw new Error('Traditional DICOM servers need a development build that includes react-native-tcp-socket.');
    }
    const { host, port, calledAe, callingAe } = this.cfg;
    const where = `${host}:${port}`;

    return new Promise<T>((resolve, reject) => {
      let connected = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (error: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve(value as T);
      };

      const socket = TcpSocket.createConnection({ host, port }, () => {
        connected = true;
        assoc
          .associate({ calledAe, callingAe, contexts })
          .then(() => op(assoc))
          .then(
            async (value) => {
              await assoc.release().catch(() => undefined);
              settle(null, value);
            },
            (e: unknown) => {
              assoc.abort(e instanceof Error ? e.message : String(e));
              settle(e);
            },
          );
      });

      const assoc = new ScuAssociation({
        send: (bytes) => {
          socket.write(bytes);
        },
        close: () => socket.destroy(),
      });

      const armTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const message = connected
            ? `${where} stopped responding.`
            : `Cannot reach ${where}. Check the host, port, and that this device is on the same network.`;
          assoc.abort(message);
          settle(new Error(message));
        }, IDLE_TIMEOUT_MS);
      };
      armTimer();

      socket.on('data', (data) => {
        armTimer();
        assoc.push(typeof data === 'string' ? new Uint8Array(0) : new Uint8Array(data));
      });
      socket.on('error', (e) => {
        const message = connected
          ? `Connection to ${where} failed: ${e.message}`
          : `Cannot reach ${where}. Check the host, port, and that this device is on the same network.`;
        assoc.transportClosed(message);
        settle(new Error(message));
      });
      socket.on('close', () => assoc.transportClosed());
    });
  }
}

/** One C-FIND match, read as Implicit VR Little Endian (the only syntax queries are offered in). */
function parseRow(bytes: Uint8Array) {
  const ds = dicomParser.parseDicom(bytes, { TransferSyntaxUID: IMPLICIT_LE });
  const utf8 = (ds.string('x00080005') ?? '').includes('ISO_IR 192');
  const key = (tag: number) => `x${tag.toString(16).padStart(8, '0')}`;
  const text = (tag: number): string => {
    const el = ds.elements[key(tag)];
    if (!el || !el.length) return '';
    const raw = bytes.subarray(el.dataOffset, el.dataOffset + el.length);
    let s: string;
    if (utf8 && typeof TextDecoder !== 'undefined') s = new TextDecoder('utf-8').decode(raw);
    else s = String.fromCharCode(...raw);
    return s.replace(/[\0 ]+$/, '').trim();
  };
  const number = (tag: number) => {
    const n = Number.parseInt(text(tag), 10);
    return Number.isNaN(n) ? undefined : n;
  };
  return { text, number };
}
