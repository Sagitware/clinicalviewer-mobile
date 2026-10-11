export interface CloudEntry {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  size?: number;
}

export interface CloudProvider {
  readonly id: 'gdrive' | 'dropbox';
  readonly label: string;
  /** False when the app was built without this provider's client ID. */
  readonly configured: boolean;
  /** Who is signed in, or null. */
  account(): string | null;
  /** Restores a previous session without UI, if the provider supports it. */
  restore(): Promise<boolean>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** null lists the root. */
  list(folder: CloudEntry | null): Promise<CloudEntry[]>;
  download(file: CloudEntry, signal?: AbortSignal): Promise<Uint8Array>;
}

export class AuthExpiredError extends Error {
  constructor(provider: string) {
    super(`Your ${provider} session expired. Sign in again.`);
  }
}

export class SignInCancelled extends Error {
  constructor() {
    super('Sign-in was cancelled.');
  }
}
