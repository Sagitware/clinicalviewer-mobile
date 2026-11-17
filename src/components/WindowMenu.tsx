import { useRef, useState, type ComponentRef } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, space, type } from '../theme';

const MENU_WIDTH = 230;
const MARGIN = 8;

interface Preset {
  label: string;
  w: number;
  c: number;
}

interface Props {
  /** Named windows to offer. With none, the button is a plain Reset. */
  presets: Preset[];
  onReset: () => void;
  onPick: (w: number, c: number) => void;
}

/** One chip for everything that sets the window: Reset and the presets, in a menu that opens above it. */
export function WindowMenu({ presets, onReset, onPick }: Props) {
  const insets = useSafeAreaInsets();
  const screen = useWindowDimensions();
  const chip = useRef<ComponentRef<typeof View>>(null);
  // Where the chip is on screen while the menu is open.
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  if (presets.length === 0) {
    return (
      <Pressable accessibilityRole="button" onPress={onReset} style={styles.chip}>
        <Text style={styles.chipText}>Reset</Text>
      </Pressable>
    );
  }

  const open = () => chip.current?.measureInWindow((x, y) => setAnchor({ x, y }));
  const close = () => setAnchor(null);
  const run = (action: () => void) => () => {
    close();
    action();
  };

  return (
    <>
      <Pressable
        ref={chip}
        accessibilityRole="button"
        accessibilityLabel="Window and level"
        accessibilityHint="Opens reset and window presets"
        accessibilityState={{ expanded: anchor != null }}
        onPress={open}
        style={[styles.chip, anchor != null && styles.chipActive]}
      >
        <Text style={styles.chipText}>W/L ▾</Text>
      </Pressable>

      {anchor ? (
        <Modal
          transparent
          visible
          animationType="fade"
          statusBarTranslucent
          navigationBarTranslucent
          supportedOrientations={['portrait', 'landscape']}
          onRequestClose={close}
        >
          <Pressable style={styles.backdrop} onPress={close} accessibilityLabel="Close menu">
            <View
              style={[
                styles.menu,
                {
                  left: Math.max(MARGIN, Math.min(anchor.x, screen.width - MENU_WIDTH - MARGIN)),
                  bottom: screen.height - anchor.y + 6,
                  maxHeight: Math.max(120, anchor.y - insets.top - 2 * MARGIN),
                },
              ]}
            >
              <ScrollView bounces={false}>
                <Item label="Reset" detail="Window, zoom and position" onPress={run(onReset)} />
                <View style={styles.divider} />
                {presets.map((p) => (
                  <Item key={p.label} label={p.label} detail={`W ${p.w}  L ${p.c}`} onPress={run(() => onPick(p.w, p.c))} />
                ))}
              </ScrollView>
            </View>
          </Pressable>
        </Modal>
      ) : null}
    </>
  );
}

function Item({ label, detail, onPress }: { label: string; detail: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="menuitem" onPress={onPress} style={({ pressed }) => [styles.item, pressed && styles.pressed]}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.detail}>{detail}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: space(3),
    paddingVertical: space(2),
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  chipActive: { borderColor: colors.accent, backgroundColor: colors.raised },
  chipText: { color: colors.text, fontSize: type.small },
  backdrop: { flex: 1 },
  menu: {
    position: 'absolute',
    width: MENU_WIDTH,
    backgroundColor: colors.ink,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    overflow: 'hidden',
    paddingVertical: space(1),
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space(3),
    minHeight: 44,
    paddingHorizontal: space(4),
    paddingVertical: space(2),
  },
  pressed: { backgroundColor: colors.panel },
  label: { color: colors.text, fontSize: type.body },
  detail: { color: colors.muted, fontSize: type.small, fontVariant: ['tabular-nums'] },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: space(1) },
});
