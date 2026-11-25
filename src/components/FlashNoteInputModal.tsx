import React, { useState, useEffect, useRef, type ComponentRef } from 'react';
import {
    Modal,
    View,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    Platform,
    Alert,
    KeyboardAvoidingView,
    useWindowDimensions,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import Icon from '@expo/vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { textInputColors, theme } from '../utils/theme';
import { getFontSizeMetrics } from '../utils/fontSize';
import { useSettingsStore } from '../store/useSettingsStore';

interface FlashNoteInputModalProps {
    visible: boolean;
    initialId?: string; // For editing existing note
    initialContent?: string;
    onSave: (id: string | undefined, content: string) => void;
    onCancel: () => void;
    onExpand?: (content: string) => void;
}

const MIN_INPUT_LINES = 2;
const MAX_INPUT_LINES = 6;
const INPUT_VERTICAL_PADDING = 3;
const ACTION_SIZE = 44;

const FLASH_NOTE_DRAFT_NEW = 'flash_note_draft_new';
const FLASH_NOTE_DRAFT_EDIT_PREFIX = 'flash_note_draft_edit_';

export const FlashNoteInputModal: React.FC<FlashNoteInputModalProps> = ({
    visible,
    initialId,
    initialContent,
    onSave,
    onCancel,
    onExpand,
}) => {
    const { t } = useTranslation();
    const [inputText, setInputText] = useState(initialContent || '');
    const [inputMeasuredHeight, setInputMeasuredHeight] = useState(0);
    const fontSize = useSettingsStore(state => state.fontSize);
    const { flashBody, flashLineHeight } = getFontSizeMetrics(fontSize);
    const { fontScale } = useWindowDimensions();

    const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
    const isDraftLoaded = useRef(false);

    const scaledLineHeight = Math.ceil(flashLineHeight * fontScale);
    const minInputHeight = MIN_INPUT_LINES * scaledLineHeight + INPUT_VERTICAL_PADDING * 2;
    const maxInputHeight = MAX_INPUT_LINES * scaledLineHeight + INPUT_VERTICAL_PADDING * 2;
    const inputHeight = Math.max(minInputHeight, Math.min(inputMeasuredHeight, maxInputHeight));
    const canSave = inputText.trim().length > 0;

    // Load draft when modal becomes visible
    useEffect(() => {
        if (visible) {
            const checkDraft = async () => {
                try {
                    const draftKey = initialId
                        ? `${FLASH_NOTE_DRAFT_EDIT_PREFIX}${initialId}`
                        : FLASH_NOTE_DRAFT_NEW;
                    const draftContent = await AsyncStorage.getItem(draftKey);

                    if (draftContent && draftContent !== (initialContent || '')) {
                        Alert.alert(
                            t('common.draftFound'),
                            t('common.restoreDraftPrompt'),
                            [
                                {
                                    text: t('common.discard'),
                                    style: 'destructive',
                                    onPress: async () => {
                                        await AsyncStorage.removeItem(draftKey);
                                        setInputText(initialContent || '');
                                        isDraftLoaded.current = true;
                                    },
                                },
                                {
                                    text: t('common.restore'),
                                    onPress: () => {
                                        setInputText(draftContent);
                                        isDraftLoaded.current = true;
                                    },
                                },
                            ]
                        );
                    } else {
                        setInputText(initialContent || '');
                        isDraftLoaded.current = true;
                    }
                } catch (error) {
                    console.error('Failed to load draft:', error);
                    setInputText(initialContent || '');
                    isDraftLoaded.current = true;
                }
            };

            isDraftLoaded.current = false;
            checkDraft();
        }
    }, [visible, initialId, initialContent, t]);

    // Auto-save draft
    useEffect(() => {
        if (!visible || !isDraftLoaded.current) return;

        const saveDraft = async () => {
            try {
                const draftKey = initialId
                    ? `${FLASH_NOTE_DRAFT_EDIT_PREFIX}${initialId}`
                    : FLASH_NOTE_DRAFT_NEW;

                if (inputText && inputText !== (initialContent || '')) {
                    await AsyncStorage.setItem(draftKey, inputText);
                } else {
                    await AsyncStorage.removeItem(draftKey);
                }
            } catch (error) {
                console.error('Failed to save draft:', error);
            }
        };

        const timeoutId = setTimeout(saveDraft, 500);
        return () => clearTimeout(timeoutId);
    }, [inputText, visible, initialId, initialContent]);

    const handleSave = async () => {
        const trimmed = inputText.trim();
        if (!trimmed) {
            Alert.alert(t('common.error'), t('timeline.emptyNoteError'));
            return;
        }

        try {
            const draftKey = initialId
                ? `${FLASH_NOTE_DRAFT_EDIT_PREFIX}${initialId}`
                : FLASH_NOTE_DRAFT_NEW;
            await AsyncStorage.removeItem(draftKey);
        } catch (error) {
            console.error('Failed to clear draft:', error);
        }

        onSave(initialId, trimmed);
    };

    const handleCancel = async () => {
        if (inputText !== (initialContent || '')) {
            Alert.alert(
                t('common.confirm'),
                t('common.saveChangesPrompt'),
                [
                    {
                        text: t('common.dontSave'),
                        style: 'destructive',
                        onPress: async () => {
                            try {
                                const draftKey = initialId
                                    ? `${FLASH_NOTE_DRAFT_EDIT_PREFIX}${initialId}`
                                    : FLASH_NOTE_DRAFT_NEW;
                                await AsyncStorage.removeItem(draftKey);
                            } catch (error) {
                                console.error('Failed to clear draft:', error);
                            }
                            onCancel();
                        },
                    },
                    {
                        text: t('common.cancel'),
                        style: 'cancel',
                    },
                    {
                        text: t('common.save'),
                        onPress: handleSave,
                    },
                ]
            );
        } else {
            onCancel();
        }
    };

    return (
        <Modal
            visible={visible}
            transparent={true}
            animationType="fade"
            onRequestClose={handleCancel}
            onShow={() => {
                setTimeout(() => {
                    inputRef.current?.focus();
                }, 100);
            }}
        >
            <KeyboardAvoidingView
                style={styles.keyboardAvoidingView}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
                <TouchableOpacity
                    style={styles.overlay}
                    activeOpacity={1}
                    accessible={false}
                    onPress={handleCancel}
                />

                <View style={styles.modalContent}>
                    <TextInput
                        {...textInputColors}
                        ref={inputRef}
                        style={[
                            styles.input,
                            { height: inputHeight, fontSize: flashBody, lineHeight: flashLineHeight },
                        ]}
                        multiline
                        placeholder={t('timeline.placeholder')}
                        placeholderTextColor={theme.colors.textSecondary}
                        value={inputText}
                        onChangeText={setInputText}
                        textAlignVertical="top"
                        underlineColorAndroid="transparent"
                        onContentSizeChange={(event) => {
                            setInputMeasuredHeight(Math.ceil(event.nativeEvent.contentSize.height));
                        }}
                    />
                    <View style={styles.actionContainer}>
                        {onExpand && (
                            <TouchableOpacity
                                accessibilityRole="button"
                                accessibilityLabel={t('common.edit')}
                                onPress={() => onExpand(inputText)}
                                style={styles.expandButton}
                            >
                                <View style={styles.expandIcon}>
                                    <Icon name="fullscreen" size={20} color={theme.colors.textSecondary} />
                                </View>
                            </TouchableOpacity>
                        )}
                        <TouchableOpacity
                            accessibilityRole="button"
                            accessibilityLabel={t('common.save')}
                            disabled={!canSave}
                            onPress={handleSave}
                            style={[styles.sendButton, !canSave && styles.sendButtonDisabled]}
                        >
                            <Icon name="send" size={20} color={canSave ? theme.colors.white : theme.colors.textSecondary} />
                        </TouchableOpacity>
                    </View>
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
};

const styles = StyleSheet.create({
    keyboardAvoidingView: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    overlay: {
        ...StyleSheet.absoluteFill,
        backgroundColor: 'rgba(20, 29, 45, 0.24)',
    },
    modalContent: {
        flexShrink: 1,
        backgroundColor: theme.colors.surface,
        borderTopLeftRadius: theme.radius.lg,
        borderTopRightRadius: theme.radius.lg,
        paddingHorizontal: 18,
        paddingTop: 15,
        paddingBottom: Platform.OS === 'ios' ? 24 : 9,
        shadowColor: theme.colors.black,
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.09,
        shadowRadius: 8,
        elevation: 4,
    },
    input: {
        flexShrink: 1,
        paddingHorizontal: 2,
        paddingVertical: INPUT_VERTICAL_PADDING,
        includeFontPadding: false,
        color: theme.colors.text,
    },
    actionContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    expandButton: {
        width: ACTION_SIZE,
        height: ACTION_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
    expandIcon: {
        width: 34,
        height: 34,
        borderRadius: 17,
        borderWidth: 1,
        borderColor: theme.colors.border,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sendButton: {
        width: ACTION_SIZE,
        height: ACTION_SIZE,
        borderRadius: ACTION_SIZE / 2,
        marginLeft: 'auto',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.primaryDark,
    },
    sendButtonDisabled: {
        backgroundColor: theme.colors.inputBg,
    },
});
