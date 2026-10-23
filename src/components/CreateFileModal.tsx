import React, { useState, useEffect, useRef, type ComponentRef } from 'react';
import {
    Modal,
    View,
    TextInput,
    TouchableOpacity,
    Text,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
    Alert,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { theme } from '../utils/theme';

interface CreateFileModalProps {
    visible: boolean;
    onConfirm: (filename: string) => void;
    onCancel: () => void;
}

export const CreateFileModal: React.FC<CreateFileModalProps> = ({
    visible,
    onConfirm,
    onCancel,
}) => {
    const { t } = useTranslation();
    const [filename, setFilename] = useState('');
    const inputRef = useRef<ComponentRef<typeof TextInput>>(null);

    useEffect(() => {
        if (visible) {
            setFilename('');
        }
    }, [visible]);

    const handleConfirm = () => {
        const trimmedName = filename.trim();
        if (!trimmedName) {
            Alert.alert(t('common.error'), t('browser.emptyFilenameError') || 'Filename cannot be empty');
            return;
        }
        onConfirm(trimmedName);
    };

    return (
        <Modal
            animationType="fade"
            transparent={true}
            visible={visible}
            onRequestClose={onCancel}
            onShow={() => {
                setTimeout(() => {
                    inputRef.current?.focus();
                }, 100);
            }}
        >
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={styles.keyboardAvoidingView}
            >
                <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onCancel}>
                    <View style={styles.modalContainer} onStartShouldSetResponder={() => true}>
                        <Text style={styles.title}>{t('browser.createNewFile') || 'Create New File'}</Text>

                        <TextInput
                            ref={inputRef}
                            style={styles.input}
                            placeholder={t('browser.enterFilename') || 'Enter filename (e.g. MyNote)'}
                            value={filename}
                            onChangeText={setFilename}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />

                        <View style={styles.buttonContainer}>
                            <TouchableOpacity style={[styles.button, styles.cancelButton]} onPress={onCancel}>
                                <Text style={styles.cancelButtonText}>{t('common.cancel')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={[styles.button, styles.confirmButton]} onPress={handleConfirm}>
                                <Text style={styles.confirmButtonText}>{t('common.create') || 'Create'}</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </TouchableOpacity>
            </KeyboardAvoidingView>
        </Modal>
    );
};

const styles = StyleSheet.create({
    keyboardAvoidingView: {
        flex: 1,
    },
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: theme.spacing.l,
    },
    modalContainer: {
        width: '100%',
        backgroundColor: theme.colors.white,
        borderRadius: 12,
        padding: theme.spacing.l,
        elevation: 5,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 3.84,
    },
    title: {
        fontSize: 18,
        fontWeight: 'bold',
        marginBottom: theme.spacing.m,
        color: theme.colors.text,
        textAlign: 'center',
    },
    input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        padding: theme.spacing.m,
        fontSize: 16,
        marginBottom: theme.spacing.l,
        color: theme.colors.text,
    },
    buttonContainer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    button: {
        flex: 1,
        paddingVertical: theme.spacing.m,
        borderRadius: 8,
        alignItems: 'center',
        marginHorizontal: theme.spacing.xs,
    },
    cancelButton: {
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.border,
    },
    confirmButton: {
        backgroundColor: theme.colors.primary,
    },
    cancelButtonText: {
        color: theme.colors.text,
        fontWeight: 'bold',
    },
    confirmButtonText: {
        color: theme.colors.white,
        fontWeight: 'bold',
    },
});
