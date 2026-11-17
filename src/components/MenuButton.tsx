import { useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, space, type } from '../theme';

// The app icon, so the About box always matches what is on the home screen.
const LOGO = require('../../assets/icon.png');

interface Item {
  label: string;
  onPress: () => void;
}

export function MenuButton({ items }: { items: Item[] }) {
  // The menu and the About box share one modal, so one never has to open while the other closes.
  const [open, setOpen] = useState<'menu' | 'about' | null>(null);
  const insets = useSafeAreaInsets();
  const close = () => setOpen(null);

  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel="Menu" onPress={() => setOpen('menu')} hitSlop={12} style={styles.btn}>
        <Text style={styles.icon}>☰</Text>
      </Pressable>
      <Modal transparent visible={open != null} animationType="fade" onRequestClose={close}>
        {open === 'about' ? (
          <Pressable style={[styles.backdrop, styles.centered]} onPress={close} accessibilityLabel="Close">
            {/* Taps inside the box stay in the box. */}
            <Pressable style={styles.about} accessibilityRole="none">
              <Image source={LOGO} style={styles.logo} accessibilityIgnoresInvertColors accessibilityLabel="fig-dicom logo" />
              <Text style={styles.aboutName}>fig-dicom</Text>
              <Text style={styles.aboutVersion}>Version {Constants.expoConfig?.version ?? '1.0.0'}</Text>
              <Text style={styles.aboutText}>
                DICOM viewer for DICOMweb servers, local files and C-STORE. Not for diagnostic use.
              </Text>
              <Pressable accessibilityRole="button" onPress={close} hitSlop={8} style={({ pressed }) => [styles.ok, pressed && styles.pressed]}>
                <Text style={styles.okText}>OK</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        ) : (
          <Pressable style={styles.backdrop} onPress={close}>
            <View style={[styles.menu, { marginTop: insets.top + space(2) + 40 }]}>
              {items.map((it) => (
                <Pressable
                  key={it.label}
                  accessibilityRole="menuitem"
                  style={({ pressed }) => [styles.item, pressed && styles.pressed]}
                  onPress={() => {
                    close();
                    it.onPress();
                  }}
                >
                  <Text style={styles.label}>{it.label}</Text>
                </Pressable>
              ))}
              <Pressable
                accessibilityRole="menuitem"
                style={({ pressed }) => [styles.item, pressed && styles.pressed]}
                onPress={() => setOpen('about')}
              >
                <Text style={styles.label}>About</Text>
              </Pressable>
            </View>
          </Pressable>
        )}
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  btn: { paddingRight: space(3), justifyContent: 'center' },
  icon: { color: colors.text, fontSize: 24 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  menu: {
    marginLeft: space(4),
    minWidth: 200,
    alignSelf: 'flex-start',
    backgroundColor: colors.ink,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    overflow: 'hidden',
  },
  item: { paddingHorizontal: space(4), paddingVertical: space(3) },
  pressed: { opacity: 0.6 },
  label: { color: colors.text, fontSize: type.body },
  centered: { alignItems: 'center', justifyContent: 'center', padding: space(6) },
  about: {
    width: '100%',
    maxWidth: 320,
    alignItems: 'center',
    backgroundColor: colors.ink,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    paddingHorizontal: space(6),
    paddingTop: space(6),
    paddingBottom: space(3),
  },
  logo: { width: 84, height: 84, borderRadius: 18, marginBottom: space(3) },
  aboutName: { color: colors.text, fontSize: type.title, fontWeight: '600' },
  aboutVersion: { color: colors.muted, fontSize: type.small, marginTop: space(1), fontVariant: ['tabular-nums'] },
  aboutText: { color: colors.text, fontSize: type.small, textAlign: 'center', marginTop: space(4), lineHeight: 18 },
  ok: { marginTop: space(4), paddingHorizontal: space(8), paddingVertical: space(3) },
  okText: { color: colors.accent, fontSize: type.body, fontWeight: '600' },
});
