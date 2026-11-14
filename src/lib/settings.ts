import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

/** DICOMweb (QIDO/WADO over HTTP) or traditional DICOM networking (C-FIND / C-GET over TCP). */
export type ServerProtocol = 'dicomweb' | 'dimse';

/** Connection settings for one server. Only the fields for its protocol are used. */
export interface ServerConfig {
  id: string;
  /** Shown in the location menu; the address is used when empty. */
  name: string;
  protocol: ServerProtocol;
  // DICOMweb
  baseUrl: string;
  username: string;
  password: string;
  // Traditional DICOM
  host: string;
  port: number;
  /** The PACS's own AE title. */
  calledAe: string;
  /** This device's AE title, which the PACS must allow to query and retrieve. */
  callingAe: string;
}

/** Where studies are browsed from: the on-device library or a server id. */
export const LOCAL = 'local';

// Each server is its own keychain item (SecureStore values should stay small), listed by id in the index.
const INDEX_KEY = 'clinicalview.servers';
const serverKey = (id: string) => `clinicalview.server.${id}`;
const LOCATION_KEY = 'clinicalview.location';
// Single-server setting from earlier versions, migrated on first load.
const LEGACY_KEY = 'clinicalview.server';

export const DEFAULT_CALLING_AE = 'FIGDICOM';

export function newServer(protocol: ServerProtocol = 'dicomweb'): ServerConfig {
  return {
    id: Crypto.randomUUID(),
    name: '',
    protocol,
    baseUrl: '',
    username: '',
    password: '',
    host: '',
    port: 104,
    calledAe: '',
    callingAe: DEFAULT_CALLING_AE,
  };
}

export function serverHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}

/** Where the server is: the DICOMweb host, or host:port for traditional DICOM. */
export function serverAddress(s: ServerConfig): string {
  return s.protocol === 'dimse' ? (s.host ? `${s.host}:${s.port}` : '') : serverHost(s.baseUrl);
}

export function serverLabel(s: ServerConfig): string {
  return s.name.trim() || serverAddress(s) || 'Server';
}

const AE_TITLE = /^[\x20-\x5b\x5d-\x7e]{1,16}$/; // printable ASCII without backslash, at most 16

/** Why the settings can't be used yet, or null when they're complete. */
export function serverProblem(s: ServerConfig): string | null {
  if (s.protocol === 'dicomweb') return s.baseUrl.trim() ? null : 'Enter the DICOMweb address.';
  if (!s.host.trim()) return 'Enter the host.';
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return 'Enter a port between 1 and 65535.';
  if (!AE_TITLE.test(s.calledAe.trim())) return 'Enter the server AE title (up to 16 characters).';
  if (!AE_TITLE.test(s.callingAe.trim())) return 'Enter this device’s AE title (up to 16 characters).';
  return null;
}

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await SecureStore.getItemAsync(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function writeIndex(ids: string[]): Promise<void> {
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(ids));
}

/** First launch: bring over the old single server, or seed one from EXPO_PUBLIC_DICOMWEB_URL if set. */
async function migrate(): Promise<ServerConfig[]> {
  const legacy = await readJson<Partial<ServerConfig>>(LEGACY_KEY);
  const baseUrl = legacy?.baseUrl ?? process.env.EXPO_PUBLIC_DICOMWEB_URL ?? '';
  const servers: ServerConfig[] = [];
  if (baseUrl) {
    servers.push({
      ...newServer(),
      baseUrl,
      username: legacy?.username ?? process.env.EXPO_PUBLIC_DICOMWEB_USER ?? '',
      password: legacy?.password ?? '',
    });
  }
  for (const s of servers) await SecureStore.setItemAsync(serverKey(s.id), JSON.stringify(s));
  await writeIndex(servers.map((s) => s.id));
  if (legacy) await SecureStore.deleteItemAsync(LEGACY_KEY).catch(() => undefined);
  return servers;
}

export async function loadServers(): Promise<ServerConfig[]> {
  const ids = await readJson<string[]>(INDEX_KEY);
  if (!ids) return migrate().catch(() => []);
  const servers = await Promise.all(ids.map((id) => readJson<Partial<ServerConfig>>(serverKey(id))));
  // Servers saved before traditional DICOM support have no protocol; they are DICOMweb.
  return servers.filter((s) => s?.id).map((s) => ({ ...newServer(), ...s }) as ServerConfig);
}

/** Adds or updates a server. */
export async function saveServer(server: ServerConfig, servers: ServerConfig[]): Promise<ServerConfig[]> {
  await SecureStore.setItemAsync(serverKey(server.id), JSON.stringify(server));
  const exists = servers.some((s) => s.id === server.id);
  const next = exists ? servers.map((s) => (s.id === server.id ? server : s)) : [...servers, server];
  if (!exists) await writeIndex(next.map((s) => s.id));
  return next;
}

export async function deleteServer(id: string, servers: ServerConfig[]): Promise<ServerConfig[]> {
  const next = servers.filter((s) => s.id !== id);
  await writeIndex(next.map((s) => s.id));
  await SecureStore.deleteItemAsync(serverKey(id)).catch(() => undefined);
  return next;
}

/** The last location the user chose: LOCAL or a server id. */
export async function loadLocation(): Promise<string> {
  try {
    return (await SecureStore.getItemAsync(LOCATION_KEY)) ?? LOCAL;
  } catch {
    return LOCAL;
  }
}

export async function saveLocation(location: string): Promise<void> {
  await SecureStore.setItemAsync(LOCATION_KEY, location).catch(() => undefined);
}
