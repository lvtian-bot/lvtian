import React, { useState, useCallback } from 'react';
import NetInfo from "@react-native-community/netinfo";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { fsService } from '../services/FileSystemService';
import { cloudService } from '../services/CloudService';
import { theme } from '../utils/theme';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTranslation } from 'react-i18next';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { useShareStore } from '../store/useShareStore';
import { FlashNoteInputModal } from '../components/FlashNoteInputModal'; // Import the new modal
import { flashNoteService, FLASH_NOTES_UPDATED_EVENT, SHARE_RECEIVED_EVENT } from '../services/FlashNoteService';
import { UPLOAD_COMPLETED_EVENT } from '../services/CloudService';
import { DeviceEventEmitter } from 'react-native';
import { normalizePath } from '../utils/pathUtils';

interface FlashNote {
    id: string;
    timestamp: string;
    content: string;
}



type TimelineScreenNavigationProp = NativeStackNavigationProp<RootStackParamList>;

type SyncStatus = 'synced' | 'conflict' | 'checking' | 'error' | 'offline';
type ConflictType = 'cloudNewer' | 'localNewer' | null;

export const TimelineScreen = () => {
    const [notes, setNotes] = useState<FlashNote[]>([]);
    const [isUpdating, setIsUpdating] = useState(false);
    const [syncStatus, setSyncStatus] = useState<SyncStatus>('checking');
    const [conflictType, setConflictType] = useState<ConflictType>(null);
    const [configLoaded, setConfigLoaded] = useState(false); // Track if AsyncStorage config is loaded
    const navigation = useNavigation<TimelineScreenNavigationProp>();
    const { flashNoteConfig, cosConfig } = useSettingsStore();
    const { t } = useTranslation();
    const { getMetadata, setMetadata, setUploadState } = useFileMetadataStore();

    // State for the flash note input modal
    const [isModalVisible, setIsModalVisible] = useState(false);
    const [editingNoteId, setEditingNoteId] = useState<string | undefined>(undefined);
    const [editingNoteContent, setEditingNoteContent] = useState<string | undefined>(undefined);

    const getFlashNotePath = useCallback(() => {
        const path = flashNoteConfig.path ? `${flashNoteConfig.path}/${flashNoteConfig.filename}` : flashNoteConfig.filename;
        return normalizePath(path);
    }, [flashNoteConfig]);

    const currentFilePath = flashNoteConfig.path ? normalizePath(`${flashNoteConfig.path}/${flashNoteConfig.filename}`) : normalizePath(flashNoteConfig.filename);
    const fileMetadata = useFileMetadataStore(state => state.metadata[currentFilePath]);

    const parseAndSetNotes = useCallback((content: string) => {
        const parsedNotes = flashNoteService.parseNotes(content);
        setNotes(parsedNotes);
    }, []);

    const checkSyncStatus = useCallback(async (filePath: string) => {
        setSyncStatus('checking');
        try {
            // const { cloudService } = require('../services/CloudService');
            const key = filePath;
            const localMetadata = getMetadata(filePath);

            // 1. Check Upload State
            if (localMetadata?.uploadState === 'uploading') {
                setSyncStatus('checking');
                setConflictType(null);
                return;
            }

            // 2. Check Network
            const netState = await NetInfo.fetch();
            if (netState.isConnected === false) {
                if (localMetadata?.uploadState === 'failed' || localMetadata?.uploadState === 'conflict-failed') {
                    setSyncStatus('conflict');
                    setConflictType('localNewer');
                } else {
                    setSyncStatus('offline');
                    setConflictType(null);
                }
                return;
            }

            // 3. Check Cloud Config (after network, to allow AsyncStorage to load)
            if (!cloudService.isConfigured()) {
                console.log('[TimelineScreen] Cloud not configured, treating as offline');
                if (localMetadata?.uploadState === 'failed' || localMetadata?.uploadState === 'conflict-failed') {
                    setSyncStatus('conflict');
                    setConflictType('localNewer');
                } else {
                    setSyncStatus('offline');
                    setConflictType(null);
                }
                return;
            }

            // 4. Check Cloud File
            const cloudMetadata = await cloudService.headFile(key);

            if (!cloudMetadata) {
                if (await fsService.exists(filePath)) {
                    setSyncStatus('conflict');
                    setConflictType('localNewer');
                }
                return;
            }

            if (localMetadata?.etag === cloudMetadata.etag) {
                setSyncStatus('synced');
                setConflictType(null);
                if (localMetadata?.uploadState === 'failed' || localMetadata?.uploadState === 'conflict-failed') {
                    setUploadState(filePath, null);
                }
            } else {
                setSyncStatus('conflict');
                const localFileStat = await fsService.stat(filePath);
                const localMtime = localFileStat?.mtime || new Date(0);
                const cloudMtime = new Date(cloudMetadata.lastModified);
                setConflictType(cloudMtime > localMtime ? 'cloudNewer' : 'localNewer');
            }
        } catch (error) {
            console.error('Error checking sync status:', error);
            const localMetadata = getMetadata(filePath);

            if (localMetadata?.uploadState === 'failed' || localMetadata?.uploadState === 'conflict-failed') {
                setSyncStatus('conflict');
                setConflictType('localNewer');
                return;
            }

            try {
                if (await fsService.exists(filePath)) {
                    setSyncStatus('offline');
                    setConflictType(null);
                    return;
                }
            } catch { }
            setSyncStatus('error');
        }
    }, [getMetadata, setUploadState]);

    const tryRestoreFromCloud = useCallback(async (filePath: string) => {
        try {
            setIsUpdating(true);
            // const { cloudService } = require('../services/CloudService');
            const key = filePath;

            const metadata = await cloudService.headFile(key);
            if (metadata) {
                await cloudService.downloadFile(key, filePath);
                const content = await fsService.readFile(filePath);
                parseAndSetNotes(content);
                setMetadata(filePath, metadata.etag, metadata.lastModified);
                setSyncStatus('synced');
            } else {
                setSyncStatus('error');
            }
        } catch (error) {
            console.log('Cloud restore failed', error);
            setSyncStatus('error');
        } finally {
            setIsUpdating(false);
        }
    }, [parseAndSetNotes, setMetadata]);

    const loadNotes = useCallback(async () => {
        try {
            const filePath = getFlashNotePath();
            const exists = await fsService.exists(filePath);

            if (exists) {
                const content = await fsService.readFile(filePath);
                parseAndSetNotes(content);
                // Sync check is now handled separately in useFocusEffect
            } else {
                await tryRestoreFromCloud(filePath);
            }
        } catch (error) {
            console.error('Failed to load flash notes', error);
        }
    }, [getFlashNotePath, parseAndSetNotes, tryRestoreFromCloud]);

    const handleOverwriteLocal = async () => {
        try {
            setIsUpdating(true);
            const filePath = getFlashNotePath();
            const key = filePath;
            // const { cloudService } = require('../services/CloudService');
            const result = await cloudService.downloadFile(key, filePath);
            setMetadata(filePath, result.etag, result.lastModified);
            setSyncStatus('synced');
            setConflictType(null);

            const content = await fsService.readFile(filePath);
            parseAndSetNotes(content);
        } catch {
            Alert.alert('Error', 'Failed to overwrite local file');
        } finally {
            setIsUpdating(false);
        }
    };

    const handleUploadOverwrite = async () => {
        try {
            setIsUpdating(true);
            const filePath = getFlashNotePath();
            setUploadState(filePath, 'uploading');
            const result = await cloudService.uploadFile(filePath, filePath);
            if (result) {
                setMetadata(filePath, result.etag, result.lastModified);
            }
            checkSyncStatus(filePath);
            setIsUpdating(false);
        } catch {
            const filePath = getFlashNotePath();
            setUploadState(filePath, 'failed');
            checkSyncStatus(filePath);
            setIsUpdating(false);
        }
    };

    const handleSaveCopy = async () => {
        try {
            setIsUpdating(true);
            const filePath = getFlashNotePath();
            const key = filePath; // In this app structure, key is often same as filePath relative to root

            // 1. Rename local file (backup) and upload it
            // This moves the local 'flash_notes.md' to 'flash_notes_conflict_xxx.md'
            const normalizedPath = normalizePath(filePath);
            const fileName = normalizedPath.split('/').pop() || '';
            const dir = normalizedPath.replace(fileName, '');
            const timestamp = new Date().getTime();
            const newName = `${fileName.replace('.md', '')}_old_${timestamp}.md`;
            const backupPath = normalizePath(`${dir}${newName}`);

            await fsService.moveFile(normalizedPath, backupPath);

            // Upload the renamed file to cloud
            if (cloudService.isConfigured()) {
                setUploadState(backupPath, 'uploading');
                try {
                    const result = await cloudService.uploadFile(backupPath, backupPath);
                    if (result) {
                        setMetadata(backupPath, result.etag, result.lastModified);
                    }
                } catch (error) {
                    console.error('Upload backup failed:', error);
                    setUploadState(backupPath, 'failed');
                }
            }

            const backupFileName = backupPath.split('/').pop();

            // 2. Download the CLOUD version of the original file to restore main timeline
            // Since local file was moved, we can download fresh
            const result = await cloudService.downloadFile(key, filePath);

            // 3. Update Metadata & UI to show the fresh cloud content
            setMetadata(filePath, result.etag, result.lastModified);
            setSyncStatus('synced');
            setConflictType(null);

            const content = await fsService.readFile(filePath);
            parseAndSetNotes(content);

            // 4. Notify user
            Alert.alert(
                t('common.success'),
                t('timeline.conflictResolvedAsCopy', { backupFileName }) || `本地更改已另存为副本: ${backupFileName}\n首页已刷新为云端最新版本`
            );
        } catch (error) {
            console.error('Save copy failed:', error);
            Alert.alert('Error', 'Failed to save copy and restore');
        } finally {
            setIsUpdating(false);
        }
    };

    const handleSaveFlashNote = async (id: string | undefined, content: string) => {
        try {
            if (id) {
                await flashNoteService.updateNote(id, content);
            } else {
                await flashNoteService.addNote(content);
            }
            loadNotes();
            setIsModalVisible(false);
        } catch (error) {
            console.error('Failed to save flash note', error);
            Alert.alert(t('common.error'), t('timeline.saveError'));
        }
    };

    const handleCancelFlashNote = () => {
        setIsModalVisible(false);
        setEditingNoteId(undefined);
        setEditingNoteContent(undefined);
    };

    const handleDeleteFlashNote = async (noteToDelete: FlashNote) => {
        Alert.alert(
            t('common.confirm'),
            t('browser.confirmDelete', { fileName: noteToDelete.id }), // Re-using browser string for now
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.confirm'),
                    onPress: async () => {
                        try {
                            await flashNoteService.deleteNote(noteToDelete.id);
                            loadNotes();
                        } catch (error) {
                            console.error('Failed to delete flash note:', error);
                            Alert.alert(t('common.error'), t('timeline.deleteError'));
                        }
                    },
                },
            ]
        );
    };

    const handleNoteLongPress = (item: FlashNote) => {
        Alert.alert(
            item.id,
            undefined,
            [
                {
                    text: t('common.delete'),
                    onPress: () => handleDeleteFlashNote(item),
                    style: 'destructive',
                },
                {
                    text: t('common.edit'),
                    onPress: () => {
                        setEditingNoteId(item.id);
                        setEditingNoteContent(item.content.trim());
                        setIsModalVisible(true);
                    },
                },
                {
                    text: t('common.cancel'),
                    style: 'cancel',
                },
            ]
        );
    };

    useFocusEffect(useCallback(() => {
        // Step 1: Load and display content first (user experience priority)
        loadNotes();

        // Step 2: Check for pending share content
        const pendingContent = useShareStore.getState().pendingShareContent;
        if (pendingContent) {
            console.log('[TimelineScreen] Found pending share content, opening modal');
            setEditingNoteId(undefined);
            setEditingNoteContent(pendingContent);
            setIsModalVisible(true);
            // Clear the pending content after processing
            useShareStore.getState().clearPendingShare();
        }

        // Step 3: Check sync status only after config is loaded
        // Configuration loading is tracked by the useEffect below
        if (configLoaded) {
            const filePath = getFlashNotePath();
            checkSyncStatus(filePath);
        }
    }, [loadNotes, getFlashNotePath, checkSyncStatus, configLoaded]));

    // Track when config is loaded from AsyncStorage and check sync status
    React.useEffect(() => {
        // Use a timer to detect when AsyncStorage has finished loading
        // If cosConfig changes or stays empty for 800ms, consider it loaded
        const timer = setTimeout(() => {
            setConfigLoaded(true);
            const filePath = getFlashNotePath();
            if (cosConfig.bucket && cosConfig.region) {
                console.log('[TimelineScreen] COS config loaded, checking sync status');
            } else {
                console.log('[TimelineScreen] COS not configured, checking sync status');
            }
            checkSyncStatus(filePath);
        }, 800); // 800ms should be enough for AsyncStorage to load

        return () => clearTimeout(timer);
    }, [cosConfig.bucket, cosConfig.region, checkSyncStatus, getFlashNotePath]);

    // Listen for flash note updates (e.g. from share intent)
    React.useEffect(() => {
        const subscription = DeviceEventEmitter.addListener(FLASH_NOTES_UPDATED_EVENT, () => {
            console.log('Flash notes updated event received, reloading...');
            loadNotes();
        });

        return () => {
            subscription.remove();
        };
    }, [loadNotes]);

    // Listen for upload completion
    React.useEffect(() => {
        const subscription = DeviceEventEmitter.addListener(UPLOAD_COMPLETED_EVENT, (data: { filePath: string }) => {
            const currentFilePath = getFlashNotePath();
            if (data.filePath === currentFilePath) {
                checkSyncStatus(currentFilePath);
            }
        });

        return () => {
            subscription.remove();
        };
    }, [checkSyncStatus, getFlashNotePath]);

    // Listen for share received event
    React.useEffect(() => {
        const subscription = DeviceEventEmitter.addListener(SHARE_RECEIVED_EVENT, (data: { content: string }) => {
            console.log('Share received event, opening modal with content:', data.content);
            setEditingNoteId(undefined);
            setEditingNoteContent(data.content);
            setIsModalVisible(true);
        });

        return () => {
            subscription.remove();
        };
    }, []);

    React.useLayoutEffect(() => {
        navigation.setOptions({
            title: t('timeline.title'),
            headerRight: () => (
                <HeaderRight isUpdating={isUpdating} syncStatus={syncStatus} />
            ),
        });
    }, [navigation, t, syncStatus, isUpdating]);

    const renderItem = ({ item }: { item: FlashNote }) => (
        <TouchableOpacity
            onLongPress={() => handleNoteLongPress(item)}
        >
            <View style={styles.card}>
                <Text style={styles.timestamp}>{item.timestamp}</Text>
                <Text style={styles.content}>{item.content.trim()}</Text>
            </View>
        </TouchableOpacity>
    );

    return (
        <View style={styles.container}>
            {/* Only show offline banner when config is loaded and status is confirmed offline */}
            {configLoaded && syncStatus === 'offline' && (
                <View style={styles.banner}>
                    <Text style={styles.bannerText}>
                        {t('preview.offlineMode') || '离线模式：当前显示本地版本，可能不是最新'}
                    </Text>
                    <View style={styles.bannerButtons}>
                        <TouchableOpacity onPress={() => checkSyncStatus(currentFilePath)} style={styles.bannerButton}>
                            <Text style={styles.bannerButtonText}>{t('common.retry') || '重试连接'}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            )}
            {syncStatus === 'conflict' && conflictType && (
                <View style={styles.banner}>
                    <Text style={styles.bannerText}>
                        {(fileMetadata?.uploadState === 'failed' || fileMetadata?.uploadState === 'conflict-failed') && (
                            fileMetadata?.uploadState === 'conflict-failed'
                                ? '上传失败：云端文件已更改\n'
                                : '上传失败\n'
                        )}
                        {conflictType === 'cloudNewer' ? '云端有新版本' : '本地更改未同步'}
                    </Text>
                    <View style={styles.bannerButtons}>
                        {conflictType === 'cloudNewer' ? (
                            <>
                                <TouchableOpacity onPress={handleOverwriteLocal} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>使用云端版本</Text>
                                </TouchableOpacity>
                                <TouchableOpacity onPress={handleSaveCopy} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>保存副本</Text>
                                </TouchableOpacity>
                            </>
                        ) : (
                            <>
                                <TouchableOpacity onPress={handleUploadOverwrite} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>上传到云端</Text>
                                </TouchableOpacity>
                                <TouchableOpacity onPress={handleSaveCopy} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>保存副本</Text>
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
                onPress={() => { setEditingNoteId(undefined); setEditingNoteContent(undefined); setIsModalVisible(true); }}
            >
                <Icon name="add" size={24} color={theme.colors.white} />
            </TouchableOpacity>

            <FlashNoteInputModal
                visible={isModalVisible}
                initialId={editingNoteId}
                initialContent={editingNoteContent}
                onSave={handleSaveFlashNote}
                onCancel={handleCancelFlashNote}
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

const HeaderRight = ({ isUpdating, syncStatus }: { isUpdating: boolean, syncStatus: SyncStatus }) => (
    <View style={styles.headerRight}>
        {isUpdating && <ActivityIndicator size="small" color={theme.colors.primary} />}
        {!isUpdating && syncStatus === 'checking' && <ActivityIndicator size="small" color={theme.colors.primary} />}
        {!isUpdating && syncStatus === 'synced' && <Text style={styles.syncIcon}>✅</Text>}
        {!isUpdating && (syncStatus === 'conflict' || syncStatus === 'offline') && <Text style={styles.syncIcon}>⚠️</Text>}
    </View>
);
