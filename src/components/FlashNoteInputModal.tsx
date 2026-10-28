import React, { useState, useEffect, useRef, useMemo, type ComponentRef } from 'react';
import {
    Modal,
    View,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    Platform,
    Dimensions,
    Alert,
    Keyboard,
    KeyboardEvent,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import Icon from '@expo/vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { theme } from '../utils/theme';

interface FlashNoteInputModalProps {
    visible: boolean;
    initialId?: string; // For editing existing note
    initialContent?: string;
    onSave: (id: string | undefined, content: string) => void;
    onCancel: () => void;
    onExpand?: (content: string) => void;
}

const { height: screenHeight } = Dimensions.get('window');
const MIN_INPUT_HEIGHT_LINES = 10;
const MAX_INPUT_HEIGHT_RATIO = 0.5;

const TEXT_INPUT_FONT_SIZE = 16;

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

    const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
    const isDraftLoaded = useRef(false);

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

    // Keyboard Handling for Android
    const [keyboardHeight, setKeyboardHeight] = useState(0);

    useEffect(() => {
        const onKeyboardShow = (e: KeyboardEvent) => {
            setKeyboardHeight(e.endCoordinates.height);
        };
        const onKeyboardHide = () => {
            setKeyboardHeight(0);
        };

        const showSubscription = Keyboard.addListener(
            Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
            onKeyboardShow
        );
        const hideSubscription = Keyboard.addListener(
            Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
            onKeyboardHide
        );

        return () => {
            showSubscription.remove();
            hideSubscription.remove();
        };
    }, []);

    const keyboardAvoidingStyle = useMemo(() => {
        return [
            styles.keyboardAvoidingView,
            Platform.OS === 'android' ? { marginBottom: keyboardHeight } : {}
        ];
    }, [keyboardHeight]);

    const modalContentStyle = useMemo(() => {
        return [
            styles.modalContent,
            Platform.OS === 'ios' ? { marginBottom: keyboardHeight } : {}
        ];
    }, [keyboardHeight]);

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
            <View style={keyboardAvoidingStyle}>
                <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={handleCancel} />

                <View style={modalContentStyle}>
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
                        <View style={styles.toolbar}>
                            {onExpand && (
                                <TouchableOpacity onPress={() => onExpand(inputText)} style={styles.toolbarButton}>
                                    <Icon name="fullscreen" size={24} color={theme.colors.textSecondary} />
                                </TouchableOpacity>
                            )}
                        </View>
                        <TouchableOpacity onPress={handleSave} style={styles.sendButton}>
                            <Icon name="send" size={24} color={theme.colors.primary} />
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
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
        backgroundColor: 'rgba(0, 0, 0, 0.4)',
    },
    modalContent: {
        backgroundColor: theme.colors.surface,
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        padding: 16,
        paddingBottom: Platform.OS === 'ios' ? 24 : 16,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 5,
    },
    input: {
        backgroundColor: theme.colors.background,
        borderRadius: 8,
        padding: 12,
        fontSize: TEXT_INPUT_FONT_SIZE,
        color: theme.colors.text,
        borderWidth: 1,
        borderColor: '#e0e0e0',
    },
    actionContainer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginTop: 12,
    },
    toolbar: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    toolbarButton: {
        padding: 6,
        marginRight: 8,
    },
    sendButton: {
        padding: 8,
        backgroundColor: theme.colors.successBg,
        borderRadius: 20,
    },
});
