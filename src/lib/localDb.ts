/**
 * On-device library of imported DICOM files.
 * SQLite holds the indexed metadata; the original Part 10 files live on disk in the app's
 * document directory, so a saved series is opened by the same importer as freshly picked files.
 */
import { Directory, File, Paths } from "expo-file-system";
import * as SQLite from "expo-sqlite";
import type { NamedBytes } from "./archive";
import type { StoredInstance } from "./sources";

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
