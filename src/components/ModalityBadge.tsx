import { StyleSheet, Text, View } from 'react-native';
import { colors, modalityTint, type } from '../theme';

export function ModalityBadge({ modality }: { modality: string }) {
  const tint = modalityTint[modality] ?? colors.muted;
  return (
    <View style={[styles.badge, { borderColor: tint }]}>
      <Text style={[styles.text, { color: tint }]}>{modality || '?'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
    minWidth: 34,
    alignItems: 'center',
  },
  text: { fontSize: type.small, fontWeight: '700' },
});
