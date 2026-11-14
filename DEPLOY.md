# Deploying fig-dicom to the App Store and Google Play

Expo SDK 58 app, built and submitted with EAS (Expo Application Services). No local Xcode or Android Studio is needed.

- iOS bundle ID: `com.sagitware.clinicalview.mobile`
- Android package: `com.sagitware.clinicalview.mobile`
- Current version: `1.0.0` (`app.config.ts`)

> Check current details in the Expo docs before each release: https://docs.expo.dev/submit/introduction/ and https://docs.expo.dev/build/introduction/. Store requirements change often.

---

## 0. Prerequisites (one time)

| Item | Cost | Notes |
|------|------|-------|
| Expo account | Free | https://expo.dev/signup |
| Apple Developer Program | US$99 / year | https://developer.apple.com/programs/ |
| Google Play Console | US$25 one time | https://play.google.com/console |
| Privacy policy URL | - | Required by both stores. The app handles patient images, so state clearly what is stored on the device and what is sent to servers. |
| Support URL and contact email | - | Required by both stores. |

Tools:

```bash
npm install -g eas-cli      # or: npx eas-cli@latest <command>
eas login
```

---

## 1. Prepare the app

1. **Decide on the native modules.** The app uses `react-native-tcp-socket`, `expo-network`, `expo-secure-store` and Google Sign-In. None of these run in Expo Go, so test with a development build first (step 2).
2. **Google Drive sign-in (optional).** Set `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` (and the web/Android client IDs) in EAS environment variables, not in the repo. If unset, Drive shows as "not set up".
3. **DICOMweb default URL.** `EXPO_PUBLIC_DICOMWEB_URL` is bundled into the app and visible to anyone, so don't put secrets in it. It only creates the first server; users add and edit servers in the app.
4. **Check the assets.** `assets/icon.png` must be 1024x1024 with no transparency. The Android adaptive icon files are already configured.
5. **Confirm export compliance.** `app.config.ts` sets
   `ios.infoPlist.ITSAppUsesNonExemptEncryption` to `false`. This declares to Apple that
   the app does not use non-exempt encryption; it does not disable HTTPS or device
   secure storage. Confirm this is accurate for all app code and included libraries
   before submitting. If the app adds custom or other non-exempt cryptography, revisit
   this declaration and Apple's export-compliance questions.
6. **Run the quality checks:**
   ```bash
   npx tsc --noEmit
   npx expo lint
   npx expo-doctor
   ```
7. **Regulatory wording.** A DICOM viewer shown to clinicians may count as a medical device in some regions. Unless you hold clearance, word the store listing and in-app About text as "not for diagnostic use" or similar. Get this checked by whoever handles compliance for you.

---

## 2. Configure EAS

```bash
eas init                      # links the project to your Expo account
eas build:configure           # creates eas.json
```

Use this `eas.json`:

```json
{
  "cli": { "version": ">= 16.0.0", "appVersionSource": "remote" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal"
    },
    "preview": {
      "distribution": "internal"
    },
    "production": {
      "autoIncrement": true
    }
  },
  "submit": {
    "production": {}
  }
}
```

- `appVersionSource: remote` + `autoIncrement` makes EAS bump the iOS build number and Android `versionCode` for each production build. You only edit `version` in `app.config.ts` for user-visible releases.
- Add secrets and `EXPO_PUBLIC_*` values in the Expo dashboard (Project > Environment variables) or with `eas env:create`.

Test on real devices before the store builds:

```bash
eas build --profile development --platform android      # installable APK
eas build --profile development --platform ios          # needs a registered device
eas device:create                                        # registers an iPhone for internal builds
```

---

## 3. iOS: App Store

> For the full, up-to-date iOS walkthrough (SDK 58, Node 22, TestFlight checks and review notes), see [DEPLOY-IOS.md](DEPLOY-IOS.md).

### 3.1 Apple setup (one time)

1. Enrol in the Apple Developer Program and wait for approval.
2. In **App Store Connect > Apps > + > New App**:
   - Platform: iOS
   - Name: fig-dicom (must be unique in the store)
   - Primary language
   - Bundle ID: `com.sagitware.clinicalview.mobile` (EAS registers it on the first build if it's missing)
   - SKU: any unique string, for example `fig-dicom`
3. Note the app's **Apple ID** (a numeric ID under App Information). EAS Submit needs it, or you can enter it when prompted.

### 3.2 Build

```bash
eas build --platform ios --profile production
```

- On the first run EAS asks you to log in with your Apple ID and creates the distribution certificate and provisioning profile for you. Accept the defaults.
- The build takes roughly 10-20 minutes. The output is an `.ipa` stored on EAS.

### 3.3 Submit to TestFlight

```bash
eas submit --platform ios --latest
```

- Choose "Let EAS manage an App Store Connect API key" when asked (simplest), or provide your own key.
- After Apple finishes processing (5-30 minutes), the build appears under **App Store Connect > TestFlight**.
- Add internal testers (up to 100, no review needed) and test the build. External testers need a short Beta App Review.

### 3.4 Complete the store listing

In App Store Connect, open the app's version page and fill in:

- Screenshots: 6.9" iPhone (required) and 13" iPad (this app sets `supportsTablet: true`, so iPad screenshots are required).
- Description, keywords, support URL, marketing URL (optional), copyright.
- Privacy policy URL.
- **App Privacy** ("nutrition labels"): declare what you collect. If everything stays on the device and only goes to servers the user configures, state that accurately. Google Drive or Dropbox sign-in and local files count as user content access.
- Age rating questionnaire.
- Category: Medical (or Utilities, depending on your regulatory position).
- **App Review information:** a demo account or sample data, and notes. Reviewers can't reach your PACS, so say that the app opens DICOM files from Files, a link, or cloud storage, and attach a small anonymised sample `.dcm` or `.zip` download link. Without this, review commonly rejects the app as "can't test".

### 3.5 Submit for review

1. Select the processed build in the version page.
2. Click **Add for Review**, then **Submit to App Review**.
3. Review typically takes 1-2 days. Fix and resubmit if rejected (reply in Resolution Center).
4. Choose manual or automatic release.

---

## 4. Android: Google Play

### 4.1 Google setup (one time)

1. Create a Play Console developer account and verify your identity.
2. **Create app**: name, default language, App or Game: App, Free or paid, accept the declarations.
3. **Personal accounts created after Nov 2023:** Google requires a closed test with at least 12 testers opted in for 14 continuous days before you can apply for production access. Organisation accounts are exempt. Plan for this delay.

### 4.2 Build

```bash
eas build --platform android --profile production
```

- Produces an `.aab` (Android App Bundle), which Play requires.
- On the first run EAS generates and stores the upload keystore. **Back it up:** `eas credentials` > Android > download. Losing it blocks updates (Play App Signing can reset the upload key, but avoid that).

### 4.3 Create a Google service account for submission (one time)

1. Play Console > **Setup > API access** (or Google Cloud console) and create a service account.
2. Grant it **Release manager** (or "Release apps to testing tracks / production") permission on the app.
3. Create a JSON key and download it. **Don't commit it.** Store it outside the repo, or add it as an EAS secret file.
4. Reference it in `eas.json`:
   ```json
   "submit": {
     "production": {
       "android": {
         "serviceAccountKeyPath": "../secrets/play-service-account.json",
         "track": "internal",
         "releaseStatus": "draft"
       }
     }
   }
   ```

### 4.4 First upload (manual)

Google doesn't allow the API to create the first release. Download the `.aab` from the EAS build page and upload it manually:

1. Play Console > **Testing > Internal testing > Create new release**.
2. Accept **Play App Signing**, upload the `.aab`, add release notes, and save.

After this first release, `eas submit` works for later versions.

### 4.5 Complete the store listing

- **Main store listing:** short description (80 characters), full description, app icon (512x512), feature graphic (1024x500), at least 2 phone screenshots. Add 7" and 10" tablet screenshots too.
- **App content:** privacy policy URL, ads declaration, app access (give reviewers sample data or instructions), content rating questionnaire, target audience, **Data safety form**, and the **Health apps declaration** if you choose a medical category.
- **Permissions:** the app declares no sensitive permissions beyond networking. Remove any you don't use.
- Pick countries and a pricing model.

### 4.6 Release

```bash
eas submit --platform android --latest
```

Promote the build in this order:

1. Internal testing (immediate, up to 100 testers).
2. Closed testing (see the 12-tester rule above).
3. **Production > Create new release** and choose the tested build. Review typically takes from a few hours to several days for new apps.
4. Use a staged rollout (for example 10%, then 50%, then 100%) for the first release.

---

## 5. Releasing updates

| Change | What to do |
|--------|------------|
| JS or asset-only fix | `eas update --channel production --message "..."` (needs `expo-updates`, which isn't installed; install it with `npx expo install expo-updates` and run `eas update:configure` first). The change doesn't go through store review. |
| Native change (new library, permission, config plugin, Expo SDK upgrade) | Raise `version` in `app.config.ts`, then build and submit both platforms again. |

Typical release flow:

```bash
npx tsc --noEmit && npx expo lint
# bump "version" in app.config.ts
eas build --platform all --profile production
eas submit --platform all --latest
```

Add release notes in each store console.

---

## 6. Release checklist

- [ ] Typecheck, lint and expo-doctor pass
- [ ] Tested on a real iPhone, an iPad and an Android phone with a development or preview build
- [ ] Open from Files, from an email attachment, from a link and from a zip all work
- [ ] No secrets in the repo or in `EXPO_PUBLIC_*` variables
- [ ] Privacy policy published and linked in both stores
- [ ] Store wording on diagnostic use reviewed
- [ ] Sample DICOM data and review notes provided to Apple and Google reviewers
- [ ] Screenshots uploaded (iPhone and iPad, Android phone and tablet)
- [ ] Android upload keystore backed up
- [ ] Service account JSON stored outside git
- [ ] Version bumped, release notes written

## Troubleshooting

- **"Missing compliance" in TestFlight:** confirm the `ITSAppUsesNonExemptEncryption` declaration (step 1.5) or answer the prompt in App Store Connect.
- **Apple rejects for being untestable (2.1):** provide sample data and clear instructions in the review notes.
- **`eas submit` says the app doesn't exist on Play:** do the first manual upload (step 4.4).
- **Version code already used:** keep `autoIncrement: true` with `appVersionSource: "remote"`.
- **Native module missing at runtime:** you're running Expo Go. Use a development build or the store build.
