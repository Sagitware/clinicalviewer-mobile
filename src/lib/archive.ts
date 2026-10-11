import { unzipSync } from 'fflate';

export interface NamedBytes {
  name: string;
  bytes: Uint8Array;
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export function isZip(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((b, i) => bytes[i] === b);
}

/** Skip macOS resource forks, directories and DICOMDIR index files. */
function keepEntry(path: string, data: Uint8Array): boolean {
  if (data.length === 0 || path.endsWith('/')) return false;
  if (path.includes('__MACOSX/') || path.split('/').pop()?.startsWith('._')) return false;
  if (/(^|\/)DICOMDIR$/i.test(path)) return false;
  return true;
}

/** Replaces any zip in the list with its entries (one level; nested zips are expanded too). */
export function expandArchives(items: NamedBytes[]): { files: NamedBytes[]; errors: { name: string; reason: string }[] } {
  const files: NamedBytes[] = [];
  const errors: { name: string; reason: string }[] = [];
  const queue = [...items];
  while (queue.length) {
    const item = queue.shift() as NamedBytes;
    if (!isZip(item.bytes)) {
      files.push(item);
      continue;
    }
    try {
      const entries = unzipSync(item.bytes);
      for (const [path, data] of Object.entries(entries)) {
        if (keepEntry(path, data)) queue.push({ name: `${item.name}/${path}`, bytes: data });
      }
    } catch (e) {
      errors.push({ name: item.name, reason: `Could not open zip: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return { files, errors };
}
