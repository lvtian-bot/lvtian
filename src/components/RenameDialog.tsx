import React, { useState, useEffect, useRef } from 'react';
import {
    Modal,
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
} from 'react-native';
import { theme } from '../utils/theme';

interface RenameDialogProps {
    visible: boolean;
    currentName: string;
    onConfirm: (newName: string) => void;
    onCancel: () => void;
}

export const RenameDialog: React.FC<RenameDialogProps> = ({
    visible,
    currentName,
    onConfirm,
    onCancel,
}) => {
    const [newName, setNewName] = useState(currentName);
    const inputRef = useRef<TextInput>(null);

    useEffect(() => {
        if (visible) {
            setNewName(currentName);
            // 自动聚焦并选中文件名（不含扩展名）
            setTimeout(() => {
                inputRef.current?.focus();
            }, 100);
        }
    }, [visible, currentName]);

    const handleConfirm = () => {
        const trimmedName = newName.trim();
        if (trimmedName && trimmedName !== currentName) {
            onConfirm(trimmedName);
        }
        onCancel();
    };

    return (
        <Modal
            animationType="fade"
            transparent={true}
            visible={visible}
            onRequestClose={onCancel}
        >
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                style={styles.overlay}
            >
                <View style={styles.container}>
                    <Text style={styles.title}>重命名</Text>

                    <TextInput
                        ref={inputRef}
                        style={styles.input}
                        value={newName}
                        onChangeText={setNewName}
                        placeholder="输入新名称"
                        autoFocus
                        selectTextOnFocus
                        onSubmitEditing={handleConfirm}
                    />

                    <View style={styles.buttonContainer}>
                        <TouchableOpacity
                            style={[styles.button, styles.cancelButton]}
                            onPress={onCancel}
                        >
                            <Text style={styles.cancelButtonText}>取消</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[styles.button, styles.confirmButton]}
                            onPress={handleConfirm}
                        >
                            <Text style={styles.confirmButtonText}>确认</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
};

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    container: {
        width: '80%',
        backgroundColor: theme.colors.white,
        borderRadius: 12,
        padding: theme.spacing.l,
    },
    title: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: theme.spacing.m,
        textAlign: 'center',
    },
    input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: theme.spacing.m,
        fontSize: 16,
        color: theme.colors.text,
        marginBottom: theme.spacing.l,
    },
    buttonContainer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    button: {
        flex: 1,
        padding: theme.spacing.m,
        borderRadius: 8,
        alignItems: 'center',
    },
    cancelButton: {
        backgroundColor: theme.colors.surface,
        marginRight: theme.spacing.s,
    },
    cancelButtonText: {
        color: theme.colors.textSecondary,
        fontSize: 16,
        fontWeight: '600',
    },
    confirmButton: {
        backgroundColor: theme.colors.primary,
        marginLeft: theme.spacing.s,
    },
    confirmButtonText: {
        color: theme.colors.white,
        fontSize: 16,
        fontWeight: '600',
    },
});
