import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Keyboard } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { fsService } from '../services/FileSystemService';
import { syncService } from '../services/SyncService';
import { theme } from '../utils/theme';

const FLASH_NOTE_FILE = 'flash_notes.md';

export const NewFlashNoteScreen = () => {
    const [inputText, setInputText] = useState('');
    const navigation = useNavigation();

    const handleSend = async () => {
        if (!inputText.trim()) return;

        const now = new Date();
        const timestamp = now.toISOString().replace('T', ' ').split('.')[0];
        const newEntry = `
# ${timestamp}
${inputText}
`;

        try {
            let currentContent = '';
            try {
                currentContent = await fsService.readFile(FLASH_NOTE_FILE);
            } catch (e) {
                // File doesn't exist, start empty
            }

            const newContent = currentContent + newEntry;
            await fsService.writeFile(FLASH_NOTE_FILE, newContent);

            syncService.syncFile(FLASH_NOTE_FILE);

            setInputText('');
            Keyboard.dismiss();
            navigation.goBack();
        } catch (error) {
            console.error('Failed to save flash note', error);
        }
    };

    return (
        <View style={styles.container}>
            <Text style={styles.sheetTitle}>New Flash Note</Text>
            <TextInput
                style={styles.input}
                multiline
                placeholder="What's on your mind?"
                value={inputText}
                onChangeText={setInputText}
                autoFocus
            />
            <TouchableOpacity style={styles.sendButton} onPress={handleSend}>
                <Text style={styles.sendButtonText}>Send</Text>
            </TouchableOpacity>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: theme.spacing.m,
        backgroundColor: theme.colors.background,
    },
    sheetTitle: {
        fontSize: theme.typography.h3.fontSize,
        fontWeight: 'bold',
        marginBottom: theme.spacing.m,
        color: theme.colors.text,
    },
    input: {
        flex: 1,
        backgroundColor: theme.colors.surface,
        borderRadius: 8,
        padding: theme.spacing.m,
        marginBottom: theme.spacing.m,
        textAlignVertical: 'top',
        fontSize: 16,
    },
    sendButton: {
        backgroundColor: theme.colors.primary,
        padding: theme.spacing.m,
        borderRadius: 8,
        alignItems: 'center',
    },
    sendButtonText: {
        color: theme.colors.white,
        fontWeight: 'bold',
        fontSize: 16,
    },
});
