import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LOCAL, serverAddress, serverLabel, type ServerConfig } from '../lib/settings';
import { colors, space, type } from '../theme';

interface Props {
  visible: boolean;
  location: string;
  servers: ServerConfig[];
  onSelect: (location: string) => void;
  onAddServer: () => void;
  onManageServers: () => void;
  onClose: () => void;
}

/** Dropdown under the header title: choose Local studies or one of the servers. */
export function LocationMenu({ visible, location, servers, onSelect, onAddServer, onManageServers, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const pick = (action: () => void) => () => {
    onClose();
    action();
  };

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={[styles.menu, { marginTop: insets.top + space(14) }]}>
          <ScrollView bounces={false}>
            <Text style={styles.section}>On this device</Text>
            <Row title="Local studies" selected={location === LOCAL} onPress={pick(() => onSelect(LOCAL))} />
            <Text style={styles.section}>Servers</Text>
            {servers.map((s) => (
              <Row
                key={s.id}
                title={serverLabel(s)}
                detail={s.name.trim() ? serverAddress(s) : undefined}
                selected={location === s.id}
                onPress={pick(() => onSelect(s.id))}
              />
            ))}
            {servers.length === 0 ? <Text style={styles.empty}>No servers yet.</Text> : null}
            <View style={styles.divider} />
            <Row title="Add server…" action onPress={pick(onAddServer)} />
            {servers.length > 0 ? <Row title="Manage servers" action onPress={pick(onManageServers)} /> : null}
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  );
}

function Row({
  title,
  detail,
  selected,
  action,
  onPress,
}: {
  title: string;
  detail?: string;
  selected?: boolean;
  action?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.title, action && styles.action]} numberOfLines={1}>
          {title}
        </Text>
        {detail ? (
          <Text style={styles.detail} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {selected ? <Text style={styles.check}>✓</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  menu: {
    marginHorizontal: space(4),
    maxHeight: '70%',
    maxWidth: 420,
    backgroundColor: colors.ink,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    overflow: 'hidden',
    paddingVertical: space(1),
  },
  section: {
    color: colors.muted,
    fontSize: type.small,
    paddingHorizontal: space(4),
    paddingTop: space(2),
    paddingBottom: space(1),
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space(4), paddingVertical: space(3), gap: space(3) },
  pressed: { backgroundColor: colors.panel },
  rowText: { flex: 1 },
  title: { color: colors.text, fontSize: type.body },
  action: { color: colors.accent },
  detail: { color: colors.muted, fontSize: type.small, marginTop: 2 },
  check: { color: colors.accent, fontSize: type.body, fontWeight: '600' },
  empty: { color: colors.muted, fontSize: type.small, paddingHorizontal: space(4), paddingVertical: space(2) },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: space(1) },
});
