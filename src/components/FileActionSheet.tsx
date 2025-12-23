import React from 'react';
import {
    Modal,
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    TouchableWithoutFeedback,
} from 'react-native';
import Icon from '@expo/vector-icons/MaterialIcons';
import { theme } from '../utils/theme';
import { useTranslation } from 'react-i18next';

export interface FileAction {
    label: string;
    icon: string;
    onPress: () => void;
    destructive?: boolean;
}

interface FileActionSheetProps {
    visible: boolean;
    fileName: string;
    actions: FileAction[];
    onCancel: () => void;
}

export const FileActionSheet: React.FC<FileActionSheetProps> = ({
    visible,
    fileName,
    actions,
    onCancel,
}) => {
    const { t } = useTranslation();
    return (
        <Modal
            animationType="fade"
            transparent={true}
            visible={visible}
            onRequestClose={onCancel}
        >
            <TouchableWithoutFeedback onPress={onCancel}>
                <View style={styles.overlay}>
                    <TouchableWithoutFeedback>
                        <View style={styles.container}>
                            <View style={styles.header}>
                                <Text style={styles.fileName} numberOfLines={1}>
                                    {fileName}
                                </Text>
                            </View>

                            <View style={styles.actionsContainer}>
                                {actions.map((action, index) => (
                                    <TouchableOpacity
                                        key={index}
                                        style={styles.actionItem}
                                        onPress={action.onPress}
                                    >
                                        <Icon
                                            name={action.icon as any}
                                            size={24}
                                            color={action.destructive ? theme.colors.error : theme.colors.text}
                                        />
                                        <Text
                                            style={[
                                                styles.actionText,
                                                action.destructive && styles.destructiveText,
                                            ]}
                                        >
                                            {action.label}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>

                            <TouchableOpacity
                                style={styles.cancelButton}
                                onPress={onCancel}
                            >
                                <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                            </TouchableOpacity>
                        </View>
                    </TouchableWithoutFeedback>
                </View>
            </TouchableWithoutFeedback>
        </Modal>
    );
};

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        justifyContent: 'flex-end',
    },
    container: {
        backgroundColor: theme.colors.white,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        paddingBottom: theme.spacing.l,
    },
    header: {
        padding: theme.spacing.l,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
    },
    fileName: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text,
        textAlign: 'center',
    },
    actionsContainer: {
        paddingTop: theme.spacing.s,
    },
    actionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: theme.spacing.l,
        paddingVertical: theme.spacing.m,
    },
    actionText: {
        fontSize: 16,
        color: theme.colors.text,
        marginLeft: theme.spacing.m,
    },
    destructiveText: {
        color: theme.colors.error,
    },
    cancelButton: {
        marginTop: theme.spacing.s,
        marginHorizontal: theme.spacing.l,
        padding: theme.spacing.m,
        backgroundColor: theme.colors.surface,
        borderRadius: 10,
        alignItems: 'center',
    },
    cancelText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        fontWeight: '600',
    },
});
