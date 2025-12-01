import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    FlatList,
    RefreshControl,
    ActivityIndicator,
    TouchableOpacity,
    Alert,
    BackHandler,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import Icon from 'react-native-vector-icons/MaterialIcons';

import { FileListItem } from '../components/FileListItem';
import { FileActionSheet, FileAction } from '../components/FileActionSheet';
import { RenameDialog } from '../components/RenameDialog';
import { DirectoryPicker } from '../components/DirectoryPicker';
import { CreateFileModal } from '../components/CreateFileModal';
import { Breadcrumb } from '../components/Breadcrumb';

import { theme } from '../utils/theme';
import { RootStackParamList } from '../types/navigation';
import { FileItem, fsService } from '../services/FileSystemService';
import { cloudService, UPLOAD_COMPLETED_EVENT } from '../services/CloudService';
import { DeviceEventEmitter } from 'react-native';
import { useFileListStore } from '../store/useFileListStore';
import { syncService } from '../services/SyncService';

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;
type Status = 'idle' | 'loading' | 'success' | 'error' | 'unconfigured';

type ExtendedFileItem = FileItem & { isCached?: boolean };

const MessageView = ({ title, message, buttonText, onButtonPress }: { title: string; message: string; buttonText?: string; onButtonPress?: () => void; }) => (
    <View style={styles.messageContainer}>
        <Text style={styles.messageTitle}>{title}</Text>
        <Text style={styles.messageText}>{message}</Text>
        {buttonText && onButtonPress && (
            <TouchableOpacity style={styles.button} onPress={onButtonPress}>
                <Text style={styles.buttonText}>{buttonText}</Text>
            </TouchableOpacity>
        )}
    </View>
);

export const NoteScreen = () => {
    const { t } = useTranslation();
    const [files, setFiles] = useState<ExtendedFileItem[]>([]);
    const [status, setStatus] = useState<Status>('idle');
    const [errorMessage, setErrorMessage] = useState('');
    const [prefix, setPrefix] = useState('');
    const [isOfflineMode, setIsOfflineMode] = useState(false);
    const [isCreateModalVisible, setIsCreateModalVisible] = useState(false);

    // Restored File Action States
    const [selectedFile, setSelectedFile] = useState<ExtendedFileItem | null>(null);
    const [showActionSheet, setShowActionSheet] = useState(false);
    const [showRenameDialog, setShowRenameDialog] = useState(false);
    const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);

    const flatListRef = useRef<FlatList>(null);

    const navigation = useNavigation<NavigationProp>();
    const { setCachedList, getCachedList } = useFileListStore();

    // Helper to format file list safely
    const formatFileList = useCallback((list: any[]): ExtendedFileItem[] => {
        return list
            .filter(item => item && item.key)
            .map((item): ExtendedFileItem => ({
                name: item.key.endsWith('/')
                    ? item.key.split('/').slice(-2, -1)[0] + '/'
                    : item.key.split('/').pop() ?? item.key,
                path: item.key,
                size: item.size || 0,
                isDirectory: item.key.endsWith('/'),
                mtime: item.lastModified ? new Date(item.lastModified) : new Date(),
                isCached: true,
            }))
            .sort((a, b) => {
                if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
    }, []);

    const loadFiles = useCallback(async () => {
        console.log('[NoteScreen] loadFiles, prefix:', prefix);

        if (!cloudService.isConfigured()) {
            setStatus('unconfigured');
            return;
        }

        // 1. Try Cache First (Fast Render)
        try {
            const cachedCloudFiles = getCachedList(prefix);
            if (cachedCloudFiles && cachedCloudFiles.length > 0) {
                console.log('[BrowserScreen] Showing cached files:', cachedCloudFiles.length);
                setFiles(formatFileList(cachedCloudFiles));
                setStatus('success'); // Show immediately
            } else {
                setStatus('loading');
            }
        } catch (e) {
            console.warn('[BrowserScreen] Cache read error:', e);
            setStatus('loading');
        }

        // 2. Fetch Cloud (Network Update)
        try {
            console.log('[BrowserScreen] Fetching from cloud...');
            const cloudFiles = await cloudService.listFiles(prefix);
            console.log('[BrowserScreen] Cloud fetch success, count:', cloudFiles.length);

            setCachedList(prefix, cloudFiles);
            setIsOfflineMode(false);
            setFiles(formatFileList(cloudFiles));
            setStatus('success');

        } catch (error: any) {
            console.error('[BrowserScreen] Cloud load failed:', error);

            // If we have files (from cache), just show offline banner
            if (files.length > 0) {
                setIsOfflineMode(true);
                return; // Keep showing cached files
            }

            // Simplified Error Handling: NO local FS fallback for now to reduce complexity
            setIsOfflineMode(true);

            let message = t('browser.error.default');
            if (error?.code === 'SignatureDoesNotMatch') message = t('browser.error.auth');
            else if (error?.code === 'NoSuchBucket') message = t('browser.error.bucket');
            else if (error?.code === 'NetworkError') message = t('browser.error.network');

            setErrorMessage(message);
            setStatus('error');
        }
    }, [prefix, t, getCachedList, setCachedList, formatFileList, files.length]);

    // Event Listeners
    useEffect(() => {
        const sub = DeviceEventEmitter.addListener(UPLOAD_COMPLETED_EVENT, loadFiles);
        return () => sub.remove();
    }, [loadFiles]);

    // Header Options
    useEffect(() => {
        navigation.setOptions({
            headerRight: () => (
                <TouchableOpacity onPress={() => setIsCreateModalVisible(true)} style={styles.headerButton}>
                    <Icon name="note-add" size={24} color={theme.colors.primary} />
                </TouchableOpacity>
            ),
        });
    }, [navigation]);

    // Create File Logic
    const handleCreateFile = async (filename: string) => {
        setIsCreateModalVisible(false);
        let finalFilename = filename.trim();
        if (!finalFilename) return;
        if (!finalFilename.toLowerCase().endsWith('.md')) finalFilename += '.md';

        const fullPath = prefix + finalFilename;
        try {
            const exists = await fsService.exists(fullPath);
            if (exists) {
                Alert.alert(t('common.error'), t('browser.fileAlreadyExists') || 'File exists');
                return;
            }
            navigation.navigate('Editor', { filePath: fullPath });
        } catch (error) {
            Alert.alert(t('common.error'), String(error));
        }
    };

    // Back Handler
    useFocusEffect(
        useCallback(() => {
            const onBackPress = () => {
                if (prefix) {
                    const parts = prefix.split('/').filter(Boolean);
                    parts.pop();
                    setPrefix(parts.length > 0 ? parts.join('/') + '/' : '');
                    return true;
                }
                return false;
            };
            const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
            return () => subscription.remove();
        }, [prefix])
    );

    // Initial Load
    useFocusEffect(useCallback(() => { loadFiles(); }, [loadFiles]));

    const handleDeleteFile = async (fileToDelete: FileItem) => {
        try {
            Alert.alert(
                t('common.confirm'),
                t('browser.confirmDelete', { fileName: fileToDelete.name }),
                [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                        text: t('common.confirm'),
                        onPress: async () => {
                            try {
                                console.log('Deleting file:', fileToDelete.path);
                                // 1. Delete from Cloud
                                await cloudService.deleteFile(fileToDelete.path);

                                // 2. Try delete from Local (Clean up cache)
                                const localExists = await fsService.exists(fileToDelete.path);
                                if (localExists) {
                                    await fsService.deleteFile(fileToDelete.path);
                                }

                                // 3. Refresh List
                                loadFiles();
                            } catch (error) {
                                console.error('Failed to delete file:', error);
                                Alert.alert(t('common.error'), t('browser.deleteFailed') + '\n' + String(error));
                            }
                        },
                    },
                ],
                { cancelable: true }
            );
        } catch (error) {
            console.error('Error showing delete confirmation:', error);
        }
    };

    const handleRename = async (newName: string) => {
        if (!selectedFile) return;

        const oldPath = selectedFile.path;
        const pathParts = oldPath.split('/');
        pathParts[pathParts.length - (selectedFile.isDirectory ? 2 : 1)] = newName;
        const newPath = pathParts.join('/');

        try {
            // 1. Rename Local if exists (to ensure content preservation for upload)
            // If local doesn't exist, we need to download first?
            // Actually, for rename, if we don't have local, we can technically copy+delete on cloud.
            // But TencentCOSProvider doesn't expose copyObject yet. 
            // So safe fallback: Ensure local exists -> Move Local -> Upload New -> Delete Old Cloud.

            let hasContent = await fsService.exists(oldPath);
            if (!hasContent && !selectedFile.isDirectory) {
                // Download content first if missing locally
                await syncService.performDownload(oldPath);
                hasContent = true;
            }

            if (hasContent) {
                await fsService.moveFile(oldPath, newPath);
                await syncService.uploadFile(newPath);
                await cloudService.deleteFile(oldPath);

                Alert.alert(t('common.success'), 'Rename successful');
                loadFiles();
            } else {
                throw new Error('Cannot rename: Local file sync failed.');
            }
        } catch (error) {
            console.error('Rename failed:', error);
            Alert.alert(t('common.error'), 'Rename failed: ' + String(error));
        } finally {
            setShowRenameDialog(false);
            setSelectedFile(null);
        }
    };

    const handleMove = async (targetPath: string) => {
        if (!selectedFile) return;

        try {
            const oldPath = selectedFile.path;
            const fileName = selectedFile.name;
            const newPath = targetPath ? `${targetPath}${fileName}` : fileName;

            if (oldPath === newPath) {
                setShowDirectoryPicker(false);
                setSelectedFile(null);
                return;
            }

            // Similar logic to Rename: Move Local -> Upload New -> Delete Old Cloud
            let hasContent = await fsService.exists(oldPath);
            if (!hasContent && !selectedFile.isDirectory) {
                await syncService.performDownload(oldPath);
                hasContent = true;
            }

            if (hasContent) {
                await fsService.moveFile(oldPath, newPath);
                await syncService.uploadFile(newPath);
                await cloudService.deleteFile(oldPath);

                Alert.alert(t('common.success'), 'Move successful');
                loadFiles();
            } else {
                throw new Error('Cannot move: Local file sync failed.');
            }

        } catch (error) {
            console.error('Move failed:', error);
            Alert.alert(t('common.error'), 'Move failed: ' + String(error));
        } finally {
            setShowDirectoryPicker(false);
            setSelectedFile(null);
        }
    };

    const handleFilePress = async (item: ExtendedFileItem) => {
        if (item.isDirectory) {
            setPrefix(item.path);
        } else {
            try {
                // Check local existence first
                const exists = await fsService.exists(item.path);
                if (exists) {
                    navigation.navigate('Preview', { filePath: item.path });
                } else {
                    // Not found locally, download on demand
                    setStatus('loading'); // Show spinner while downloading
                    const success = await syncService.performDownload(item.path);

                    if (success) {
                        setStatus('success');
                        navigation.navigate('Preview', { filePath: item.path });
                    } else {
                        throw new Error(t('browser.error.downloadFailed') || 'Download failed');
                    }
                }
            } catch (error) {
                console.error('Failed to open file:', error);
                setStatus('success'); // Restore UI
                Alert.alert(t('common.error'), String(error));
            }
        }
    };

    const handleFileLongPress = (item: ExtendedFileItem) => {
        if (item.isDirectory) return;
        setSelectedFile(item);
        setShowActionSheet(true);
    };

    const getFileActions = (): FileAction[] => {
        if (!selectedFile) return [];
        return [
            {
                label: 'Rename',
                icon: 'edit',
                onPress: () => {
                    setShowActionSheet(false);
                    setShowRenameDialog(true);
                },
            },
            {
                label: 'Move',
                icon: 'drive-file-move',
                onPress: () => {
                    setShowActionSheet(false);
                    setShowDirectoryPicker(true);
                },
            },
            {
                label: 'Delete',
                icon: 'delete',
                onPress: () => {
                    setShowActionSheet(false);
                    handleDeleteFile(selectedFile);
                    setSelectedFile(null);
                },
                destructive: true,
            },
        ];
    };

    const renderContent = () => {
        if (status === 'unconfigured') {
            return <MessageView title={t('browser.unconfiguredTitle')} message={t('browser.unconfiguredMessage')} buttonText={t('browser.goToSettings')} onButtonPress={() => navigation.navigate('MainTabs', { screen: 'Settings' })} />;
        }

        if (status === 'loading' && files.length === 0) {
            return <ActivityIndicator style={styles.messageContainer} size="large" />;
        }

        if (status === 'error' && files.length === 0) {
            return <MessageView title={t('browser.loadingFailedTitle')} message={errorMessage} buttonText={t('browser.retry')} onButtonPress={loadFiles} />;
        }

        return (
            <View style={styles.fileListContainer}>
                {isOfflineMode && (
                    <View style={styles.offlineBanner}>
                        <Text style={styles.offlineBannerText}>{t('browser.offlineMode') || 'Offline Mode'}</Text>
                    </View>
                )}
                <FlatList
                    ref={flatListRef}
                    data={files}
                    renderItem={({ item }) => (
                        <FileListItem
                            item={item}
                            onPress={handleFilePress}
                            onLongPress={handleFileLongPress}
                            isCached={item.isCached}
                        />
                    )}
                    keyExtractor={(item) => item.path}
                    refreshControl={<RefreshControl refreshing={status === 'loading'} onRefresh={loadFiles} />}
                    ListEmptyComponent={<MessageView title={t('browser.emptyTitle')} message={t('browser.emptyMessage')} />}
                    removeClippedSubviews={false}
                    initialNumToRender={15}
                    maxToRenderPerBatch={15}
                    windowSize={10}
                />
            </View>
        );
    };

    return (
        <View style={styles.container}>
            <Breadcrumb path={prefix} onPathPress={setPrefix} />
            {renderContent()}

            <CreateFileModal
                visible={isCreateModalVisible}
                onConfirm={handleCreateFile}
                onCancel={() => setIsCreateModalVisible(false)}
            />

            {selectedFile && (
                <>
                    <FileActionSheet
                        visible={showActionSheet}
                        fileName={selectedFile.name}
                        actions={getFileActions()}
                        onCancel={() => {
                            setShowActionSheet(false);
                            setSelectedFile(null);
                        }}
                    />
                    <RenameDialog
                        visible={showRenameDialog}
                        currentName={selectedFile.name.replace(/\/$/, '')}
                        onConfirm={handleRename}
                        onCancel={() => {
                            setShowRenameDialog(false);
                            setSelectedFile(null);
                        }}
                    />
                    <DirectoryPicker
                        visible={showDirectoryPicker}
                        currentPath={selectedFile.path}
                        onConfirm={handleMove}
                        onCancel={() => {
                            setShowDirectoryPicker(false);
                            setSelectedFile(null);
                        }}
                    />
                </>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.background },
    messageContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: theme.spacing.l },
    messageTitle: { fontSize: theme.typography.h2.fontSize, fontWeight: 'bold', color: theme.colors.text, marginBottom: theme.spacing.m, textAlign: 'center' },
    messageText: { color: theme.colors.textSecondary, fontSize: theme.typography.body.fontSize, textAlign: 'center', lineHeight: 22 },
    button: { backgroundColor: theme.colors.primary, paddingVertical: theme.spacing.s, paddingHorizontal: theme.spacing.l, borderRadius: 8, alignItems: 'center', marginTop: theme.spacing.l },
    buttonText: { color: theme.colors.white, fontSize: 16, fontWeight: 'bold' },
    headerButton: { padding: 8 },
    offlineBanner: { backgroundColor: '#FFF3CD', padding: 8, alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#FFEEBA' },
    offlineBannerText: { color: '#856404', fontSize: 12 },
    fileListContainer: { flex: 1 },
});
