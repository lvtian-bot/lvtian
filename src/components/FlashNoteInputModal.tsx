import React, { useState, useEffect, useRef } from 'react';
import {
    Modal,
    View,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
    Dimensions,
    Alert,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import Icon from 'react-native-vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { theme } from '../utils/theme';

interface FlashNoteInputModalProps {
    visible: boolean;
    initialId?: string; // For editing existing note
    initialContent?: string;
    onSave: (id: string | undefined, content: string) => void;
    onCancel: () => void;
}

const { height: screenHeight } = Dimensions.get('window');
const MIN_INPUT_HEIGHT_LINES = 8; // Increased height
const MAX_INPUT_HEIGHT_RATIO = 0.5; // Increased max height ratio

const TEXT_INPUT_FONT_SIZE = 16;

const FLASH_NOTE_DRAFT_NEW = 'flash_note_draft_new';
const FLASH_NOTE_DRAFT_EDIT_PREFIX = 'flash_note_draft_edit_';

export const FlashNoteInputModal: React.FC<FlashNoteInputModalProps> = ({
    visible,
    initialId,
    initialContent,
    onSave,
    onCancel,
}) => {
    const { t } = useTranslation();
    const [inputText, setInputText] = useState(initialContent || '');
    const [inputMeasuredHeight, setInputMeasuredHeight] = useState(0);
    const inputRef = useRef<TextInput>(null);
    const isDraftLoaded = useRef(false); // Ref to track if draft check is done to avoid overwriting with initialContent

    const MIN_HEIGHT = MIN_INPUT_HEIGHT_LINES * TEXT_INPUT_FONT_SIZE * 1.5;
    const MAX_HEIGHT = screenHeight * MAX_INPUT_HEIGHT_RATIO;

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
                setInputMeasuredHeight(MIN_HEIGHT);
            };

            // Reset state before checking draft
            isDraftLoaded.current = false;
            checkDraft();
        }
    }, [visible, initialId, initialContent, MIN_HEIGHT, t]);


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
                    // If content matches initial (or empty), remove draft to keep clean
                    await AsyncStorage.removeItem(draftKey);
                }
            } catch (error) {
                console.error('Failed to save draft:', error);
            }
        };

        const timeoutId = setTimeout(saveDraft, 500); // Debounce save
        return () => clearTimeout(timeoutId);
    }, [inputText, visible, initialId, initialContent]);


    const handleSave = async () => {
        if (!inputText.trim()) {
            Alert.alert(t('common.error'), t('timeline.emptyNoteError'));
            return;
        }

        // Clear draft on save
        try {
            const draftKey = initialId
                ? `${FLASH_NOTE_DRAFT_EDIT_PREFIX}${initialId}`
                : FLASH_NOTE_DRAFT_NEW;
            await AsyncStorage.removeItem(draftKey);
        } catch (error) {
            console.error('Failed to clear draft:', error);
        }

        onSave(initialId, inputText);
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
                            // Clear draft on discard
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
            animationType="slide"
            transparent={true}
            visible={visible}
            onRequestClose={handleCancel}
            onShow={() => {
                setTimeout(() => {
                    inputRef.current?.focus();
                }, 100);
            }}
        >
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                style={styles.keyboardAvoidingView}
            >
                <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={handleCancel} />

                <View style={styles.modalContentContainer}>
                    <TextInput
                        ref={inputRef}
                        style={[
                            styles.input,
                            { height: Math.max(MIN_HEIGHT, Math.min(inputMeasuredHeight, MAX_HEIGHT)) }
                        ]}
                        multiline
                        placeholder={t('timeline.placeholder')}
                        value={inputText}
                        onChangeText={setInputText}
                        textAlignVertical="top"
                        onContentSizeChange={(event) => {
                            setInputMeasuredHeight(event.nativeEvent.contentSize.height);
                        }}
                    />
                    <View style={styles.actionContainer}>
                        <TouchableOpacity onPress={handleSave} style={styles.sendButton}>
                            <Icon name="send" size={24} color={theme.colors.primary} />
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
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.5)',
    },
    modalContentContainer: {
        width: '100%',
        backgroundColor: theme.colors.white,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        overflow: 'hidden',
        paddingBottom: theme.spacing.m, // Add padding for the button area
    },
    input: {
        fontSize: TEXT_INPUT_FONT_SIZE,
        color: theme.colors.text,
        padding: theme.spacing.l,
        paddingTop: theme.spacing.l,
        paddingBottom: theme.spacing.xl, // Reduced from xl * 2 (64) to xxl (48)
        backgroundColor: 'transparent', // 确保不覆盖圆角
    },
    actionContainer: {
        position: 'absolute',
        right: theme.spacing.l,
        bottom: theme.spacing.xs, // Reduced from s (8) to xs (4)
        flexDirection: 'row',
        justifyContent: 'flex-end',
    },
    sendButton: {
        padding: theme.spacing.s,
        backgroundColor: theme.colors.surface, // Optional: add background to button if needed, or keep transparent
        borderRadius: 20,
    },
});
