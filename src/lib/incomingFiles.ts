import { useEffect, useRef } from 'react';
import { Linking } from 'react-native';
import { File } from 'expo-file-system';
import { importBytes, type LocalImportResult } from './sources';

/** Files handed to the app by Mail, Gmail, Files, or "Open in" arrive as file:// or content:// URLs. */
function isFileUrl(url: string): boolean {
  return url.startsWith('file://') || url.startsWith('content://');
}

function displayName(url: string): string {
  const last = decodeURIComponent(url.split('?')[0].split('/').pop() ?? '');
  // Android content URIs often end in an opaque id rather than a file name.
  return /\.[a-z0-9]{2,6}$/i.test(last) ? last : 'Attachment';
}

/** Reads the file into memory, then removes the copy iOS placed in the app's Inbox. */
export async function readIncomingFile(url: string): Promise<LocalImportResult> {
  const name = displayName(url);
  const file = new File(url);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return importBytes([{ name, bytes }]);
  } catch (e) {
    return { series: [], skipped: [{ name, reason: e instanceof Error ? e.message : 'Could not read the file' }] };
  } finally {
    if (url.startsWith('file://') && url.includes('/Inbox/')) {
      try {
        file.delete();
      } catch {
        // Already gone.
      }
    }
  }
}

/** Calls onFile for each file opened into the app, both at cold start and while running. */
export function useIncomingFiles(onFile: (url: string, name: string) => void) {
  const handled = useRef(new Set<string>());
  const callback = useRef(onFile);
  callback.current = onFile;

  useEffect(() => {
    const handle = (url: string | null | undefined) => {
      if (!url || !isFileUrl(url) || handled.current.has(url)) return;
      handled.current.add(url);
      callback.current(url, displayName(url));
    };
    Linking.getInitialURL().then(handle).catch(() => undefined);
    const sub = Linking.addEventListener('url', ({ url }) => handle(url));
    return () => sub.remove();
  }, []);
}
