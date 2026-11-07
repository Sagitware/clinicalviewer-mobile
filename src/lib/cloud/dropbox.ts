import { fetch } from 'expo/fetch';
import * as AuthSession from 'expo-auth-session';
import { isExpoGo } from '../runtime';
import { AuthExpiredError, SignInCancelled, type CloudEntry, type CloudProvider } from './types';

const APP_KEY = process.env.EXPO_PUBLIC_DROPBOX_APP_KEY ?? '';
const discovery = {
  authorizationEndpoint: 'https://www.dropbox.com/oauth2/authorize',
  tokenEndpoint: 'https://api.dropboxapi.com/oauth2/token',
};

interface DropboxEntry {
  '.tag': 'file' | 'folder' | 'deleted';
  id: string;
  name: string;
  path_lower?: string;
  size?: number;
}

/**
 * Dropbox via OAuth 2 PKCE. The short-lived access token is held in memory only,
 * so the user signs in again after the app restarts.
 */
class DropboxProvider implements CloudProvider {
  readonly id = 'dropbox' as const;
  readonly label = 'Dropbox';
  // In Expo Go the OAuth redirect would be exp://<your-ip>/..., which Dropbox can't have registered.
  readonly configured = !isExpoGo && Boolean(APP_KEY);
  private token: string | null = null;

  account() {
    return this.token ? 'Connected' : null;
  }

  async restore() {
    return this.token != null;
  }

  async signIn(): Promise<void> {
    const redirectUri = AuthSession.makeRedirectUri({ scheme: 'clinicalview', path: 'oauth/dropbox' });
    const request = new AuthSession.AuthRequest({
      clientId: APP_KEY,
      redirectUri,
      responseType: AuthSession.ResponseType.Code,
      usePKCE: true,
      scopes: ['files.metadata.read', 'files.content.read'],
      extraParams: { token_access_type: 'online' },
    });
    const result = await request.promptAsync(discovery);
    if (result.type !== 'success') {
      if (result.type === 'error') throw new Error(result.error?.description ?? 'Dropbox sign-in failed.');
      throw new SignInCancelled();
    }
    const tokens = await AuthSession.exchangeCodeAsync(
      {
        clientId: APP_KEY,
        code: result.params.code,
        redirectUri,
        extraParams: { code_verifier: request.codeVerifier ?? '' },
      },
      discovery,
    );
    this.token = tokens.accessToken;
  }

  async signOut(): Promise<void> {
    if (this.token) {
      await fetch('https://api.dropboxapi.com/2/auth/token/revoke', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}` },
      }).catch(() => null);
    }
    this.token = null;
  }

  async list(folder: CloudEntry | null): Promise<CloudEntry[]> {
    const out: CloudEntry[] = [];
    let body = (await this.rpc('files/list_folder', { path: folder ? folder.id : '', limit: 2000 })) as {
      entries: DropboxEntry[];
      cursor: string;
      has_more: boolean;
    };
    for (;;) {
      for (const e of body.entries) {
        if (e['.tag'] === 'folder') out.push({ id: e.id, name: e.name, kind: 'folder' });
        else if (e['.tag'] === 'file') out.push({ id: e.id, name: e.name, kind: 'file', size: e.size });
      }
      if (!body.has_more) break;
      body = (await this.rpc('files/list_folder/continue', { cursor: body.cursor })) as typeof body;
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1));
  }

  async download(file: CloudEntry, signal?: AbortSignal): Promise<Uint8Array> {
    // Dropbox ids are ASCII ("id:..."), so the JSON header needs no escaping.
    const res = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: { ...this.auth(), 'Dropbox-API-Arg': JSON.stringify({ path: file.id }) },
      signal,
    });
    this.check(res.status);
    return new Uint8Array(await res.arrayBuffer());
  }

  private auth() {
    if (!this.token) throw new AuthExpiredError(this.label);
    return { Authorization: `Bearer ${this.token}` };
  }

  private check(status: number) {
    if (status === 401) {
      this.token = null;
      throw new AuthExpiredError(this.label);
    }
    if (status >= 400) throw new Error(`Dropbox returned ${status}.`);
  }

  private async rpc(endpoint: string, args: object): Promise<unknown> {
    const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
      method: 'POST',
      headers: { ...this.auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    this.check(res.status);
    return res.json();
  }
}

export const dropbox = new DropboxProvider();
