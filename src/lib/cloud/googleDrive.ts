import { fetch } from 'expo/fetch';
import type { GoogleSignin as GoogleSigninApi } from '@react-native-google-signin/google-signin';
import { isExpoGo } from '../runtime';
import { AuthExpiredError, SignInCancelled, type CloudEntry, type CloudProvider } from './types';

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const API = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '';
const WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '';

/**
 * Loaded on first use, never at startup: the library looks up its native module on
 * import, which would crash Expo Go where that module doesn't exist.
 */
let sdk: typeof GoogleSigninApi | null = null;
function google(): typeof GoogleSigninApi {
  if (!sdk) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sdk = (require('@react-native-google-signin/google-signin') as { GoogleSignin: typeof GoogleSigninApi }).GoogleSignin;
  }
  return sdk;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
}

class GoogleDriveProvider implements CloudProvider {
  readonly id = 'gdrive' as const;
  readonly label = 'Google Drive';
  readonly configured = !isExpoGo && Boolean(IOS_CLIENT_ID || WEB_CLIENT_ID);
  private email: string | null = null;
  private ready = false;

  private setup() {
    if (this.ready) return;
    google().configure({
      scopes: [SCOPE],
      iosClientId: IOS_CLIENT_ID || undefined,
      webClientId: WEB_CLIENT_ID || undefined,
    });
    this.ready = true;
  }

  account() {
    return this.email;
  }

  async restore(): Promise<boolean> {
    if (!this.configured) return false;
    this.setup();
    if (!google().hasPreviousSignIn()) return false;
    const res = await google().signInSilently().catch(() => null);
    if (res?.type !== 'success' || !res.data.scopes.includes(SCOPE)) return false;
    this.email = res.data.user.email;
    return true;
  }

  async signIn(): Promise<void> {
    this.setup();
    await google().hasPlayServices({ showPlayServicesUpdateDialog: true });
    let res = await google().signIn();
    if (res.type !== 'success') throw new SignInCancelled();
    if (!res.data.scopes.includes(SCOPE)) {
      const added = await google().addScopes({ scopes: [SCOPE] });
      if (!added || added.type !== 'success') throw new Error('Drive access was not granted.');
      res = added;
    }
    this.email = res.data.user.email;
  }

  async signOut(): Promise<void> {
    this.setup();
    await google().signOut();
    this.email = null;
  }

  async list(folder: CloudEntry | null): Promise<CloudEntry[]> {
    const parent = folder?.id ?? 'root';
    const out: CloudEntry[] = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q: `'${parent}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size)',
        orderBy: 'folder, name',
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await this.request(`${API}/files?${params.toString()}`);
      const body = (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
      for (const f of body.files) {
        if (f.mimeType === FOLDER) out.push({ id: f.id, name: f.name, kind: 'folder' });
        // Google Docs, Sheets and shortcuts have no binary content to download.
        else if (!f.mimeType.startsWith('application/vnd.google-apps.')) {
          out.push({ id: f.id, name: f.name, kind: 'file', size: f.size ? Number(f.size) : undefined });
        }
      }
      pageToken = body.nextPageToken ?? '';
    } while (pageToken);
    return out;
  }

  async download(file: CloudEntry, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await this.request(`${API}/files/${file.id}?alt=media&supportsAllDrives=true`, signal);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async request(url: string, signal?: AbortSignal) {
    this.setup();
    let token: string;
    try {
      token = (await google().getTokens()).accessToken;
    } catch {
      this.email = null;
      throw new AuthExpiredError(this.label);
    }
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
    if (res.status === 401) {
      await google().clearCachedAccessToken(token).catch(() => null);
      this.email = null;
      throw new AuthExpiredError(this.label);
    }
    if (!res.ok) throw new Error(`Google Drive returned ${res.status}.`);
    return res;
  }
}

export const googleDrive = new GoogleDriveProvider();
