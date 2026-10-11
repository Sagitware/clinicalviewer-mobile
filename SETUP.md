# ClinicalView Mobile — setup

A React Native (Expo SDK 57) DICOM viewer that reads from the same Orthanc DICOMweb
server as the ClinicalView PACS web workstation, and can also open DICOM files stored
on the phone.

## What it does

- Study search (QIDO-RS) by patient name, newest first, with modality badges.
- Series list per study; tap a series to open it.
- Stack viewer: slices sorted along the slice normal (ImagePositionPatient /
  ImageOrientationPatient), falling back to InstanceNumber. Multi-frame instances are
  expanded into slices.
- GPU window/level: 16-bit pixels are uploaded once and windowed in a Skia shader,
  so dragging W/L runs at display refresh rate on the UI thread.
- Gestures: one-finger drag does the selected tool (Window, Pan, Scroll), pinch zooms
  and pans in every tool, double-tap fits the image.
- Slice slider, cine (12 fps), invert, smoothing toggle, reset, CT presets
  (soft tissue, lung, bone, brain, angio, liver).
- Overlay: patient, date, modality, series, image number, W/L, zoom.
- Import from this device, Google Drive or Dropbox: individual files, whole folders
  (subfolders included) or `.zip` archives. Files are grouped by series.
- Prefetch of ±24 slices around the current one, LRU cache of 96 frames.

## Run it

Google Sign-In is a native module that Expo Go doesn't include, so the app now runs as
a **development build** (your own debug version of the app, with fast refresh like Expo Go).

```bash
npm install
cp .env.local.example .env.local      # Orthanc address, plus cloud keys if you want them

# Option A: build on your own machine (iOS needs a Mac with Xcode)
npx expo run:ios                      # or: npx expo run:android

# Option B: build in the cloud with EAS, no Mac needed
npm install -g eas-cli
eas build --profile development --platform ios     # or android
```

Install the development build on the phone once, then use `npx expo start` as before.
You only rebuild when native modules or `app.config.ts` change, not for code changes.

**Expo Go still works for everything except Google Drive and Dropbox.** Run
`npx expo start`, then press `s` to switch to Expo Go before scanning the QR code
(with `expo-dev-client` installed, the QR code targets the development build by
default). Study search, the viewer, the Server screen, and importing files or zips
from the device all work. The two cloud rows show "Needs a development build", and opening email attachments
in the app also needs a development build.

Phone and computer must be on the same Wi-Fi. Use the computer's LAN IP in the
server address. `localhost` on the phone means the phone itself.

Typecheck: `npm run typecheck`

## Orthanc requirements

1. DICOMweb plugin enabled (`/dicom-web` root).
2. Orthanc must listen on the network, not only loopback:

   ```json
   { "RemoteAccessAllowed": true }
   ```

   If authentication is on, enter the username and password on the Server screen.
   CORS is not involved: native apps are not subject to it.
3. **Compressed studies:** the app requests every frame as Explicit VR Little Endian
   (`transfer-syntax=1.2.840.10008.1.2.1`). Orthanc transcodes JPEG, JPEG-LS, JPEG 2000
   and RLE on the fly when that is requested. If you see
   "The server sent compressed pixels", your Orthanc build or DICOMweb plugin is too old
   to transcode frames; upgrade it.

AWS HealthImaging is not wired up on mobile yet. It returns HTJ2K frames, which need a
native decoder or a transcoding proxy (see "Next steps").

## Cloud import setup

Both providers are optional. If a key is missing, that provider shows as "Not set up
in this build" and everything else works. After changing these values, rebuild the
development build, because they feed into native configuration.

### Google Drive

1. In the [Google Cloud console](https://console.cloud.google.com/), create or pick a
   project and enable the **Google Drive API**.
2. Configure the **OAuth consent screen**. While it is in "Testing" status, add each
   tester's Google account as a test user (up to 100).
3. Create OAuth client IDs under *Credentials*:
   - **iOS**: bundle ID `com.sagitware.clinicalview.mobile`. Put its client ID in
     `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`.
   - **Android**: package `com.sagitware.clinicalview.mobile` and the SHA-1 of your
     signing key (`eas credentials` shows it; local debug builds use the debug keystore).
   - **Web application**: put its client ID in `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`.
     Android sign-in uses it even though there's no web app.

The app asks only for `drive.readonly`. Google classes that as a restricted scope:
publishing to the public requires Google's app verification and a security assessment.
Testing mode and internal Workspace apps don't need it.

### Dropbox

1. In the [Dropbox App Console](https://www.dropbox.com/developers/apps), create an app
   with **Scoped access** and **Full Dropbox** (or **App folder** if you want to limit it
   to one folder).
2. Under *Permissions*, tick `files.metadata.read` and `files.content.read`, then submit.
3. Under *Settings*, add the redirect URI `clinicalview://oauth/dropbox`.
4. Put the **App key** in `EXPO_PUBLIC_DROPBOX_APP_KEY`. No secret goes in the app;
   sign-in uses PKCE.

While the app is in development status, up to 500 Dropbox users can connect. Apply for
production status before a wider rollout.

### How importing works

- Ticking a folder imports everything inside it, including subfolders. Inside a folder,
  "Import this folder" does the same without ticking anything.
- Files with obviously non-DICOM extensions (images, PDFs, documents) are skipped
  before download. Everything else, including files without an extension, is tried.
- `.zip` archives are expanded in memory. `__MACOSX` entries and `DICOMDIR` are ignored.
- Before downloading, the app shows the file count and total size. Imports are capped at
  5,000 files and about 1.2 GB, since everything is held in memory.
- Downloads run four at a time and can be stopped.

Google Drive and Dropbox also appear inside the system file picker ("Files on this
device") when their apps are installed. That path needs no keys but can't pick folders.

### PHI and cloud storage

- Downloads go straight to memory, then are saved to the on-device Library (see PHI handling).
- Google tokens are managed by the Google Sign-In SDK, which remembers the account.
  Dropbox tokens are short-lived and held in memory only, so Dropbox asks you to sign in
  again after the app restarts.
- Storing patient images in Google Drive or Dropbox is a HIPAA question for the account
  owner. Google Workspace and Dropbox business plans offer business associate
  agreements; personal accounts do not.

## Opening email attachments

ClinicalView registers itself for `.dcm`, `.dicom`, `.dic` and `.zip` files, so it shows
up when someone opens an attachment:

- **iOS Mail, Outlook, Gmail for iOS:** tap the attachment, tap the share button, then
  choose ClinicalView in the app row (or "Open in…" in some apps).
- **Gmail and other Android mail apps:** tap the attachment and pick ClinicalView. If the
  mail app labels the file as generic binary, ClinicalView still appears, because it
  also accepts `application/octet-stream`.
- The app opens straight to the series list for that file. Zips with whole series work.

Notes:

- This needs a development or release build. Expo Go can't register file types.
- iOS gives the app a private copy of the attachment in its Inbox folder. The app reads it
  into memory and deletes the copy immediately. Android passes a content URI, which the
  app reads directly without making a copy.
- DICOM files without an extension (e.g. `IM0001`) aren't recognised by the mail app.
  Ask senders to zip the folder, which also keeps a series together in one attachment.
- Android's automatic backup is turned off (`allowBackup: false`) so no app data ends up
  in Google Drive backups.
- Ordinary email is not an approved channel for PHI in most organizations. Use
  encrypted email or your organization's secure messaging, and prefer de-identified
  data for testing.

## Project layout

```
App.tsx                         view-state navigation (same model as the web app)
src/lib/dicomClient.ts          all network access: QIDO-RS, metadata, frames, multipart parsing
src/lib/dicomJson.ts            DICOM JSON tag helpers
src/lib/pixels.ts               pixel decoding: signed/unsigned 8/16-bit, MONOCHROME1/2, RGB, YBR_FULL
src/lib/skiaFrames.ts           GPU upload + the window/level shader
src/lib/frameCache.ts           LRU cache and prefetch queue
src/lib/sources.ts              SliceSource for DICOMweb series, and the shared import path for files
src/lib/archive.ts              in-memory zip expansion
src/lib/localDb.ts              SQLite library of imported files
src/lib/cloud/googleDrive.ts    Google Drive provider (Google Sign-In + Drive API v3)
src/lib/cloud/dropbox.ts        Dropbox provider (OAuth PKCE + Dropbox API v2)
src/lib/cloud/importer.ts       folder scan, size check, parallel download
src/lib/incomingFiles.ts        files opened from Mail, Gmail, Files ("Open in ClinicalView")
src/lib/settings.ts             server settings in the device keychain
src/components/DicomViewport.tsx Skia canvas and gestures
src/screens/*                   Studies, Series, Viewer, Server, Import, Cloud browser
```

## How rendering works

Stored values are shifted by the frame minimum into 0..65535 and split into two
8-bit planes (high byte, low byte). Each plane is an `Alpha_8` Skia image. Alpha is
never colour-managed, so the bytes reach the shader unchanged on wide-gamut screens.
The shader rebuilds the integer, interpolates in value space when Smooth is on (so
edges are correct at any zoom), applies rescale slope/intercept and the DICOM linear
VOI function, and inverts for MONOCHROME1. Window, level, invert, zoom and pan are
Reanimated shared values, so gestures never cross the JS bridge.

## PHI handling

- Imported DICOM files (device, cloud, open-in) are saved to the app's document
  folder (`library/`), indexed by a local SQLite database (`clinicalview.db`, via
  `expo-sqlite`), so they can be reopened offline from **Library**. They are protected only by the OS app sandbox and device encryption,
  not separately encrypted. Long-press a study in Library to delete it, or use
  **Clear all**. Studies loaded from the DICOMweb server are not stored.
- Frames being viewed live in memory and are dropped when you leave the viewer.
- Files chosen from this device are copied to the cache by the system picker; the
  app reads them into memory and deletes those copies immediately.
- Server address and credentials are persisted separately, in the iOS Keychain or
  Android Keystore via `expo-secure-store`.

## Known limits

- Local files must be uncompressed (Implicit or Explicit VR Little Endian). Compressed
  files are listed as skipped; send them to Orthanc and open them from Studies.
- Palette colour, 32-bit and 1-bit images are not rendered.
- Pixel aspect ratio is assumed square; measurements and annotations are not included yet.
- HTTP to a server on the local network works in development builds on both platforms
  (iOS has a local-networking exception in `app.config.ts`; Android debug builds allow
  cleartext). Release builds on Android block HTTP, and any server reached over the
  internet should use HTTPS anyway, so put Orthanc behind HTTPS before shipping.

## Next steps worth discussing

- Cognito sign-in (react-native-app-auth or expo-auth-session) to match Phase 9 RBAC.
- Read-only display of annotations saved by the web workstation.
- HTJ2K for AWS HealthImaging: either a native decoder module, or ask Orthanc / a small
  proxy to transcode, which keeps the app unchanged.
- MPR on mobile is feasible with the same shader approach but needs a 3D texture
  strategy; worth a separate design pass.
