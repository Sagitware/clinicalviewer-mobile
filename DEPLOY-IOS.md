# Deploying fig-dicom to the App Store

Step-by-step iOS release guide. The app is built and uploaded with EAS (Expo Application Services) in the cloud, so it works from Linux, WSL or Windows. No Mac or Xcode is needed.

| | |
|---|---|
| App name | `fig-dicom` |
| Bundle ID | `com.sagitware.clinicalview.mobile` |
| Expo SDK | 58 (React Native 0.88) |
| Version | `version` in `app.config.ts` |
| Build number | Set by EAS (`appVersionSource: remote`, `autoIncrement: true` in `eas.json`) |

The bundle ID still says `clinicalview`. Users never see it, but it can't be changed after the first App Store upload.

> Expo and Apple change their tooling and rules often. Before each release, check https://docs.expo.dev/submit/ios/ and https://developer.apple.com/app-store/review/guidelines/.

---

## 0. One-time prerequisites

### Accounts

| Account | Cost | Notes |
|---|---|---|
| Apple Developer Program | US$99 / year | Enroll **Sagitware as an organization**. Apple expects healthcare apps to come from a legal entity, not an individual (guideline 5.1.1). Organizations need a D-U-N-S number, which can take days to get. |
| Expo account | Free | The EAS project is linked by `extra.eas.projectId` in `app.config.ts`. Decide which account or organization owns it before the first store build. |

Until the Apple Developer membership is active, App Store Connect won't let you create apps, and `eas build --platform ios` stops at the Apple sign-in step.

To add a teammate: in App Store Connect, go to **Users and Access** and invite them with the **App Manager** role, or **Admin** if they'll manage certificates.

### Tools

Node.js 22.13 or newer is required by SDK 58. Odd-numbered releases like 23 and 25 aren't supported.

```bash
nvm install 22 && nvm use 22
node -v                          # v22.13 or newer
npx eas-cli@latest login
npx eas-cli@latest whoami
```

Use `npx eas-cli@latest`, not an old global `eas`. `eas.json` sets a minimum CLI version, and older versions fail with "does not satisfy the CLI version constraint".

### Required pages

- **Privacy policy URL:** state what stays on the device (local library, settings) and what goes to servers the user configures (DICOMweb, Google Drive, Dropbox).
- **Support URL:** any page with a way to contact you.

---

## 1. Prepare the release

### 1.1 Production environment variables

`.env.local` is gitignored, so EAS cloud builds don't see it. Set values in the EAS **production** environment instead. Store builds use it automatically.

```bash
npx eas-cli@latest env:set --name EXPO_PUBLIC_DICOMWEB_URL --value https://your-server/dicom-web --environment production --visibility plaintext
npx eas-cli@latest env:list --environment production
```

| Variable | Purpose | If unset |
|---|---|---|
| `EXPO_PUBLIC_DICOMWEB_URL` | Creates a first server on first launch | No server is preset. Users add servers from the location menu. |
| `EXPO_PUBLIC_DICOMWEB_USER` | Username for that first server | Empty |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | Google Drive import. It also adds the Google Sign-In URL scheme at build time. | Google Drive shows as "not set up" |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | Google Drive import | Same |
| `EXPO_PUBLIC_DROPBOX_APP_KEY` | Dropbox import | Dropbox is hidden |

- **Values are public:** `EXPO_PUBLIC_*` values are compiled into the app and readable by anyone, so never put passwords or secrets in them.
- **Default server:** only set `EXPO_PUBLIC_DICOMWEB_URL` for a server every user can reach, such as a public HTTPS demo. Otherwise leave it unset, and the app starts on Local studies with no server.
- **HTTPS only:** iOS blocks plain HTTP to internet servers. Only local-network servers may use HTTP.

See `SETUP.md` for creating the Google and Dropbox client IDs.

### 1.2 Version number

For a new App Store release, raise `version` in `app.config.ts`, for example `1.0.0` to `1.0.1`. Don't touch the build number, because EAS manages it.

### 1.3 Checks

```bash
npx tsc --noEmit
npx expo lint
npx expo-doctor
npx expo install --check
```

`expo-doctor` warns that `react-native-tcp-socket` is untested on the New Architecture. Because of that, test DICOM Receive on a real device before every release.

---

## 2. Create the app in App Store Connect (first release only)

1. Go to https://appstoreconnect.apple.com, then **Apps → + → New App**, and enter:
   - **Platform:** iOS
   - **Name:** `fig-dicom` (must be unique on the App Store)
   - **Primary language:** English (or your choice)
   - **Bundle ID:** `com.sagitware.clinicalview.mobile`. If it isn't listed yet, EAS registers it during the first build in step 3; come back and create the app afterwards.
   - **SKU:** `fig-dicom` (internal only, any unique string)
2. Open **App Information** and copy the numeric **Apple ID** (for example `6740000000`).
3. Add it to `eas.json`, so `eas submit` doesn't have to ask:

   ```json
   "submit": {
     "production": {
       "ios": { "ascAppId": "6740000000" }
     }
   }
   ```

---

## 3. Build

```bash
npx eas-cli@latest build --platform ios --profile production
```

On the first run:
- **Apple ID sign-in:** sign in with an Apple ID that is a member of the developer team.
- **Credentials:** answer **Yes** when asked to generate the distribution certificate and provisioning profile. EAS stores them, and `npx eas-cli@latest credentials --platform ios` shows them later.
- **Bundle ID:** EAS registers it if it doesn't exist yet.

The build runs in the cloud, takes roughly 15-30 minutes, and prints a link to follow it. The result is a signed `.ipa` stored on EAS.

---

## 4. Upload to TestFlight

```bash
npx eas-cli@latest submit --platform ios --latest
```

- **API key:** on the first run, choose **Let EAS manage an App Store Connect API key**.
- **Processing:** Apple processes the build for about 10-15 minutes. Then it appears in App Store Connect under **TestFlight**.
- **Build and submit together:** add `--auto-submit` to the build command in step 3 to do steps 3 and 4 in one go.

If a submission fails, open it on expo.dev and read the logs, then check the build annotations.

---

## 5. Test the TestFlight build

1. In **TestFlight → Internal Testing**, create a group and add testers (up to 100 team members, no review needed).
2. Install the build with the TestFlight app on an iPhone and an iPad, then check:
   - [ ] The app opens and the icon and name show as `fig-dicom`
   - [ ] Connecting to a DICOMweb server and loading a study
   - [ ] Pan, pinch zoom and window/level, including lifting fingers after a pinch
   - [ ] **Open in fig-dicom** for `.dcm` and `.zip` files from Mail and Files
   - [ ] DICOM Receive (C-STORE) from a computer on the same network, after allowing the Local Network prompt
   - [ ] Google Drive and Dropbox sign-in, if enabled
   - [ ] Rotation, and the iPad layout

External testers (outside the team) need a short Beta App Review first.

---

## 6. Complete the App Store listing

Open the app's version page (**1.0 Prepare for Submission**) and fill in the following.

| Item | Notes |
|---|---|
| Screenshots | iPhone 6.9" (1320 x 2868) and iPad 13" (2064 x 2752). iPad screenshots are required because `supportsTablet` is `true`. |
| Description, keywords | Say what the app does, and include "not for diagnostic use" unless the app has regulatory clearance. |
| Support URL | Required |
| Copyright | For example `2026 Sagitware` |
| Category | Medical, or Utilities. Medical apps get closer review (guideline 1.4.1). |
| Age rating | Complete the questionnaire. |
| App Privacy | Link the privacy policy and answer the data collection questions accurately. If patient images stay on the device and only go to servers the user chooses, say exactly that. |
| Export compliance | `app.config.ts` sets `ITSAppUsesNonExemptEncryption: false`. Confirm that's still true if you add encryption beyond standard HTTPS and the iOS keychain. |

### App Review information

Reviewers can't reach your PACS or local network. Without test data, apps like this are commonly rejected under guideline 2.1. Provide:
- **Notes:** explain how to try the app without a server, for example: "Download the sample file from the link below, then open it in Files and choose Open in fig-dicom."
- **Sample data:** a link to a small, fully anonymized `.dcm` or `.zip` file. Check that it contains no patient names, IDs or dates.
- **Demo server:** if you have a public demo DICOMweb server, give its URL and a login.
- **Contact:** a name, phone number and email.

---

## 7. Submit for review

1. On the version page, under **Build**, select the processed build.
2. Click **Add for Review**, then **Submit to App Review**.
3. Choose how to release it: **Manually**, **Automatically after approval**, or on a date.

Review usually takes 1-2 days. If the app is rejected, read the message in App Store Connect, fix the problem, build again (steps 3-4), select the new build and resubmit. If you disagree with the rejection, you can reply to the reviewer.

---

## 8. Later releases

| Change | What to do |
|---|---|
| Any release through the store | Raise `version` in `app.config.ts`, then repeat steps 3, 4, 5 and 7. In App Store Connect, add a new version with **+ Version or Platform → iOS**, and enter "What's New". |
| JavaScript-only fix without store review | Needs `expo-updates`, which isn't installed. See "Releasing updates" in `DEPLOY.md`. |

Quick release:

```bash
nvm use 22
npx tsc --noEmit && npx expo lint
# raise "version" in app.config.ts
npx eas-cli@latest build --platform ios --profile production --auto-submit
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| App Store Connect shows no apps, or no access | The Apple Developer membership isn't active, enrollment is still pending, or your Apple ID isn't on the team. Ask the Account Holder to accept any pending agreements at https://developer.apple.com/account. |
| `does not satisfy the CLI version constraint` | Use `npx eas-cli@latest` instead of an old global `eas`. |
| `request to https://api.expo.dev/graphql failed, reason:` (blank reason) | A network failure. Retry. If it keeps happening, turn off the VPN or try `NODE_OPTIONS=--dns-result-order=ipv4first`. |
| Expo commands fail with Node errors | Run `nvm use 22`. SDK 58 needs Node 22.13 or newer. |
| "Missing Compliance" on the TestFlight build | Answer the encryption question in App Store Connect, or check `ITSAppUsesNonExemptEncryption` in `app.config.ts`. |
| Rejected under 2.1 (can't be tested) | Add sample data and clear steps in App Review information. |
| Google Drive or Dropbox missing in the store build | The variables aren't set in the EAS production environment (section 1.1). |
| Server unreachable in the store build | The server uses HTTP over the internet. Use HTTPS. |
