import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, space, type } from '../theme';
import { Button } from './Button';

interface Props {
  title: string;
  initialValue?: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** One-line text entry in a dialog (Alert.prompt only exists on iOS). Mount it to show it. */
export function TextPrompt({ title, initialValue = '', placeholder, onSubmit, onCancel }: Props) {
  const [value, setValue] = useState(initialValue);
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} accessibilityLabel="Cancel" />
        <View style={styles.dialog}>
          <Text style={styles.title}>{title}</Text>
          <TextInput
            style={styles.input}
            value={value}
            onChangeText={setValue}
            placeholder={placeholder}
            placeholderTextColor={colors.muted}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={() => onSubmit(value.trim())}
            maxLength={80}
          />
          <View style={styles.actions}>
            <Button label="Cancel" onPress={onCancel} />
            <Button label="Save" primary onPress={() => onSubmit(value.trim())} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: space(6) },
  dialog: {
    backgroundColor: colors.ink,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    padding: space(4),
    gap: space(3),
    maxWidth: 420,
    width: '100%',
    alignSelf: 'center',
  },
  title: { color: colors.text, fontSize: type.title, fontWeight: '600' },
  input: {
    paddingHorizontal: space(3),
    paddingVertical: space(2.5),
    borderRadius: 8,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line,
    color: colors.text,
    fontSize: type.body,
  },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space(2) },
});
