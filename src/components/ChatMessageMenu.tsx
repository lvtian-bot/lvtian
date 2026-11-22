import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { theme } from '../utils/theme';

export type MessageAction = 'copy' | 'select' | 'cancel' | 'edit';
export interface MessageMenuAnchor { id: string; x: number; y: number }

export function ChatMessageMenu({ anchor, pending, close, choose }: {
    anchor: MessageMenuAnchor;
    pending: boolean;
    close: () => void;
    choose: (action: MessageAction) => void;
}) {
    const { t } = useTranslation();
    const { width, height } = useWindowDimensions();
    const actions: MessageAction[] = pending ? ['copy', 'select', 'cancel', 'edit'] : ['copy', 'select'];
    const left = Math.max(8, Math.min(anchor.x - 68, width - 144));
    const top = Math.max(8, Math.min(anchor.y, height - actions.length * 48 - 16));
    return <Modal transparent onRequestClose={close} animationType="none">
        <Pressable style={StyleSheet.absoluteFill} accessible={false} onPress={close} />
        <View style={[styles.menu, { left, top }]}>
            {actions.map(action => <Pressable accessibilityRole="button" key={action} style={styles.item}
                onPress={() => choose(action)}>
                <Text style={styles.label}>{t(`common.${action}`)}</Text>
            </Pressable>)}
        </View>
    </Modal>;
}

const styles = StyleSheet.create({
    menu: { position: 'absolute', width: 136, paddingVertical: 4, borderRadius: 12, elevation: 6,
        backgroundColor: theme.colors.surface, borderColor: theme.colors.border, borderWidth: StyleSheet.hairlineWidth },
    item: { minHeight: 48, paddingHorizontal: 18, justifyContent: 'center' },
    label: { fontSize: 16, color: theme.colors.text },
});
