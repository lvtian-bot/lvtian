import React from 'react';
import {
    Modal,
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    TouchableWithoutFeedback,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialIcons';
import { theme } from '../utils/theme';

export interface ActionItem {
    label: string;
    icon?: string;
    onPress: () => void;
    destructive?: boolean;
    color?: string;
}

interface ActionSheetModalProps {
    visible: boolean;
    title?: string;
    actions: ActionItem[];
    onCancel: () => void;
}

export const ActionSheetModal: React.FC<ActionSheetModalProps> = ({
    visible,
    title,
    actions,
    onCancel,
}) => {
    if (!visible) return null;

    return (
        <Modal
            transparent
            visible={visible}
            animationType="fade"
            onRequestClose={onCancel}
        >
            <TouchableOpacity
                style={styles.overlay}
                activeOpacity={1}
                onPress={onCancel}
            >
                <TouchableWithoutFeedback>
                    <SafeAreaView style={styles.contentContainer}>
                        {title && (
                            <View style={styles.header}>
                                <Text style={styles.title} numberOfLines={1}>
                                    {title}
                                </Text>
                            </View>
                        )}
                        <View style={styles.actionsContainer}>
                            {actions.map((action, index) => (
                                <TouchableOpacity
                                    key={index}
                                    style={[
                                        styles.actionButton,
                                        index < actions.length - 1 && styles.divider,
                                    ]}
                                    onPress={() => {
                                        onCancel();
                                        // Small delay to allow modal to close smoothly
                                        setTimeout(action.onPress, 100);
                                    }}
                                >
                                    {action.icon && (
                                        <Icon
                                            name={action.icon}
                                            size={24}
                                            color={
                                                action.color ||
                                                (action.destructive
                                                    ? theme.colors.error
                                                    : theme.colors.text)
                                            }
                                            style={styles.icon}
                                        />
                                    )}
                                    <Text
                                        style={[
                                            styles.actionText,
                                            {
                                                color:
                                                    action.color ||
                                                    (action.destructive
                                                        ? theme.colors.error
                                                        : theme.colors.text),
                                            },
                                        ]}
                                    >
                                        {action.label}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                        <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
                            <Text style={styles.cancelText}>取消</Text>
                        </TouchableOpacity>
                    </SafeAreaView>
                </TouchableWithoutFeedback>
            </TouchableOpacity>
        </Modal>
    );
};

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        justifyContent: 'flex-end',
    },
    contentContainer: {
        backgroundColor: 'transparent',
        padding: theme.spacing.m,
    },
    header: {
        backgroundColor: theme.colors.surface,
        padding: theme.spacing.m,
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        alignItems: 'center',
        marginBottom: 1, // Separator
    },
    title: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        fontWeight: '500',
    },
    actionsContainer: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        overflow: 'hidden',
        marginBottom: theme.spacing.m,
    },
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: theme.spacing.l,
        backgroundColor: theme.colors.surface,
    },
    divider: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border,
    },
    icon: {
        marginRight: theme.spacing.m,
    },
    actionText: {
        fontSize: 16,
        fontWeight: '500',
    },
    cancelButton: {
        backgroundColor: theme.colors.surface,
        padding: theme.spacing.l,
        borderRadius: 12,
        alignItems: 'center',
        marginTop: 0,
    },
    cancelText: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.primary,
    },
});
