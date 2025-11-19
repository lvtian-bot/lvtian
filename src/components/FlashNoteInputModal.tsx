import React, { useState, useEffect } from 'react';
import {
    Modal,
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
    Dimensions,
    Alert,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { theme } from '../utils/theme';

interface FlashNoteInputModalProps {
    visible: boolean;
    initialId?: string; // For editing existing note
    initialContent?: string;
    onSave: (id: string | undefined, content: string) => void;
    onCancel: () => void;
}

const { height: screenHeight } = Dimensions.get('window');
const MIN_INPUT_HEIGHT_LINES = 6; // Start with 6 lines height
const MAX_INPUT_HEIGHT_RATIO = 0.4; // Max 40% of screen height for input

const TEXT_INPUT_FONT_SIZE = 16; // Moved outside the component

export const FlashNoteInputModal: React.FC<FlashNoteInputModalProps> = ({
    visible,
    initialId,
    initialContent,
    onSave,
    onCancel,
}) => {
    const { t } = useTranslation();
    const [inputText, setInputText] = useState(initialContent || '');
    const [inputMeasuredHeight, setInputMeasuredHeight] = useState(0); // Measured height from onContentSizeChange

    // Calculate effective min/max heights dynamically
    const MIN_HEIGHT = MIN_INPUT_HEIGHT_LINES * TEXT_INPUT_FONT_SIZE * 1.5; // Estimate line height is 1.5 times font size
    const MAX_HEIGHT = screenHeight * MAX_INPUT_HEIGHT_RATIO;

    useEffect(() => {
        if (visible) {
            setInputText(initialContent || '');
            // Reset measured height when modal opens or initial content changes
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

    const modalTitle = initialId ? t('timeline.editTitle') : t('timeline.newTitle');

    return (
        <Modal
            animationType="slide"
            transparent={true}
            visible={visible}
            onRequestClose={onCancel}
        >
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={styles.keyboardAvoidingView}
            >
                {/* Overlay to dim background and close modal on tap outside */}
                <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onCancel} />

                <View style={styles.modalContentContainer}>
                    <View style={styles.header}>
                        <TouchableOpacity onPress={onCancel}>
                            <Text style={styles.headerButtonText}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                        <Text style={styles.modalTitle}>{modalTitle}</Text>
                        <TouchableOpacity onPress={handleSave}>
                            <Text style={[styles.headerButtonText, styles.saveButtonText]}>{t('common.save')}</Text>
                        </TouchableOpacity>
                    </View>
                    <TextInput
                        style={[
                            styles.input,
                            { height: Math.max(MIN_HEIGHT, Math.min(inputMeasuredHeight, MAX_HEIGHT)) }
                        ]}
                        multiline
                        placeholder={t('timeline.placeholder')}
                        value={inputText}
                        onChangeText={setInputText}
                        autoFocus
                        textAlignVertical="top"
                        onContentSizeChange={(event) => {
                            setInputMeasuredHeight(event.nativeEvent.contentSize.height);
                        }}
                    />
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
};

const styles = StyleSheet.create({
    keyboardAvoidingView: {
        flex: 1,
        justifyContent: 'flex-end', // Keep modal at the bottom
    },
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)', // Dim background
    },
    modalContentContainer: {
        width: '100%',
        backgroundColor: theme.colors.white, // Changed to pure white
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        overflow: 'hidden', // Ensures border radius is applied correctly
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: theme.spacing.sm, // Reduced vertical padding
        paddingHorizontal: theme.spacing.l,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
    },
    modalTitle: {
        fontSize: 16, // Changed to 16
        fontWeight: 'bold',
        color: theme.colors.text,
    },
    headerButtonText: {
        fontSize: 16, // Changed to 16
        color: theme.colors.primary,
    },
    saveButtonText: {
        fontWeight: 'bold',
    },
    input: {
        fontSize: TEXT_INPUT_FONT_SIZE, // Use the defined font size
        color: theme.colors.text,
        padding: theme.spacing.l, // Consistent padding
        // Min/Max height handled by inline style
    },
});
