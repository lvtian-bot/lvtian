import React, { useState, useCallback, useEffect, useLayoutEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, Clipboard, DeviceEventEmitter, ActivityIndicator } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialIcons';
import { fsService } from '../services/FileSystemService';
import { cloudService, UPLOAD_COMPLETED_EVENT, CLOUD_INIT_COMPLETED_EVENT } from '../services/CloudService';

import { theme } from '../utils/theme';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTranslation } from 'react-i18next';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { useShareStore } from '../store/useShareStore';
import { FlashNoteInputModal } from '../components/FlashNoteInputModal';
import { flashNoteService, FLASH_NOTES_UPDATED_EVENT, FlashNote } from '../services/FlashNoteService';
import { normalizePath } from '../utils/pathUtils';
import { ActionSheetModal, ActionItem } from '../components/ActionSheetModal';
import { useCloudSync } from '../hooks/useCloudSync';

import { HeaderSyncStatus } from '../components/HeaderSyncStatus';
import { StatusBanner } from '../components/StatusBanner';

type FlashScreenNavigationProp = NativeStackNavigationProp<RootStackParamList>;

export const FlashScreen = () => {
    const [notes, setNotes] = useState<FlashNote[]>([]);
    const navigation = useNavigation<FlashScreenNavigationProp>();
    const { flashNoteConfig } = useSettingsStore();
    const { t } = useTranslation();

    // Infinite Scroll State
    const [allFilePaths, setAllFilePaths] = useState<string[]>([]);
    const [loadedFilePaths, setLoadedFilePaths] = useState<string[]>([]);
    const [nextFileIndex, setNextFileIndex] = useState(0);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [isRefreshing, setIsRefreshing] = useState(false);

    const [isModalVisible, setIsModalVisible] = useState(false);
    const [editingNoteId, setEditingNoteId] = useState<string | undefined>(undefined);
    const [editingNoteContent, setEditingNoteContent] = useState<string | undefined>(undefined);

    // ActionSheet state
    const [isActionSheetVisible, setIsActionSheetVisible] = useState(false);
    const [selectedNote, setSelectedNote] = useState<FlashNote | null>(null);

    const getFlashNotePath = useCallback(() => {
        const path = flashNoteConfig.path ? `${flashNoteConfig.path}/${flashNoteConfig.filename}` : flashNoteConfig.filename;
        return normalizePath(path);
    }, [flashNoteConfig]);

    const currentFilePath = getFlashNotePath();
    const fileMetadata = useFileMetadataStore(state => state.metadata[currentFilePath]);

    // Use the new hook with ALL loaded files
    // We default to currentFilePath if loadedFilePaths is empty to ensure at least one file is tracked initially
    // Use the new hook with ALL loaded files
    // We default to currentFilePath if loadedFilePaths is empty to ensure at least one file is tracked initially
    const syncPaths = React.useMemo(() =>
        loadedFilePaths.length > 0 ? loadedFilePaths : [currentFilePath],
        [loadedFilePaths, currentFilePath]
    );
    const { syncStatus, conflictType, isSyncing, checkSync, performAutoSync, resolveConflict } = useCloudSync(syncPaths);

    // Load ALL available file paths (Main + History)
    const loadFilePaths = useCallback(async () => {
        try {
            const paths = await flashNoteService.getSortedFilePaths();
            setAllFilePaths(paths);
            return paths;
        } catch (error) {
            console.error('Failed to load file paths:', error);
            return [];
        }
    }, []);

    // Load content from a specific file and append/prepend to notes
    const loadFileContent = async (filePath: string): Promise<FlashNote[]> => {
        try {
            if (await fsService.exists(filePath)) {
                const content = await fsService.readFile(filePath);
                return flashNoteService.parseNotes(content, filePath);
            }
        } catch (error) {
            console.error(`Failed to load content from ${filePath}:`, error);
        }
        return [];
    };

    // Initial Load: Get paths, load ONLY the first file (Main)
    const loadInitialData = useCallback(async () => {
        setIsRefreshing(true);
        try {
            // Background sync history files without blocking UI
            flashNoteService.syncHistoryFiles().then(() => {
                // Refresh file list after history sync completes to show any new files
                loadFilePaths();
            });
            const paths = await loadFilePaths();
            if (paths.length > 0) {
                const firstPath = paths[0];
                const initialNotes = await loadFileContent(firstPath);
                setNotes(initialNotes);
                setLoadedFilePaths([firstPath]);
                setNextFileIndex(1); // Next file to load is at index 1
                setHasMore(paths.length > 1);
            } else {
                setNotes([]);
                setLoadedFilePaths([]);
                setHasMore(false);
            }
        } finally {
            setIsRefreshing(false);
        }
    }, [loadFilePaths]);

    // Load More: Load the next file in the list
    const handleLoadMore = async () => {
        if (isLoadingMore || !hasMore || nextFileIndex >= allFilePaths.length) return;

        setIsLoadingMore(true);
        try {
            const nextPath = allFilePaths[nextFileIndex];
            const newNotes = await loadFileContent(nextPath);

            setNotes(prev => {
                // Merge and sort to be safe, though usually appending is enough if files are time-ordered
                const combined = [...prev, ...newNotes];
                // Remove duplicates based on ID just in case
                const unique = Array.from(new Map(combined.map(item => [item.id, item])).values());
                return unique.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
            });

            setLoadedFilePaths(prev => [...prev, nextPath]);
            setNextFileIndex(prev => prev + 1);
            setHasMore(nextFileIndex + 1 < allFilePaths.length);
        } catch (error) {
            console.error('Failed to load more notes:', error);
        } finally {
            setIsLoadingMore(false);
        }
    };

    // Reload currently loaded files (e.g. after sync or edit)
    // We re-read all currently loaded files to ensure UI reflects latest state
    const refreshLoadedData = useCallback(async () => {
        if (loadedFilePaths.length === 0) {
            // Do NOT call loadInitialData() here as it triggers syncHistoryFiles(),
            // which emits the event that calls this function -> Infinite Loop.
            try {
                const paths = await loadFilePaths();
                if (paths.length > 0) {
                    const firstPath = paths[0];
                    const initialNotes = await loadFileContent(firstPath);
                    setNotes(initialNotes);
                    setLoadedFilePaths([firstPath]);
                    setNextFileIndex(1);
                    setHasMore(paths.length > 1);
                } else {
                    setNotes([]);
                    setLoadedFilePaths([]);
                    setHasMore(false);
                }
            } catch (e) {
                console.error('Failed to refresh data:', e);
            }
            return;
        }

        try {
            let allNotes: FlashNote[] = [];
            for (const path of loadedFilePaths) {
                const fileNotes = await loadFileContent(path);
                allNotes = [...allNotes, ...fileNotes];
            }
            // Sort desc
            allNotes.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
            setNotes(allNotes);
        } catch (error) {
            console.error('Failed to refresh data:', error);
        }
    }, [loadedFilePaths, loadInitialData]);


    const handleOverwriteLocal = async () => {
        await resolveConflict('useCloud');
        await refreshLoadedData();
    };

    const handleUploadOverwrite = async () => {
        await resolveConflict('useLocal');
    };

    const handleSaveCopy = async () => {
        try {
            await resolveConflict('saveCopy');
            await refreshLoadedData();
            const backupFileName = `${currentFilePath.split('/').pop()}_old...`; // Approx name
            Alert.alert(
                t('common.success'),
                t('timeline.conflictResolvedAsCopy', { backupFileName }) || `本地更改已另存为副本。\n首页已刷新为云端最新版本`
            );
        } catch (error) {
            console.error('Save copy failed:', error);
            Alert.alert('Error', 'Failed to save copy and restore');
        }
    };

    const handleSaveFlashNote = async (id: string | undefined, content: string) => {
        try {
            if (id) {
                await flashNoteService.updateNote(id, content);
            } else {
                await flashNoteService.addNote(content);
            }
            refreshLoadedData();
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
                            refreshLoadedData();
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
        setSelectedNote(item);
        setIsActionSheetVisible(true);
    };

    const handleEditNote = (note: FlashNote) => {
        setEditingNoteId(note.id);
        setEditingNoteContent(note.content.trim());
        setIsModalVisible(true);
    };

    const getActionSheetActions = (): ActionItem[] => {
        if (!selectedNote) return [];

        return [
            {
                label: t('common.copy'),
                icon: 'content-copy',
                onPress: () => {
                    Clipboard.setString(selectedNote.content.trim());
                    Alert.alert(t('common.notice'), '闪念笔记已复制到剪贴板');
                },
            },
            {
                label: t('common.edit'),
                icon: 'edit',
                onPress: () => handleEditNote(selectedNote),
            },
            {
                label: t('common.delete'),
                icon: 'delete',
                onPress: () => handleDeleteFlashNote(selectedNote),
                destructive: true,
            },
        ];
    };

    useFocusEffect(useCallback(() => {
        // On focus, if we haven't loaded anything, load initial.
        // If we have loaded something, maybe just refresh?
        // For simplicity, let's refresh what we have.
        if (loadedFilePaths.length === 0) {
            loadInitialData();
        } else {
            refreshLoadedData();
        }

        if (cloudService.isInitialized()) {
            performAutoSync();
        }
    }, [loadInitialData, refreshLoadedData, performAutoSync, loadedFilePaths.length]));

    useEffect(() => {
        const subscription = DeviceEventEmitter.addListener(FLASH_NOTES_UPDATED_EVENT, () => {
            refreshLoadedData();
        });
        return () => subscription.remove();
    }, [refreshLoadedData]);

    useEffect(() => {
        // Trigger auto-sync when cloud initializes (fixes infinite spinner on startup)
        const initSub = DeviceEventEmitter.addListener(CLOUD_INIT_COMPLETED_EVENT, () => {
            performAutoSync();
        });

        // UPLOAD_COMPLETED_EVENT logic is now mostly handled by useCloudSync for status updates
        // BUT we still need to reload content if the file changed (e.g. download success)
        const uploadSub = DeviceEventEmitter.addListener(UPLOAD_COMPLETED_EVENT, (data: { filePath: string; success?: boolean }) => {
            // If the uploaded/downloaded file is one of the currently loaded files, refresh
            if (loadedFilePaths.includes(data.filePath) && data.success) {
                refreshLoadedData();
            }
        });
        return () => {
            initSub.remove();
            uploadSub.remove();
        };
    }, [refreshLoadedData, performAutoSync, loadedFilePaths]);

    useEffect(() => {
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

    useLayoutEffect(() => {
        navigation.setOptions({
            headerRight: () => (
                <HeaderSyncStatus isSyncing={isSyncing} syncStatus={syncStatus} conflictType={conflictType} />
            ),
        });
    }, [navigation, syncStatus, isSyncing, conflictType]);

    const renderItem = ({ item }: { item: FlashNote }) => (
        <View style={styles.card}>
            <TouchableOpacity
                onPress={() => handleEditNote(item)}
                onLongPress={() => handleNoteLongPress(item)}
            >
                <Text style={styles.timestamp}>{item.timestamp}</Text>
                <Text style={styles.content}>{item.content.trim()}</Text>
            </TouchableOpacity>
        </View>
    );

    const renderFooter = () => {
        if (!isLoadingMore && !hasMore) {
            return (
                <View style={styles.footer}>
                    <Text style={styles.footerText}>-- End of Timeline --</Text>
                </View>
            );
        }
        if (isLoadingMore) {
            return (
                <View style={styles.footer}>
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                </View>
            );
        }
        return null;
    };

    // Helper to determine if we should show the conflict banner (only for bidirectional or failure)
    const shouldShowConflictBanner = syncStatus === 'conflict' && (
        conflictType === 'bidirectional' ||
        !conflictType || // Fallback if type missing
        fileMetadata?.uploadState === 'failed' ||
        fileMetadata?.uploadState === 'conflict-failed'
    );

    return (
        <View style={styles.container}>
            {syncStatus === 'not-configured' && (
                <StatusBanner
                    visible={true}
                    message={'未配置云服务：当前仅使用本地存储'}
                    type="info"
                    onPress={() => navigation.navigate('MainTabs', { screen: 'Settings' })}
                />
            )}
            {syncStatus === 'offline' && (
                <StatusBanner
                    visible={true}
                    message={`${t('preview.offlineMode') || '离线模式：当前显示本地版本，可能不是最新'}${fileMetadata?.uploadState === 'failed' ? ' (上次上传失败)' : ''}`}
                    type="warning"
                    onPress={checkSync}
                />
            )}
            {shouldShowConflictBanner && (
                <StatusBanner
                    visible={true}
                    message={fileMetadata?.uploadState === 'failed'
                        ? '上传失败'
                        : '本地和云端已同时修改 (冲突)'
                    }
                    type="warning"
                    actions={fileMetadata?.uploadState === 'failed' ? [
                        { label: '上传本地覆盖云端', onPress: handleUploadOverwrite }
                    ] : [
                        { label: '使用云端版本', onPress: handleOverwriteLocal },
                        { label: '保存副本', onPress: handleSaveCopy },
                        { label: '上传覆盖', onPress: handleUploadOverwrite }
                    ]}
                />
            )}
            <FlatList
                data={notes}
                renderItem={renderItem}
                keyExtractor={(item, index) => `${item.id}-${index}`}
                contentContainerStyle={styles.listContent}
                onEndReached={handleLoadMore}
                onEndReachedThreshold={0.5}
                ListFooterComponent={renderFooter}
                refreshing={isRefreshing}
                onRefresh={loadInitialData}
            />
            <TouchableOpacity
                style={styles.fab}
                onPress={() => { setEditingNoteId(undefined); setEditingNoteContent(undefined); setIsModalVisible(true); }}
            >
                <Icon name="flash-on" size={24} color={theme.colors.white} />
            </TouchableOpacity>

            <FlashNoteInputModal
                visible={isModalVisible}
                initialId={editingNoteId}
                initialContent={editingNoteContent}
                onSave={handleSaveFlashNote}
                onCancel={handleCancelFlashNote}
                mode="note"
            />

            <ActionSheetModal
                visible={isActionSheetVisible}
                title={selectedNote?.content ? (selectedNote.content.length > 30 ? selectedNote.content.substring(0, 30) + '...' : selectedNote.content) : undefined}
                actions={getActionSheetActions()}
                onCancel={() => {
                    setIsActionSheetVisible(false);
                    setSelectedNote(null);
                }}
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
        padding: theme.spacing.md,
        paddingBottom: 80,
    },
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.md,
        padding: theme.spacing.md,
        marginBottom: theme.spacing.md,
        shadowColor: theme.colors.black,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 2,
    },
    timestamp: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginBottom: theme.spacing.xs,
    },
    content: {
        fontSize: 16,
        color: theme.colors.text,
        lineHeight: 24,
    },
    fab: {
        position: 'absolute',
        right: theme.spacing.lg,
        bottom: theme.spacing.lg,
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: theme.colors.primary,
        justifyContent: 'center',
        alignItems: 'center',
        elevation: 4,
        shadowColor: theme.colors.black,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
    },


    footer: {
        paddingVertical: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    footerText: {
        color: theme.colors.textSecondary,
        fontSize: 14,
    },
});
