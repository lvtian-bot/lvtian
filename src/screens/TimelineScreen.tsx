import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { fsService } from '../services/FileSystemService';
import { syncService } from '../services/SyncService';
import { theme } from '../utils/theme';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTranslation } from 'react-i18next';
import { useFileMetadataStore } from '../store/useFileMetadataStore';

interface FlashNote {
    id: string;
    timestamp: string;
    content: string;
}

const FLASH_NOTE_FILE = 'flash_notes.md';

type TimelineScreenNavigationProp = NativeStackNavigationProp<RootStackParamList, 'MainTabs'>;

type SyncStatus = 'synced' | 'conflict' | 'checking' | 'error';
type ConflictType = 'cloudNewer' | 'localNewer' | null;

export const TimelineScreen = () => {
    const [notes, setNotes] = useState<FlashNote[]>([]);
    const [isUpdating, setIsUpdating] = useState(false);
    const [syncStatus, setSyncStatus] = useState<SyncStatus>('checking');
    const [conflictType, setConflictType] = useState<ConflictType>(null);
    const navigation = useNavigation<TimelineScreenNavigationProp>();
    const { flashNoteConfig } = useSettingsStore();
    const { t } = useTranslation();
    const { getMetadata, setMetadata, invalidateMetadata } = useFileMetadataStore();

    const getFlashNotePath = () => {
        const path = flashNoteConfig.path ? `${flashNoteConfig.path}/${flashNoteConfig.filename}` : flashNoteConfig.filename;
        return path.replace(/\/+/g, '/'); // Normalize slashes
    };

    const loadNotes = async () => {
        try {
            const filePath = getFlashNotePath();
            const exists = await fsService.exists(filePath);

            if (exists) {
                const content = await fsService.readFile(filePath);
                parseAndSetNotes(content);
                checkSyncStatus(filePath);
            } else {
                // Local file missing, try to restore from cloud
                await tryRestoreFromCloud(filePath);
            }
        } catch (error) {
            console.error('Failed to load flash notes', error);
        }
    };

    const tryRestoreFromCloud = async (filePath: string) => {
        try {
            setIsUpdating(true);
            const { cloudService } = require('../services/CloudService');
            const key = filePath;

            const metadata = await cloudService.headFile(key);
            if (metadata) {
                await cloudService.downloadFile(key, filePath);
                const content = await fsService.readFile(filePath);
                parseAndSetNotes(content);
                setMetadata(filePath, metadata.etag, metadata.lastModified);
                setSyncStatus('synced');
            } else {
                setSyncStatus('error'); // Or just empty if not in cloud either
            }
        } catch (error) {
            console.log('Cloud restore failed', error);
            setSyncStatus('error');
        } finally {
            setIsUpdating(false);
        }
    };

    const parseAndSetNotes = (content: string) => {
        const lines = content.split('\n');
        const parsedNotes: FlashNote[] = [];
        let currentNote: Partial<FlashNote> = {};

        // Regex to match lines starting with # or ## followed by a date-like string (starting with 20)
        // Matches: "# 2023...", "## 2023..."
        const headerRegex = /^(#{1,2})\s+(20\d{2}[-/]\d{1,2}[-/]\d{1,2}.*)/;

        lines.forEach(line => {
            const match = line.match(headerRegex);
            if (match) {
                if (currentNote.id) {
                    parsedNotes.push(currentNote as FlashNote);
                }
                // match[2] is the timestamp part
                const timestamp = match[2].trim();
                currentNote = {
                    id: timestamp, // Use timestamp as ID
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
    };

    const checkSyncStatus = async (filePath: string) => {
        setSyncStatus('checking');
        try {
            const { cloudService } = require('../services/CloudService');
            const key = filePath;
            const localMetadata = getMetadata(filePath);
            const cloudMetadata = await cloudService.headFile(key);

            if (!cloudMetadata) {
                // Not in cloud
                if (await fsService.exists(filePath)) {
                    setSyncStatus('conflict');
                    setConflictType('localNewer');
                }
                return;
            }

            if (localMetadata?.etag === cloudMetadata.etag) {
                setSyncStatus('synced');
                setConflictType(null);
            } else {
                setSyncStatus('conflict');
                const localFileStat = await fsService.stat(filePath);
                const localMtime = localFileStat?.mtime || new Date(0);
                const cloudMtime = new Date(cloudMetadata.lastModified);

                if (cloudMtime > localMtime) {
                    setConflictType('cloudNewer');
                } else {
                    setConflictType('localNewer');
                }
            }
        } catch (error) {
            console.error('Error checking sync status:', error);
            setSyncStatus('error');
        }
    };

    const handleOverwriteLocal = async () => {
        try {
            setIsUpdating(true);
            const filePath = getFlashNotePath();
            const key = filePath;
            const { cloudService } = require('../services/CloudService');
            const result = await cloudService.downloadFile(key, filePath);
            setMetadata(filePath, result.etag, result.lastModified);
            setSyncStatus('synced');
            setConflictType(null);

            const content = await fsService.readFile(filePath);
            parseAndSetNotes(content);
        } catch (error) {
            Alert.alert('Error', 'Failed to overwrite local file');
        } finally {
            setIsUpdating(false);
        }
    };

    const handleUploadOverwrite = async () => {
        try {
            setIsUpdating(true);
            const filePath = getFlashNotePath();
            await syncService.syncFile(filePath);
            // Wait a bit for sync to process (simplified)
            setTimeout(() => {
                checkSyncStatus(filePath);
                setIsUpdating(false);
            }, 2000);
        } catch (error) {
            Alert.alert('Error', 'Failed to upload');
            setIsUpdating(false);
        }
    };

    const handleSaveCopy = async () => {
        try {
            setIsUpdating(true);
            const filePath = getFlashNotePath();
            await syncService.resolveConflict(filePath);
            // resolveConflict downloads the cloud version to filePath
            // So we should reload
            const content = await fsService.readFile(filePath);
            parseAndSetNotes(content);
            // And update status (resolveConflict should have updated metadata via SyncService, but let's recheck)
            checkSyncStatus(filePath);
        } catch (error) {
            Alert.alert('Error', 'Failed to save copy');
        } finally {
            setIsUpdating(false);
        }
    };

    useFocusEffect(
        useCallback(() => {
            loadNotes();
        }, [])
    );

    React.useLayoutEffect(() => {
        navigation.setOptions({
            title: t('timeline.title'),
            headerRight: () => (
                <View style={styles.headerRight}>
                    {isUpdating && <ActivityIndicator size="small" color={theme.colors.primary} />}
                    {!isUpdating && syncStatus === 'synced' && <Text style={styles.syncIcon}>✅</Text>}
                    {!isUpdating && syncStatus === 'conflict' && <Text style={styles.syncIcon}>⚠️</Text>}
                </View>
            ),
        });
    }, [navigation, t, syncStatus, isUpdating]);

    const renderItem = ({ item }: { item: FlashNote }) => (
        <View style={styles.card}>
            <Text style={styles.timestamp}>{item.timestamp}</Text>
            <Text style={styles.content}>{item.content.trim()}</Text>
        </View>
    );

    return (
        <View style={styles.container}>
            {syncStatus === 'conflict' && conflictType && (
                <View style={styles.banner}>
                    <Text style={styles.bannerText}>
                        {conflictType === 'cloudNewer' ? '云端有新版本' : '本地更改未同步'}
                    </Text>
                    <View style={styles.bannerButtons}>
                        {conflictType === 'cloudNewer' ? (
                            <>
                                <TouchableOpacity onPress={handleOverwriteLocal} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>覆盖本地</Text>
                                </TouchableOpacity>
                                <TouchableOpacity onPress={handleSaveCopy} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>另存副本</Text>
                                </TouchableOpacity>
                            </>
                        ) : (
                            <>
                                <TouchableOpacity onPress={handleUploadOverwrite} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>上传覆盖</Text>
                                </TouchableOpacity>
                                <TouchableOpacity onPress={handleSaveCopy} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>另存副本</Text>
                                </TouchableOpacity>
                            </>
                        )}
                    </View>
                </View>
            )}
            <FlatList
                data={notes}
                renderItem={renderItem}
                keyExtractor={(item, index) => `${item.id}-${index}`}
                contentContainerStyle={styles.listContent}
            />
            <TouchableOpacity
                style={styles.fab}
                onPress={() => navigation.navigate('NewFlashNote')}
            >
                <Icon name="add" size={24} color={theme.colors.white} />
            </TouchableOpacity>
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
    fab: {
        position: 'absolute',
        right: theme.spacing.l,
        bottom: theme.spacing.l,
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: theme.colors.primary,
        justifyContent: 'center',
        alignItems: 'center',
        elevation: 4,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 3.84,
    },
    headerRight: {
        flexDirection: 'row',
        alignItems: 'center',
        marginRight: theme.spacing.s,
    },
    syncIcon: {
        fontSize: 16,
    },
    banner: {
        backgroundColor: '#FFF3CD',
        padding: theme.spacing.s,
        borderBottomWidth: 1,
        borderBottomColor: '#FFEEBA',
        alignItems: 'center',
    },
    bannerText: {
        color: '#856404',
        marginBottom: theme.spacing.s,
    },
    bannerButtons: {
        flexDirection: 'row',
        gap: theme.spacing.m,
    },
    bannerButton: {
        backgroundColor: '#856404',
        paddingHorizontal: theme.spacing.m,
        paddingVertical: theme.spacing.xs,
        borderRadius: 4,
    },
    bannerButtonText: {
        color: 'white',
        fontSize: 12,
    },
});
