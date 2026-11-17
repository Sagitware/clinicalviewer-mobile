import type { ExpoConfig } from 'expo/config';

/**
 * Google Sign-In needs the reversed iOS client ID registered as a URL scheme.
 * When no Google client ID is set, the plugin is left out and Google Drive shows
 * as "not set up" in the app.
 */
const googleIosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '';
const googleUrlScheme = googleIosClientId
  ? `com.googleusercontent.apps.${googleIosClientId.replace('.apps.googleusercontent.com', '')}`
  : null;

/** MIME types an email app may use for DICOM or zip attachments. */
const ANDROID_MIME_TYPES = [
  'application/dicom',
  'application/zip',
  'application/x-zip-compressed',
  // Many mail apps label .dcm files as generic binary. This makes fig-dicom
  // appear as an option for other binary attachments too; the app rejects non-DICOM.
  'application/octet-stream',
];

const config: ExpoConfig = {
  name: 'fig-dicom',
  slug: 'clinicalview-mobile',
  version: '1.1.1',
  orientation: 'default',
  icon: './assets/icon.png',
  userInterfaceStyle: 'dark',
  backgroundColor: '#0B1620',
  // Used by the Dropbox OAuth redirect: clinicalview://oauth/dropbox
  scheme: 'clinicalview',
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.sagitware.clinicalview.mobile',
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      // Lets the app reach an Orthanc server on the local network over HTTP.
      // Internet servers still require HTTPS.
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
      // Shown when a DICOM sender connects to the Receive (C-STORE) listener.
      NSLocalNetworkUsageDescription:
        'fig-dicom connects to PACS servers and receives DICOM images from computers and scanners on your local network.',
      // "Open in fig-dicom" for .dcm and .zip attachments in Mail, Files, and other apps.
      // iOS doesn't know DICOM by default, so the type is declared here.
      UTImportedTypeDeclarations: [
        {
          UTTypeIdentifier: 'org.nema.dicom',
          UTTypeDescription: 'DICOM image',
          UTTypeConformsTo: ['public.data'],
          UTTypeTagSpecification: {
            'public.filename-extension': ['dcm', 'dicom', 'dic'],
            'public.mime-type': ['application/dicom'],
          },
        },
      ],
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'DICOM image',
          LSHandlerRank: 'Owner',
          LSItemContentTypes: ['org.nema.dicom'],
        },
        {
          CFBundleTypeName: 'Zip archive',
          LSHandlerRank: 'Alternate',
          LSItemContentTypes: ['public.zip-archive'],
        },
      ],
      // iOS hands the app a private copy of the file, which the app deletes after reading.
      LSSupportsOpeningDocumentsInPlace: false,
    },
  },
  android: {
    package: 'com.sagitware.clinicalview.mobile',
    predictiveBackGestureEnabled: false,
    // Keep app data out of Android's automatic Google Drive backup.
    allowBackup: false,
    intentFilters: [
      {
        action: 'VIEW',
        category: ['DEFAULT'],
        data: ANDROID_MIME_TYPES.flatMap((mimeType) => [
          { scheme: 'content', mimeType },
          { scheme: 'file', mimeType },
        ]),
      },
    ],
    adaptiveIcon: {
      backgroundColor: '#0B1620',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
  },
  web: { favicon: './assets/favicon.png' },
  extra: {
    eas: {
      projectId: '8ef7194b-cb5d-4ce2-ac01-7bc1bb94bf1c',
    },
  },
  plugins: [
    'expo-secure-store',
    'expo-sqlite',
    'expo-status-bar',
    'expo-web-browser',
    ...(googleUrlScheme
      ? [['@react-native-google-signin/google-signin', { iosUrlScheme: googleUrlScheme }] as [string, object]]
      : []),
  ],
};

export default config;
