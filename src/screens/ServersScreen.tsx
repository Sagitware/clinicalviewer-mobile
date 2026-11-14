import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button } from '../components/Button';
import { Header } from '../components/Header';
import { serverAddress, serverLabel, type ServerConfig } from '../lib/settings';
import { colors, space, type } from '../theme';

interface Props {
  servers: ServerConfig[];
  onEdit: (server: ServerConfig) => void;
  onAdd: () => void;
  onBack: () => void;
}

export function ServersScreen({ servers, onEdit, onAdd, onBack }: Props) {
  return (
    <View style={styles.screen}>
      <Header
        title="Servers"
        subtitle="DICOMweb connections"
        backLabel="Back"
        onBack={onBack}
        right={<Button label="Add" primary onPress={onAdd} />}
      />
      <FlatList
        data={servers}
        keyExtractor={(s) => s.id}
        ItemSeparatorComponent={Separator}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No servers yet</Text>
            <Text style={styles.emptyText}>Add a DICOMweb or traditional DICOM server, such as Orthanc or your PACS, to browse its studies.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => onEdit(item)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <View style={styles.rowMain}>
              <Text style={styles.name} numberOfLines={1}>
                {serverLabel(item)}
              </Text>
              <Text style={styles.detail} numberOfLines={1}>
                {(item.protocol === 'dimse'
                  ? [serverAddress(item), item.calledAe && `AE ${item.calledAe}`, 'DICOM']
                  : [serverAddress(item), item.username && `as ${item.username}`, 'DICOMweb']
                )
                  .filter(Boolean)
                  .join('   ')}
              </Text>
            </View>
            <Text style={styles.chev}>›</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  list: { flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space(4), paddingVertical: space(3), gap: space(3) },
  rowPressed: { backgroundColor: colors.panel },
  rowMain: { flex: 1, gap: 2 },
  name: { color: colors.text, fontSize: type.title, fontWeight: '600' },
  detail: { color: colors.muted, fontSize: type.small },
  chev: { color: colors.muted, fontSize: type.heading },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: space(4) },
  empty: { padding: space(8), alignItems: 'center', gap: space(2) },
  emptyTitle: { color: colors.text, fontSize: type.title, fontWeight: '600' },
  emptyText: { color: colors.muted, fontSize: type.body, textAlign: 'center' },
});
