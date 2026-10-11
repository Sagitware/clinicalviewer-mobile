import { useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, space, type } from '../theme';

interface Item {
  label: string;
  onPress: () => void;
}

export function MenuButton({ items }: { items: Item[] }) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();

  const all: Item[] = [
    ...items,
    {
      label: 'About',
      onPress: () =>
        Alert.alert(
          'ClinicalView Mobile',
          `Version ${Constants.expoConfig?.version ?? '1.0.0'}\n\nDICOM viewer for DICOMweb servers, local files and C-STORE. Not for diagnostic use.`,
        ),
    },
  ];

  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel="Menu" onPress={() => setOpen(true)} hitSlop={12} style={styles.btn}>
        <Text style={styles.icon}>☰</Text>
      </Pressable>
      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={[styles.menu, { marginTop: insets.top + space(2) + 40 }]}>
            {all.map((it) => (
              <Pressable
                key={it.label}
                accessibilityRole="menuitem"
                style={({ pressed }) => [styles.item, pressed && styles.pressed]}
                onPress={() => {
                  setOpen(false);
                  it.onPress();
                }}
              >
                <Text style={styles.label}>{it.label}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
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
});
