import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { fsService } from '../services/FileSystemService';
import { syncService } from '../services/SyncService';
import { theme } from '../utils/theme';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';

interface FlashNote {
    id: string;
    timestamp: string;
    content: string;
}

const FLASH_NOTE_FILE = 'flash_notes.md';

type TimelineScreenNavigationProp = NativeStackNavigationProp<RootStackParamList, 'Timeline'>;

export const TimelineScreen = () => {
    const [notes, setNotes] = useState<FlashNote[]>([]);
    const navigation = useNavigation<TimelineScreenNavigationProp>();

    const loadNotes = async () => {
        try {
            let content = '';
            try {
                content = await fsService.readFile(FLASH_NOTE_FILE);
            } catch (e) {
                // File might not exist yet
                return;
            }

            const lines = content.split('\n');
            const parsedNotes: FlashNote[] = [];
            let currentNote: Partial<FlashNote> = {};

            lines.forEach(line => {
                if (line.startsWith('# 20')) {
                    if (currentNote.id) {
                        parsedNotes.push(currentNote as FlashNote);
                    }
                    const timestamp = line.replace('# ', '').trim();
                    currentNote = {
                        id: timestamp,
                        timestamp: timestamp,
                        content: '',
                    };
                } else {
                    if (currentNote.id) {
                        currentNote.content += line + '\n';
                    }
                }
            });
            if (currentNote.id) {
                parsedNotes.push(currentNote as FlashNote);
            }

            parsedNotes.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
            setNotes(parsedNotes);
        } catch (error) {
            console.error('Failed to load flash notes', error);
        }
    };

    useFocusEffect(
        useCallback(() => {
            loadNotes();
        }, [])
    );

    React.useLayoutEffect(() => {
        navigation.setOptions({
            headerRight: () => (
                <TouchableOpacity onPress={() => navigation.navigate('NewFlashNote')}>
                    <Text style={styles.headerButton}>Add</Text>
                </TouchableOpacity>
            ),
        });
    }, [navigation]);

    const renderItem = ({ item }: { item: FlashNote }) => (
        <View style={styles.card}>
            <Text style={styles.timestamp}>{item.timestamp}</Text>
            <Text style={styles.content}>{item.content.trim()}</Text>
        </View>
    );

    return (
        <View style={styles.container}>
            <FlatList
                data={notes}
                renderItem={renderItem}
                keyExtractor={item => item.id}
                contentContainerStyle={styles.listContent}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    listContent: {
        padding: theme.spacing.m,
        paddingBottom: 100,
    },
    card: {
        backgroundColor: theme.colors.surface,
        padding: theme.spacing.m,
        borderRadius: 8,
        marginBottom: theme.spacing.m,
        borderLeftWidth: 4,
        borderLeftColor: theme.colors.primary,
    },
    timestamp: {
        fontSize: theme.typography.caption.fontSize,
        color: theme.colors.textSecondary,
        marginBottom: theme.spacing.xs,
    },
    content: {
        fontSize: theme.typography.body.fontSize,
        color: theme.colors.text,
    },
    headerButton: {
        color: theme.colors.primary,
        fontSize: 16,
        marginRight: theme.spacing.m,
    },
});
