import * as SecureStore from 'expo-secure-store';

/** Connection settings only. No patient data is ever persisted on the device. */
export interface ServerConfig {
  baseUrl: string;
  username: string;
  password: string;
}

const KEY = 'clinicalview.server';

export const defaultConfig: ServerConfig = {
  baseUrl: process.env.EXPO_PUBLIC_DICOMWEB_URL ?? 'http://192.168.1.20:8042/dicom-web',
  username: process.env.EXPO_PUBLIC_DICOMWEB_USER ?? '',
  password: '',
};

export async function loadConfig(): Promise<ServerConfig> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    return raw ? { ...defaultConfig, ...(JSON.parse(raw) as Partial<ServerConfig>) } : defaultConfig;
  } catch {
    return defaultConfig;
  }
}

export async function saveConfig(cfg: ServerConfig): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(cfg));
}
