import { Pressable, StyleSheet, Text, View } from 'react-native';
import { TOOL_LABELS, type MeasureTool } from '../lib/measure';
import { colors, space, type } from '../theme';

const TOOLS: { section: string; tools: MeasureTool[] }[] = [
  { section: 'Measure', tools: ['length', 'angle', 'ellipse'] },
  { section: 'Annotate', tools: ['arrow'] },
];

interface Props {
  /** The measurement tool in use, if any. */
  active: MeasureTool | null;
  /** Annotations on the image shown. */
  count: number;
  onPick: (tool: MeasureTool) => void;
  onUndo: () => void;
  onClear: () => void;
  onClose: () => void;
}

/** Dropdown under the viewer's top-right button. Render inside the viewport; it covers it to catch outside taps. */
export function MeasureMenu({ active, count, onPick, onUndo, onClear, onClose }: Props) {
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close menu">
      <View style={styles.menu}>
        {TOOLS.map((group) => (
          <View key={group.section}>
            <Text style={styles.section}>{group.section}</Text>
            {group.tools.map((t) => (
              <Item key={t} label={TOOL_LABELS[t]} selected={active === t} onPress={run(() => onPick(t))} />
            ))}
          </View>
        ))}
        <View style={styles.divider} />
        <Item label="Undo last" disabled={count === 0} onPress={run(onUndo)} />
        <Item label={count > 0 ? `Clear this image (${count})` : 'Clear this image'} disabled={count === 0} onPress={run(onClear)} />
      </View>
    </Pressable>
  );
}

function Item({ label, selected, disabled, onPress }: { label: string; selected?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.item, pressed && styles.pressed]}
    >
      <Text style={[styles.label, disabled && styles.disabled]}>{label}</Text>
      {selected ? <Text style={styles.check}>✓</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  menu: {
    position: 'absolute',
    top: space(2) + 48,
    right: space(2),
    minWidth: 210,
    backgroundColor: colors.ink,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    paddingVertical: space(1),
    overflow: 'hidden',
  },
  section: { color: colors.muted, fontSize: type.small, paddingHorizontal: space(4), paddingTop: space(2), paddingBottom: space(1) },
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space(4), paddingVertical: space(3), gap: space(3) },
  pressed: { backgroundColor: colors.panel },
  label: { flex: 1, color: colors.text, fontSize: type.body },
  disabled: { color: colors.muted },
  check: { color: colors.accent, fontSize: type.body, fontWeight: '600' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: space(1) },
});
