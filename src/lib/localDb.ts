/**
 * On-device library of imported DICOM files.
 * SQLite holds the indexed metadata; the original Part 10 files live on disk in the app's
 * document directory, so a saved series is opened by the same importer as freshly picked files.
 */
import { Directory, File, FileMode, Paths } from "expo-file-system";
import dicomParser from "dicom-parser";
import * as SQLite from "expo-sqlite";
import type { NamedBytes } from "./archive";
import type { DecodedFrame } from "./pixels";
import { importDicomBuffers, sortSlices, type StoredInstance } from "./sources";
import { middleIndex } from "./thumbnail";

export interface SavedStudy {
  studyUid: string;
  patientName: string;
  studyDate: string;
  description: string;
  modalities: string[];
  seriesCount: number;
  instanceCount: number;
  bytes: number;
  importedAt: number;
}

export interface SavedSeries {
  seriesUid: string;
  description: string;
  modality: string;
  number: number | null;
  instanceCount: number;
}

const libraryDir = () => new Directory(Paths.document, "library");

/** Paths are stored relative to the library folder; the app's absolute container path can change. */
function fileFor(relativeName: string): File {
  return new File(libraryDir(), relativeName);
}

function safeName(sopUid: string): string {
  return `${sopUid.replace(/[^A-Za-z0-9._-]/g, "_")}.dcm`;
}

function removeFile(relativeName: string) {
  try {
    const f = fileFor(relativeName);
    if (f.exists) f.delete();
  } catch {
    // Already gone.
  }
}

let opening: Promise<SQLite.SQLiteDatabase> | null = null;

function database(): Promise<SQLite.SQLiteDatabase> {
  opening ??= SQLite.openDatabaseAsync("clinicalview.db")
    .then(async (db) => {
      libraryDir().create({ idempotent: true, intermediates: true });
      const cols = await db.getAllAsync<{ name: string }>(
        "PRAGMA table_info(instances)",
      );
      if (cols.some((c) => c.name === "data"))
        await db.execAsync("DROP TABLE instances");
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS instances (
          sop_uid TEXT PRIMARY KEY NOT NULL,
          study_uid TEXT NOT NULL,
          series_uid TEXT NOT NULL,
          patient_name TEXT NOT NULL,
          study_date TEXT NOT NULL,
          study_description TEXT NOT NULL,
          modality TEXT NOT NULL,
          series_description TEXT NOT NULL,
          series_number INTEGER,
          file_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          size INTEGER NOT NULL,
          imported_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_instances_study ON instances (study_uid);
        CREATE INDEX IF NOT EXISTS idx_instances_series ON instances (series_uid);
      `);
      return db;
    })
    .catch((e) => {
      opening = null;
      throw e;
    });
  return opening;
}

/** Saves files, replacing any already stored with the same SOP Instance UID. Returns the number saved. */
export async function saveInstances(
  instances: StoredInstance[],
): Promise<number> {
  if (instances.length === 0) return 0;
  const db = await database();
  const now = Date.now();
  const written: string[] = [];
  for (const i of instances) {
    const name = safeName(i.sopUid);
    const f = fileFor(name);
    f.create({ overwrite: true });
    await f.write(i.bytes);
    written.push(name);
  }
  try {
    await db.withTransactionAsync(async () => {
      const stmt = await db.prepareAsync(
        `INSERT OR REPLACE INTO instances (sop_uid, study_uid, series_uid, patient_name, study_date, study_description,
        modality, series_description, series_number, file_name, file_path, size, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      try {
        for (const [n, i] of instances.entries()) {
          await stmt.executeAsync([
            i.sopUid,
            i.studyUid,
            i.seriesUid,
            i.patientName,
            i.studyDate,
            i.studyDescription,
            i.modality,
            i.seriesDescription,
            i.seriesNumber,
            i.fileName,
            written[n],
            i.bytes.byteLength,
            now,
          ]);
        }
      } finally {
        await stmt.finalizeAsync();
      }
    });
  } catch (e) {
    written.forEach(removeFile);
    throw e;
  }
  return instances.length;
}

export async function listStudies(): Promise<SavedStudy[]> {
  const db = await database();
  const rows = await db.getAllAsync<{
    study_uid: string;
    patient_name: string;
    study_date: string;
    study_description: string;
    modalities: string;
    series_count: number;
    instance_count: number;
    bytes: number;
    imported_at: number;
  }>(
    `SELECT study_uid, MAX(patient_name) AS patient_name, MAX(study_date) AS study_date,
            MAX(study_description) AS study_description, GROUP_CONCAT(DISTINCT modality) AS modalities,
            COUNT(DISTINCT series_uid) AS series_count, COUNT(*) AS instance_count,
            SUM(size) AS bytes, MAX(imported_at) AS imported_at
     FROM instances GROUP BY study_uid ORDER BY imported_at DESC`,
  );
  return rows.map((r) => ({
    studyUid: r.study_uid,
    patientName: r.patient_name,
    studyDate: r.study_date,
    description: r.study_description,
    modalities: (r.modalities ?? "").split(",").filter(Boolean),
    seriesCount: r.series_count,
    instanceCount: r.instance_count,
    bytes: r.bytes,
    importedAt: r.imported_at,
  }));
}

export async function listSeries(studyUid: string): Promise<SavedSeries[]> {
  const db = await database();
  const rows = await db.getAllAsync<{
    series_uid: string;
    series_description: string;
    modality: string;
    series_number: number | null;
    instance_count: number;
  }>(
    `SELECT series_uid, MAX(series_description) AS series_description, MAX(modality) AS modality,
            MAX(series_number) AS series_number, COUNT(*) AS instance_count
     FROM instances WHERE study_uid = ? GROUP BY series_uid
     ORDER BY series_number IS NULL, series_number, series_description`,
    studyUid,
  );
  return rows.map((r) => ({
    seriesUid: r.series_uid,
    description: r.series_description,
    modality: r.modality,
    number: r.series_number,
    instanceCount: r.instance_count,
  }));
}

export async function loadSeriesFiles(
  seriesUid: string,
): Promise<NamedBytes[]> {
  const db = await database();
  const rows = await db.getAllAsync<{ file_name: string; file_path: string }>(
    "SELECT file_name, file_path FROM instances WHERE series_uid = ?",
    seriesUid,
  );
  const out: NamedBytes[] = [];
  for (const r of rows) {
    try {
      out.push({
        name: r.file_name,
        bytes: new Uint8Array(await fileFor(r.file_path).arrayBuffer()),
      });
    } catch {
      // File was removed outside the app; skip it.
    }
  }
  return out;
}

/** Enough of the start of a file to hold its header in practice; larger headers are read whole. */
const HEADER_BYTES = 16 * 1024;

/** The start of a file, or all of it when shorter. */
function readStart(file: File, length: number): Uint8Array {
  const handle = file.open(FileMode.ReadOnly);
  try {
    return handle.readBytesSync(length);
  } finally {
    handle.close();
  }
}

/** Where a stored file sits in its series, from its header alone. */
function headerRef(bytes: Uint8Array) {
  const ds = dicomParser.parseDicom(bytes, { untilTag: "x7fe00010" });
  const split = (tag: string) => ds.string(tag)?.split("\\").map(Number);
  const frames = Number(ds.intString("x00280008") ?? 1) || 1;
  return {
    instanceNumber: Number(ds.intString("x00200013") ?? 0) || 0,
    frame: 1,
    position: frames === 1 ? split("x00200032") : undefined,
    orientation: split("x00200037"),
  };
}

/**
 * The image in the middle of a stored series, for its thumbnail. Reads only the headers to
 * put the files in order (by position along the slices, else by instance number), then
 * decodes the one in the middle.
 */
export async function loadMiddleImage(seriesUid: string): Promise<DecodedFrame> {
  const db = await database();
  const rows = await db.getAllAsync<{ file_name: string; file_path: string }>(
    "SELECT file_name, file_path FROM instances WHERE series_uid = ? ORDER BY file_name",
    seriesUid,
  );
  if (rows.length === 0) throw new Error("No stored images.");
  const refs = [];
  for (const r of rows) {
    const file = fileFor(r.file_path);
    try {
      let ref;
      try {
        ref = headerRef(readStart(file, HEADER_BYTES));
      } catch {
        ref = headerRef(new Uint8Array(await file.arrayBuffer()));
      }
      refs.push({ ...ref, row: r, file });
    } catch {
      // Missing or unreadable file; leave it out.
    }
    // Let the list keep scrolling while a long series is read.
    if (refs.length % 50 === 0) await new Promise((done) => setTimeout(done, 0));
  }
  if (refs.length === 0) throw new Error("The stored images could not be read.");
  const pick = sortSlices(refs)[middleIndex(refs.length)];
  const bytes = new Uint8Array(await pick.file.arrayBuffer());
  const source = importDicomBuffers([{ name: pick.row.file_name, bytes }]).series[0]?.source;
  if (!source) throw new Error("The image could not be read.");
  return source.load(middleIndex(source.count));
}

export async function deleteStudy(studyUid: string): Promise<void> {
  const db = await database();
  const rows = await db.getAllAsync<{ file_path: string }>(
    "SELECT file_path FROM instances WHERE study_uid = ?",
    studyUid,
  );
  await db.runAsync("DELETE FROM instances WHERE study_uid = ?", studyUid);
  rows.forEach((r) => removeFile(r.file_path));
  await db.execAsync("PRAGMA wal_checkpoint(TRUNCATE)");
}

export async function clearLibrary(): Promise<void> {
  const db = await database();
  await db.runAsync("DELETE FROM instances");
  const dir = libraryDir();
  if (dir.exists) dir.delete();
  dir.create({ idempotent: true, intermediates: true });
  await db.execAsync("VACUUM");
}
