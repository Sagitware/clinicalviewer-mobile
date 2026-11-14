import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, space, type } from '../theme';

interface Props {
  title: string;
  subtitle?: string;
  backLabel?: string;
  onBack?: () => void;
  right?: ReactNode;
  left?: ReactNode;
  /** Makes the title a dropdown trigger (shows a caret). */
  onTitlePress?: () => void;
  titleHint?: string;
}

export function Header({ title, subtitle, backLabel, onBack, right, left, onTitlePress, titleHint }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { paddingTop: insets.top + space(2) }]}>
      {onBack ? (
        <Pressable accessibilityRole="button" onPress={onBack} hitSlop={12} style={styles.back}>
          <Text style={styles.backText}>‹ {backLabel ?? 'Back'}</Text>
        </Pressable>
      ) : null}
      <View style={styles.row}>
        {left}
        <Pressable
          style={styles.titles}
          onPress={onTitlePress}
          disabled={!onTitlePress}
          accessibilityRole={onTitlePress ? 'button' : 'header'}
          accessibilityHint={titleHint}
          hitSlop={8}
        >
          <View style={styles.titleRow}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            {onTitlePress ? <Text style={styles.caret}>▾</Text> : null}
          </View>
          {subtitle ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </Pressable>
        {right ? <View style={styles.right}>{right}</View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: space(4),
    paddingBottom: space(3),
    backgroundColor: colors.ink,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  back: { marginBottom: space(1), alignSelf: 'flex-start' },
  backText: { color: colors.accent, fontSize: type.body },
  row: { flexDirection: 'row', alignItems: 'center' },
  titles: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space(1.5) },
  title: { flexShrink: 1, color: colors.text, fontSize: type.heading, fontWeight: '600' },
  caret: { color: colors.accent, fontSize: type.title },
  subtitle: { color: colors.muted, fontSize: type.small, marginTop: 2 },
  right: { flexDirection: 'row', gap: space(2) },
});
