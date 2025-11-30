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
import { FlashNoteInputModal } from '../components/FlashNoteInputModal';
import { flashNoteService, FLASH_NOTES_UPDATED_EVENT } from '../services/FlashNoteService';
import { UPLOAD_COMPLETED_EVENT, CLOUD_INIT_COMPLETED_EVENT } from '../services/CloudService';
import { DeviceEventEmitter } from 'react-native';
import { normalizePath } from '../utils/pathUtils';

interface FlashNote {
    id: string;
    timestamp: string;
    content: string;
}

type TimelineScreenNavigationProp = NativeStackNavigationProp<RootStackParamList>;

type SyncStatus = 'synced' | 'conflict' | 'checking' | 'error' | 'offline' | 'not-configured';
type ConflictType = 'cloudNewer' | 'localNewer' | null;

export const TimelineScreen = () => {
    const [notes, setNotes] = useState<FlashNote[]>([]);
    const [isUpdating, setIsUpdating] = useState(false);
    const [syncStatus, setSyncStatus] = useState<SyncStatus>('checking');
    const [conflictType, setConflictType] = useState<ConflictType>(null);
    const navigation = useNavigation<TimelineScreenNavigationProp>();
    const { flashNoteConfig } = useSettingsStore();
    const { t } = useTranslation();
    const { getMetadata, setMetadata, setUploadState } = useFileMetadataStore();

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

    // Helper: Perform Download
    const performDownload = useCallback(async (filePath: string) => {
        try {
            setIsUpdating(true);
            const result = await cloudService.downloadFile(filePath, filePath);
            setMetadata(filePath, result.etag, result.etag, result.lastModified);

            const content = await fsService.readFile(filePath);
            parseAndSetNotes(content);
            return true;
        } catch (error) {
            console.error('Download failed:', error);
            Alert.alert('Error', 'Failed to download file');
            return false;
        } finally {
            setIsUpdating(false);
        }
    }, [parseAndSetNotes, setMetadata]);

    // Helper: Perform Upload
    const performUpload = useCallback(async (filePath: string) => {
        try {
            setIsUpdating(true);
            setUploadState(filePath, 'uploading');
            const result = await cloudService.uploadFile(filePath, filePath);
            if (result) {
                setMetadata(filePath, result.etag, result.etag, result.lastModified);
                return true;
            }
            return false;
        } catch (error: any) {
            console.error('Upload failed:', error);
            setUploadState(filePath, 'failed');
            return false;
        } finally {
            setIsUpdating(false);
        }
    }, [setMetadata, setUploadState]);

    const checkSyncStatus = useCallback(async (filePath: string) => {
        setSyncStatus('checking');

        try {
            const key = filePath;
            const localMetadata = getMetadata(filePath);

            // 1. Check Cloud Config (Priority 1)
            if (!cloudService.isConfigured()) {
                console.log('[TimelineScreen] Cloud not configured');
                setSyncStatus('not-configured');
                setConflictType(null);
                return;
            }

            // 2. Check Network Status (Priority 2)
            const netState = await NetInfo.fetch();
            if (netState.isConnected === false) {
                setSyncStatus('offline');
                setConflictType(null);
                return;
            }

            // 3. Check Upload State
            if (localMetadata?.uploadState === 'uploading') {
                setSyncStatus('checking');
                setConflictType(null);
                return;
            }

            // 4. Check Cloud File
            const cloudMetadata = await cloudService.headFile(key);

            // A. Cloud file missing (404) -> Auto Upload
            if (!cloudMetadata) {
                if (await fsService.exists(filePath)) {
                    console.log('Cloud file missing, auto-uploading...');
                    await performUpload(filePath);
                    // Re-check status after upload
                    const newMetadata = await cloudService.headFile(key);
                    if (newMetadata) {
                        setSyncStatus('synced');
                        setConflictType(null);
                    } else {
                        // Still missing or upload failed
                        if (getMetadata(filePath)?.uploadState === 'failed') {
                            setSyncStatus('conflict');
                            setConflictType('localNewer');
                        }
                    }
                }
                return;
            }

            // B. Hash Match (Synced)
            if (localMetadata?.localHash === cloudMetadata.etag) {
                // Self-healing
                if (localMetadata?.syncedHash !== cloudMetadata.etag) {
                    setMetadata(filePath, cloudMetadata.etag, localMetadata.localHash, localMetadata.lastModified || new Date().toISOString());
                }
                setSyncStatus('synced');
                setConflictType(null);
                if (localMetadata?.uploadState === 'failed') {
                    setUploadState(filePath, null);
                }
                return;
            }

            // C. Hash Mismatch (Conflict/Inconsistent)
            // C1. Only Cloud Updated (localHash == syncedHash) -> Auto Download
            if (localMetadata?.localHash === localMetadata?.syncedHash) {
                console.log('Cloud newer, auto-downloading...');
                const success = await performDownload(filePath);
                if (success) {
                    setSyncStatus('synced');
                    setConflictType(null);
                }
                return;
            }

            // C2. Only Local Updated (cloud.etag == syncedHash) -> Auto Upload
            if (cloudMetadata.etag === localMetadata?.syncedHash) {
                console.log('Local newer, auto-uploading...');
                const success = await performUpload(filePath);
                if (success) {
                    setSyncStatus('synced');
                    setConflictType(null);
                } else {
                    setSyncStatus('conflict'); // Upload failed
                    setConflictType('localNewer');
                }
                return;
            }

            // C3. Bidirectional Conflict -> Show UI
            setSyncStatus('conflict');
            setConflictType('cloudNewer'); // Prioritize cloud newer to prevent overwrite

        } catch (error) {
            console.error('Error checking sync status:', error);
            const localMetadata = getMetadata(filePath);

            if (localMetadata?.uploadState === 'failed') {
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
    }, [getMetadata, setUploadState, setMetadata, performUpload, performDownload]);

    const handleOverwriteLocal = useCallback(async () => {
        const filePath = getFlashNotePath();
        const success = await performDownload(filePath);
        if (success) {
            setSyncStatus('synced');
            setConflictType(null);
        }
    }, [getFlashNotePath, performDownload]);

    const handleUploadOverwrite = useCallback(async () => {
        const filePath = getFlashNotePath();
        const success = await performUpload(filePath);
        if (success) {
            checkSyncStatus(filePath);
        } else {
            checkSyncStatus(filePath);
        }
    }, [getFlashNotePath, performUpload, checkSyncStatus]);

    const tryRestoreFromCloud = useCallback(async (filePath: string) => {
        try {
            setIsUpdating(true);
            const key = filePath;

            if (!cloudService.isConfigured()) {
                setSyncStatus('not-configured');
                return;
            }

            const metadata = await cloudService.headFile(key);
            if (metadata) {
                await cloudService.downloadFile(key, filePath);
                const content = await fsService.readFile(filePath);
                parseAndSetNotes(content);
                setMetadata(filePath, metadata.etag, metadata.etag, metadata.lastModified);
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
            } else {
                await tryRestoreFromCloud(filePath);
            }
        } catch (error) {
            console.error('Failed to load flash notes', error);
        }
    }, [getFlashNotePath, parseAndSetNotes, tryRestoreFromCloud]);

    const handleSaveCopy = async () => {
        try {
            setIsUpdating(true);
            const filePath = getFlashNotePath();
            const key = filePath;

            const normalizedPath = normalizePath(filePath);
            const fileName = normalizedPath.split('/').pop() || '';
            const dir = normalizedPath.replace(fileName, '');
            const timestamp = new Date().getTime();
            const newName = `${fileName.replace('.md', '')}_old_${timestamp}.md`;
            const backupPath = normalizePath(`${dir}${newName}`);

            await fsService.moveFile(normalizedPath, backupPath);

            if (cloudService.isConfigured()) {
                setUploadState(backupPath, 'uploading');
                try {
                    const result = await cloudService.uploadFile(backupPath, backupPath);
                    if (result) {
                        setMetadata(backupPath, result.etag, result.etag, result.lastModified);
                    }
                } catch (error) {
                    console.error('Upload backup failed:', error);
                    setUploadState(backupPath, 'failed');
                }
            }

            const backupFileName = backupPath.split('/').pop();
            const result = await cloudService.downloadFile(key, filePath);

            setMetadata(filePath, result.etag, result.etag, result.lastModified);
            setSyncStatus('synced');
            setConflictType(null);

            const content = await fsService.readFile(filePath);
            parseAndSetNotes(content);

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
            t('browser.confirmDelete', { fileName: noteToDelete.id }),
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
        loadNotes();
        const filePath = getFlashNotePath();
        if (cloudService.isInitialized()) {
            checkSyncStatus(filePath);
        }
    }, [loadNotes, getFlashNotePath, checkSyncStatus]));

    React.useEffect(() => {
        const subscription = DeviceEventEmitter.addListener(FLASH_NOTES_UPDATED_EVENT, () => {
            loadNotes();
        });
        return () => subscription.remove();
    }, [loadNotes]);

    React.useEffect(() => {
        const subscription = DeviceEventEmitter.addListener(UPLOAD_COMPLETED_EVENT, (data: { filePath: string }) => {
            const currentFilePath = getFlashNotePath();
            if (data.filePath === currentFilePath) {
                checkSyncStatus(currentFilePath);
            }
        });
        return () => subscription.remove();
    }, [checkSyncStatus, getFlashNotePath]);

    React.useEffect(() => {
        const subscription = DeviceEventEmitter.addListener(CLOUD_INIT_COMPLETED_EVENT, () => {
            const filePath = getFlashNotePath();
            checkSyncStatus(filePath);
        });
        return () => subscription.remove();
    }, [checkSyncStatus, getFlashNotePath]);

    React.useEffect(() => {
        const handleShareContent = (content: string | null) => {
            if (content) {
                setEditingNoteId(undefined);
                setEditingNoteContent(content);
                setIsModalVisible(true);
                useShareStore.getState().clearPendingShare();
            }
        };
        handleShareContent(useShareStore.getState().pendingShareContent);
        const unsubscribe = useShareStore.subscribe((state) => {
            handleShareContent(state.pendingShareContent);
        });
        return () => unsubscribe();
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
            {syncStatus === 'not-configured' && (
                <View style={styles.infoBanner}>
                    <Text style={styles.infoBannerText}>
                        {'未配置云服务：当前仅使用本地存储'}
                    </Text>
                    <View style={styles.bannerButtons}>
                        <TouchableOpacity onPress={() => navigation.navigate('MainTabs', { screen: 'Settings' })} style={styles.infoBannerButton}>
                            <Text style={styles.infoBannerButtonText}>{'前往设置'}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            )}
            {syncStatus === 'offline' && (
                <View style={styles.banner}>
                    <Text style={styles.bannerText}>
                        {t('preview.offlineMode') || '离线模式：当前显示本地版本，可能不是最新'}
                        {fileMetadata?.uploadState === 'failed' ? ' (上次上传失败)' : ''}
                    </Text>
                    <View style={styles.bannerButtons}>
                        <TouchableOpacity onPress={() => checkSyncStatus(currentFilePath)} style={styles.bannerButton}>
                            <Text style={styles.bannerButtonText}>{t('common.retry') || '重试连接'}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            )}
            {syncStatus === 'conflict' && (
                <View style={styles.banner}>
                    <Text style={styles.bannerText}>
                        {fileMetadata?.uploadState === 'failed'
                            ? '上传失败'
                            : '本地和云端已同时修改'
                        }
                    </Text>
                    <View style={styles.bannerButtons}>
                        {fileMetadata?.uploadState === 'failed' ? (
                            <TouchableOpacity onPress={handleUploadOverwrite} style={styles.bannerButton}>
                                <Text style={styles.bannerButtonText}>重试</Text>
                            </TouchableOpacity>
                        ) : (
                            <>
                                <TouchableOpacity onPress={handleOverwriteLocal} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>使用云端版本</Text>
                                </TouchableOpacity>
                                <TouchableOpacity onPress={handleSaveCopy} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>保存副本</Text>
                                </TouchableOpacity>
                                <TouchableOpacity onPress={handleUploadOverwrite} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>上传覆盖</Text>
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
    infoBanner: {
        backgroundColor: '#D1ECF1',
        padding: theme.spacing.s,
        borderBottomWidth: 1,
        borderBottomColor: '#BEE5EB',
        alignItems: 'center',
    },
    infoBannerText: {
        color: '#0C5460',
        marginBottom: theme.spacing.s,
    },
    infoBannerButton: {
        backgroundColor: '#0C5460',
        paddingHorizontal: theme.spacing.m,
        paddingVertical: theme.spacing.xs,
        borderRadius: 4,
    },
    infoBannerButtonText: {
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
        {!isUpdating && syncStatus === 'not-configured' && <Text style={styles.syncIcon}>ℹ️</Text>}
    </View>
);
