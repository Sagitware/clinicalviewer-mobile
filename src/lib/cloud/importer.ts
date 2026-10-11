import type { NamedBytes } from '../archive';
import type { CloudEntry, CloudProvider } from './types';

/** Extensions that are never DICOM; everything else (including no extension) is tried. */
const NOT_DICOM = /\.(jpe?g|png|gif|bmp|tiff?|pdf|txt|md|csv|json|xml|html?|docx?|xlsx?|pptx?|mp4|mov|exe|ini|log|bat|sh|inf)$/i;

export const LIMITS = { files: 5000, bytes: 1_200_000_000 };

export interface Plan {
  files: CloudEntry[];
  bytes: number;
  truncated: boolean;
}

/** Expands selected folders recursively into a flat list of candidate files. */
export async function planImport(
  provider: CloudProvider,
  selection: CloudEntry[],
  onScan: (foldersScanned: number, filesFound: number) => void,
  signal: { cancelled: boolean },
): Promise<Plan> {
  const files: CloudEntry[] = [];
  const folders = selection.filter((e) => e.kind === 'folder');
  let truncated = false;
  let scanned = 0;
  for (const e of selection) if (e.kind === 'file' && !NOT_DICOM.test(e.name)) files.push(e);

  while (folders.length && !signal.cancelled) {
    const folder = folders.shift() as CloudEntry;
    for (const e of await provider.list(folder)) {
      if (e.kind === 'folder') folders.push(e);
      else if (!NOT_DICOM.test(e.name)) files.push(e);
    }
    onScan(++scanned, files.length);
    if (files.length >= LIMITS.files) {
      truncated = true;
      break;
    }
  }
  const kept = files.slice(0, LIMITS.files);
  return { files: kept, bytes: kept.reduce((s, f) => s + (f.size ?? 0), 0), truncated };
}

/** Downloads into memory, four at a time. Nothing touches the file system. */
export async function downloadAll(
  provider: CloudProvider,
  files: CloudEntry[],
  onProgress: (done: number, total: number) => void,
  controller: AbortController,
): Promise<{ items: NamedBytes[]; failed: { name: string; reason: string }[] }> {
  const items: NamedBytes[] = [];
  const failed: { name: string; reason: string }[] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < files.length && !controller.signal.aborted) {
      const f = files[next++];
      try {
        items.push({ name: f.name, bytes: await provider.download(f, controller.signal) });
      } catch (e) {
        if (controller.signal.aborted) return;
        failed.push({ name: f.name, reason: e instanceof Error ? e.message : String(e) });
      }
      onProgress(++done, files.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { items, failed };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
