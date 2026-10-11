/** Storage SCP service: listens on a TCP port and saves received C-STORE objects to the local library. */
import type TcpSocketType from 'react-native-tcp-socket';
import * as SecureStore from 'expo-secure-store';
import { ScpAssociation, Status, type ReceivedObject } from './dicomScpProtocol';
import { saveInstances } from './localDb';
import { importDicomBuffers } from './sources';

export interface ScpConfig {
  /** Start listening automatically when the app opens. */
  autoStart: boolean;
  port: number;
}

export const defaultScpConfig: ScpConfig = { autoStart: false, port: 11112 };
const KEY = 'clinicalview.scp';

export async function loadScpConfig(): Promise<ScpConfig> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    return raw ? { ...defaultScpConfig, ...(JSON.parse(raw) as Partial<ScpConfig>) } : defaultScpConfig;
  } catch {
    return defaultScpConfig;
  }
}

export async function saveScpConfig(cfg: ScpConfig): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(cfg));
}

export interface ScpState {
  running: boolean;
  port: number | null;
  address: string | null;
  activeAssociations: number;
  received: number;
  lastFrom: string | null;
  error: string | null;
}

const idle: ScpState = { running: false, port: null, address: null, activeAssociations: 0, received: 0, lastFrom: null, error: null };
let state: ScpState = idle;
let server: ReturnType<typeof TcpSocketType.createServer> | null = null;
const stateListeners = new Set<(s: ScpState) => void>();
const storedListeners = new Set<() => void>();

function update(patch: Partial<ScpState>) {
  state = { ...state, ...patch };
  stateListeners.forEach((l) => l(state));
}

export const getScpState = () => state;

export function subscribeScp(listener: (s: ScpState) => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/** Notifies when received images have been added to the library. */
export function onScpStored(listener: () => void): () => void {
  storedListeners.add(listener);
  return () => storedListeners.delete(listener);
}

async function store(obj: ReceivedObject): Promise<number> {
  const { instances } = importDicomBuffers([{ name: `${obj.sopInstanceUid}.dcm`, bytes: obj.file }]);
  if (!instances || instances.length === 0) return Status.CannotUnderstand;
  await saveInstances(instances);
  update({ received: state.received + 1, lastFrom: obj.callingAe });
  storedListeners.forEach((l) => l());
  return Status.Success;
}

export async function startScp(port: number): Promise<void> {
  if (server) return;
  // Loaded lazily so the app still starts where the native modules are missing (Expo Go / old dev build).
  let TcpSocket: typeof TcpSocketType;
  try {
    TcpSocket = require('react-native-tcp-socket').default;
  } catch {
    const message = 'Receiving needs a development build that includes react-native-tcp-socket. Rebuild the app.';
    update({ error: message });
    throw new Error(message);
  }
  const created = TcpSocket.createServer((socket) => {
    const assoc = new ScpAssociation({
      send: (bytes) => {
        socket.write(bytes);
      },
      close: () => socket.end(),
      onObject: store,
      onError: (e) => update({ error: e.message }),
    });
    update({ activeAssociations: state.activeAssociations + 1 });
    socket.on('data', (data) => assoc.push(typeof data === 'string' ? new Uint8Array(0) : new Uint8Array(data)));
    socket.on('error', (e) => update({ error: e.message }));
    socket.on('close', () => {
      assoc.dispose();
      update({ activeAssociations: Math.max(0, state.activeAssociations - 1) });
    });
  });
  created.on('error', (e) => {
    server = null;
    update({ ...idle, received: state.received, error: e.message });
  });
  server = created;
  await new Promise<void>((resolve, reject) => {
    created.once('error', reject);
    created.listen({ port, host: '0.0.0.0', reuseAddress: true }, () => resolve());
  }).catch((e) => {
    server = null;
    update({ error: e instanceof Error ? e.message : String(e) });
    throw e;
  });
  let address: string | null = null;
  try {
    address = await (require('expo-network') as typeof import('expo-network')).getIpAddressAsync();
  } catch {}
  update({ running: true, port, address: address === '0.0.0.0' ? null : address, error: null });
}

export function stopScp(): void {
  server?.close();
  server = null;
  update({ ...idle, received: state.received, lastFrom: state.lastFrom });
}
