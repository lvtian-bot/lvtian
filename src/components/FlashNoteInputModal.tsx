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

    const MIN_HEIGHT = MIN_INPUT_HEIGHT_LINES * TEXT_INPUT_FONT_SIZE * 1.5;
    const MAX_HEIGHT = screenHeight * MAX_INPUT_HEIGHT_RATIO;

    useEffect(() => {
        if (visible) {
            setInputText(initialContent || '');
            setInputMeasuredHeight(MIN_HEIGHT);
        }
    }, [initialContent, visible, MIN_HEIGHT]);

    const handleSave = () => {
        if (!inputText.trim()) {
            Alert.alert(t('common.error'), t('timeline.emptyNoteError'));
            return;
        }
        onSave(initialId, inputText);
    };

    return (
        <Modal
            animationType="slide"
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
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                style={styles.keyboardAvoidingView}
            >
                <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onCancel} />

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
        paddingBottom: theme.spacing.xl * 2, // Extra padding at bottom to avoid text going behind button
        backgroundColor: 'transparent', // 确保不覆盖圆角
    },
    actionContainer: {
        position: 'absolute',
        right: theme.spacing.l,
        bottom: theme.spacing.s, // Changed from l (24) to s (8)
        flexDirection: 'row',
        justifyContent: 'flex-end',
    },
    sendButton: {
        padding: theme.spacing.s,
        backgroundColor: theme.colors.surface, // Optional: add background to button if needed, or keep transparent
        borderRadius: 20,
    },
});
