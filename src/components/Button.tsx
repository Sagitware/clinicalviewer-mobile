import { Pressable, StyleSheet, Text } from 'react-native';
import { colors, space, type } from '../theme';

interface Props {
  label: string;
  onPress: () => void;
  active?: boolean;
  primary?: boolean;
  disabled?: boolean;
}

export function Button({ label, onPress, active, primary, disabled }: Props) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        primary && styles.primary,
        active && styles.active,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.label, (primary || active) && styles.labelStrong]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    paddingHorizontal: space(3),
    paddingVertical: space(2),
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    minHeight: 40,
    justifyContent: 'center',
  },
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  active: { borderColor: colors.accent, backgroundColor: colors.raised },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
  label: { color: colors.text, fontSize: type.body, textAlign: 'center' },
  labelStrong: { fontWeight: '600' },
});
