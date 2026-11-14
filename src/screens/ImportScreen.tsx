import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Header } from '../components/Header';
import { dropbox } from '../lib/cloud/dropbox';
import { googleDrive } from '../lib/cloud/googleDrive';
import type { CloudProvider } from '../lib/cloud/types';
import { isExpoGo } from '../lib/runtime';
import { colors, space, type } from '../theme';

const PROVIDERS: CloudProvider[] = [googleDrive, dropbox];

interface Props {
  onBack: () => void;
  onPickDevice: () => void;
  onOpenCloud: (provider: CloudProvider) => void;
  onImportUrl: (url: string) => void;
}

export function ImportScreen({ onBack, onPickDevice, onOpenCloud, onImportUrl }: Props) {
  const [, refresh] = useState(0);
  const [url, setUrl] = useState('');

  useEffect(() => {
    // Quietly restore an existing Google session so the row shows the account.
    Promise.all(PROVIDERS.filter((p) => p.configured).map((p) => p.restore().catch(() => false))).then(() =>
      refresh((n) => n + 1),
    );
  }, []);

  return (
    <View style={styles.screen}>
      <Header title="Import" subtitle="DICOM files, folders, or .zip archives" backLabel="Back" onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body}>
        <Row
          title="Files on this device"
          detail="Pick individual files or zips from Files, including iCloud Drive and any cloud app installed on this device."
          onPress={onPickDevice}
        />
        <Text style={styles.section}>From a link</Text>
        <View style={styles.urlBox}>
          <TextInput
            style={styles.urlInput}
            value={url}
            onChangeText={setUrl}
            placeholder="https://example.com/study.zip"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            onSubmitEditing={() => url.trim() && onImportUrl(url)}
          />
          <Pressable
            accessibilityRole="button"
            disabled={!url.trim()}
            onPress={() => onImportUrl(url)}
            style={[styles.urlBtn, !url.trim() && styles.disabled]}
          >
            <Text style={styles.urlBtnText}>Download</Text>
          </Pressable>
        </View>
        <Text style={styles.detail}>Direct link to a DICOM file or .zip archive.</Text>
        <Text style={styles.section}>Connected storage</Text>
        {PROVIDERS.map((p) => (
          <Row
            key={p.id}
            title={p.label}
            detail={
              !p.configured
                ? isExpoGo
                  ? 'Needs a development build. Not available in Expo Go.'
                  : 'Not set up in this build. See SETUP.md.'
                : p.account()
                  ? `${p.account()}. Browse folders and import whole series.`
                  : 'Sign in to browse folders and import whole series.'
            }
            disabled={!p.configured}
            onPress={() => onOpenCloud(p)}
          />
        ))}
        <Text style={styles.note}>
          Files are downloaded into memory for viewing and are not saved on this device. Store patient images only in
          accounts covered by your organization&apos;s business associate agreement.
        </Text>
      </ScrollView>
    </View>
  );
}

function Row({ title, detail, onPress, disabled }: { title: string; detail: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <View style={styles.rowMain}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.detail}>{detail}</Text>
      </View>
      <Text style={styles.chev}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  body: { padding: space(4), gap: space(3) },
  section: { color: colors.muted, fontSize: type.small, marginTop: space(3) },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    padding: space(4),
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  pressed: { backgroundColor: colors.raised },
  disabled: { opacity: 0.45 },
  rowMain: { flex: 1, gap: space(1) },
  title: { color: colors.text, fontSize: type.title, fontWeight: '600' },
  detail: { color: colors.muted, fontSize: type.small, lineHeight: 18 },
  chev: { color: colors.muted, fontSize: type.heading },
  urlBox: { flexDirection: 'row', gap: space(2) },
  urlInput: {
    flex: 1,
    color: colors.text,
    fontSize: type.body,
    padding: space(3),
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  urlBtn: { justifyContent: 'center', paddingHorizontal: space(4), borderRadius: 10, backgroundColor: colors.accent },
  urlBtnText: { color: colors.ink, fontWeight: '600', fontSize: type.body },
  note: { color: colors.muted, fontSize: type.small, lineHeight: 18, marginTop: space(4) },
});
