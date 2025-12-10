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
    Text,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import Icon from '@expo/vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { theme } from '../utils/theme';
import { Priority } from '../types/todo';

interface FlashNoteInputModalProps {
    visible: boolean;
    initialId?: string; // For editing existing note
    initialContent?: string;
    initialPriority?: Priority;
    initialDueAt?: string;
    onSave: (id: string | undefined, content: string) => void;
    onCancel: () => void;
    mode?: 'todo' | 'note';
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
    initialPriority,
    initialDueAt,
    onSave,
    onCancel,
    mode = 'todo',
}) => {
    const { t } = useTranslation();
    const [inputText, setInputText] = useState(initialContent || '');
    const [priority, setPriority] = useState<Priority>(initialPriority || 'none');
    const [dueAt, setDueAt] = useState<string | undefined>(initialDueAt);
    const [inputMeasuredHeight, setInputMeasuredHeight] = useState(0);
    const [showDateInput, setShowDateInput] = useState(false);

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

            // Reset fields if not draft (draft logic handles text, but what about fields? 
            // For simplicity, draft only restores text. Fields reset to initial.)
            setPriority(initialPriority || 'none');
            setDueAt(initialDueAt);
            setShowDateInput(!!initialDueAt);
        }
    }, [visible, initialId, initialContent, initialPriority, initialDueAt, MIN_HEIGHT, t]);


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


    const handleSaveWithTags = async () => {
        if (!inputText.trim()) {
            Alert.alert(t('common.error'), t('timeline.emptyNoteError'));
            return;
        }

        // Construct content with tags
        let finalContent = inputText.trim();

        // Add Priority Tag
        if (priority !== 'none') {
            switch (priority) {
                case 'highest': finalContent += ' 🔺'; break;
                case 'high': finalContent += ' ⏫'; break;
                case 'medium': finalContent += ' 🔼'; break;
                case 'low': finalContent += ' 🔽'; break;
                case 'lowest': finalContent += ' ⏬'; break;
            }
        }

        // Add Due Date Tag
        if (dueAt) {
            finalContent += ` 📅 ${dueAt}`;
        }

        // Clear draft
        try {
            const draftKey = initialId
                ? `${FLASH_NOTE_DRAFT_EDIT_PREFIX}${initialId}`
                : FLASH_NOTE_DRAFT_NEW;
            await AsyncStorage.removeItem(draftKey);
        } catch (error) {
            console.error('Failed to clear draft:', error);
        }

        onSave(initialId, finalContent);
    };

    const togglePriority = () => {
        const order: Priority[] = ['none', 'highest', 'high', 'medium', 'low', 'lowest'];
        const currentIndex = order.indexOf(priority);
        const nextIndex = (currentIndex + 1) % order.length;
        setPriority(order[nextIndex]);
    };

    const getPriorityDisplay = () => {
        switch (priority) {
            case 'highest': return { icon: 'error', label: t('priority.highest') || 'Highest', color: theme.colors.danger || '#F44336' };
            case 'high': return { icon: 'keyboard-double-arrow-up', label: t('priority.high') || 'High', color: theme.colors.orange || '#FF9800' };
            case 'medium': return { icon: 'keyboard-arrow-up', label: t('priority.medium') || 'Medium', color: theme.colors.warning || '#FFC107' };
            case 'low': return { icon: 'keyboard-arrow-down', label: t('priority.low') || 'Low', color: theme.colors.info || '#2196F3' };
            case 'lowest': return { icon: 'keyboard-double-arrow-down', label: t('priority.lowest') || 'Lowest', color: theme.colors.textSecondary || '#9E9E9E' };
            default: return { icon: 'outlined-flag', label: t('priority.none') || 'Priority', color: theme.colors.textSecondary };
        }
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
                        onPress: handleSaveWithTags,
                    },
                ]
            );
        } else {
            onCancel();
        }
    };

    const priorityDisplay = getPriorityDisplay();

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
                        <View style={styles.toolbar}>
                            {mode === 'todo' && (
                                <>
                                    <TouchableOpacity
                                        onPress={togglePriority}
                                        style={[
                                            styles.priorityButton,
                                            { borderColor: priorityDisplay.color }
                                        ]}
                                    >
                                        <Icon name={priorityDisplay.icon} size={16} color={priorityDisplay.color} />
                                        <Text style={[styles.priorityButtonText, { color: priorityDisplay.color }]}>
                                            {priorityDisplay.label}
                                        </Text>
                                    </TouchableOpacity>

                                    {showDateInput || dueAt ? (
                                        <View style={styles.dateInputContainer}>
                                            <Icon name="event" size={20} color={theme.colors.primary} style={styles.dateIcon} />
                                            <TextInput
                                                style={styles.dateInput}
                                                value={dueAt || ''}
                                                onChangeText={setDueAt}
                                                placeholder="YYYY-MM-DD"
                                                placeholderTextColor={theme.colors.textSecondary}
                                                keyboardType="numeric"
                                                maxLength={10}
                                                autoFocus
                                                onBlur={() => { if (!dueAt) setShowDateInput(false); }}
                                            />
                                            {dueAt ? (
                                                <TouchableOpacity onPress={() => { setDueAt(undefined); setShowDateInput(false); }} style={styles.clearDateButton}>
                                                    <Icon name="close" size={16} color={theme.colors.textSecondary} />
                                                </TouchableOpacity>
                                            ) : null}
                                        </View>
                                    ) : (
                                        <TouchableOpacity onPress={() => setShowDateInput(true)} style={styles.toolbarButton}>
                                            <Icon name="event" size={24} color={theme.colors.textSecondary} />
                                        </TouchableOpacity>
                                    )}
                                </>
                            )}
                        </View>
                        <TouchableOpacity onPress={handleSaveWithTags} style={styles.sendButton}>
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
        bottom: theme.spacing.xs,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        left: theme.spacing.l, // Make it span full width minus padding
    },
    toolbar: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    priorityButton: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 16,
        borderWidth: 1,
        marginRight: theme.spacing.s,
        backgroundColor: theme.colors.background,
    },
    priorityButtonText: {
        fontSize: 12,
        fontWeight: '600',
        marginLeft: 4,
    },
    toolbarButton: {
        padding: theme.spacing.s,
        marginRight: theme.spacing.s,
    },
    sendButton: {
        padding: theme.spacing.s,
        backgroundColor: theme.colors.surface,
        borderRadius: 20,
    },
    dateInputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.background,
        borderRadius: 16,
        paddingHorizontal: theme.spacing.s,
        height: 40,
        marginLeft: theme.spacing.s,
    },
    dateIcon: {
        marginRight: 4,
    },
    dateInput: {
        fontSize: 14,
        color: theme.colors.text,
        minWidth: 100,
        paddingVertical: 0,
    },
    clearDateButton: {
        padding: 4,
    },
});
