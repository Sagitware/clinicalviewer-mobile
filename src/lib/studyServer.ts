/** What the study and series screens need from a server, whether DICOMweb or traditional DICOM. */
import { DicomwebClient, type SeriesSummary, type StudySummary } from './dicomClient';
import { DimseClient } from './dimseClient';
import type { ServerConfig } from './settings';
import type { DecodedFrame } from './pixels';
import type { SliceSource } from './sources';

export interface StudyServer {
  /** Short address for headers, for example "pacs.example.org" or "ORTHANC@10.0.0.5:4242". */
  readonly host: string;
  searchStudies(query?: { patientName?: string; limit?: number }): Promise<StudySummary[]>;
  searchSeries(studyUID: string): Promise<SeriesSummary[]>;
  openSeries(study: StudySummary, series: SeriesSummary): Promise<SliceSource>;
  /** The image in the middle of the series, fetched on its own, for the series list thumbnail. */
  middleImage(study: StudySummary, series: SeriesSummary): Promise<DecodedFrame>;
  /** Throws with a readable message when the server can't be reached or refuses. */
  ping(): Promise<void>;
}

export function createStudyServer(cfg: ServerConfig): StudyServer {
  return cfg.protocol === 'dimse' ? new DimseClient(cfg) : new DicomwebClient(cfg);
}
