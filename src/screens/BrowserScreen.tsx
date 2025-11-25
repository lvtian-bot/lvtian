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
import { cloudService } from '../services/CloudService';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { useFileListStore } from '../store/useFileListStore';

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

export const BrowserScreen = () => {
    const { t } = useTranslation();
    const [files, setFiles] = useState<ExtendedFileItem[]>([]);
    const [status, setStatus] = useState<Status>('idle');
    const [errorMessage, setErrorMessage] = useState('');
    const [prefix, setPrefix] = useState('');
    const [isOfflineMode, setIsOfflineMode] = useState(false);
    const [isCreateModalVisible, setIsCreateModalVisible] = useState(false);

    // 文件操作相关状态
    const [selectedFile, setSelectedFile] = useState<ExtendedFileItem | null>(null);
    const [showActionSheet, setShowActionSheet] = useState(false);
    const [showRenameDialog, setShowRenameDialog] = useState(false);
    const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);

    // 滚动位置记录
    const scrollPositionsRef = useRef<Record<string, number>>({});
    const flatListRef = useRef<FlatList>(null);
    const currentScrollY = useRef(0);

    const navigation = useNavigation<NavigationProp>();
    const { setCachedList, getCachedList } = useFileListStore();

    const loadFiles = useCallback(async () => {
        if (!cloudService.isConfigured()) {
            setStatus('unconfigured');
            return;
        }
        setStatus('loading');
        try {
            const cloudFiles = await cloudService.listFiles(prefix);

            // Cache the successful list
            setCachedList(prefix, cloudFiles);
            setIsOfflineMode(false);

            const fileList: ExtendedFileItem[] = cloudFiles.map((item): ExtendedFileItem => ({
                name: item.key.endsWith('/')
                    ? item.key.split('/').slice(-2, -1)[0] + '/'
                    : item.key.split('/').pop() ?? item.key,
                path: item.key,
                size: item.size,
                isDirectory: item.key.endsWith('/'),
                mtime: new Date(item.lastModified),
                isCached: true, // Online files are "cached" in the sense they are available (or downloadable)
            }));

            fileList.sort((a, b) => {
                if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                return a.name.localeCompare(b.name);
            });

            setFiles(fileList);
            setStatus('success');
        } catch (error: any) {
            console.error('Failed to load cloud files:', error);
            setIsOfflineMode(true);

            // Try to load from cache + local files
            try {
                const cachedCloudFiles = getCachedList(prefix);
                const localFiles = await fsService.listFiles(prefix);
                const localFileNames = new Set(localFiles.map(f => f.name));

                let mergedFiles: ExtendedFileItem[] = [];

                if (cachedCloudFiles) {
                    // We have a cached list, use it as the source of truth for "what exists"
                    mergedFiles = cachedCloudFiles.map((item): ExtendedFileItem => {
                        const name = item.key.endsWith('/')
                            ? item.key.split('/').slice(-2, -1)[0] + '/'
                            : item.key.split('/').pop() ?? item.key;

                        // Check if this file exists locally
                        // For directories, we assume they exist if they are in the list? 
                        // Or we check if local has that dir?
                        // fsService.listFiles returns directories too.
                        const isCached = localFileNames.has(name);

                        return {
                            name: name,
                            path: item.key,
                            size: item.size,
                            isDirectory: item.key.endsWith('/'),
                            mtime: new Date(item.lastModified),
                            isCached: item.key.endsWith('/') ? true : isCached, // Folders always "cached" (clickable) to navigate?
                            // Actually if folder is not locally present, we can't list its contents offline unless we have cache for THAT folder too.
                            // But let's allow clicking, it will try to load that folder's cache.
                        };
                    });
                } else {
                    // No cache. Check if local directory exists to decide if we should show empty list or error.
                    let useLocal = localFiles.length > 0 || prefix === '';
                    if (!useLocal) {
                        try {
                            useLocal = await fsService.exists(prefix);
                        } catch { }
                    }

                    if (useLocal) {
                        const rootPath = fsService.getRootPath();
                        mergedFiles = localFiles.map(f => {
                            let relativePath = f.path;
                            if (relativePath.startsWith(rootPath)) {
                                relativePath = relativePath.substring(rootPath.length);
                            }
                            relativePath = relativePath.replace(/^\/+/, '');
                            if (f.isDirectory && !relativePath.endsWith('/')) {
                                relativePath += '/';
                            }
                            return {
                                ...f,
                                path: relativePath,
                                isCached: true,
                            };
                        });

                        // If we decided to use local, we show success even if empty
                        mergedFiles.sort((a, b) => {
                            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                            return a.name.localeCompare(b.name);
                        });
                        setFiles(mergedFiles);
                        setStatus('success');
                        return;
                    }
                }

                if (mergedFiles.length > 0 || (cachedCloudFiles && cachedCloudFiles.length === 0)) {
                    mergedFiles.sort((a, b) => {
                        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                        return a.name.localeCompare(b.name);
                    });
                    setFiles(mergedFiles);
                    setStatus('success');
                    return;
                }

            } catch (localError) {
                console.log('Failed to load local/cached files:', localError);
            }

            let message = t('browser.error.default');
            if (error && error.code) {
                switch (error.code) {
                    case 'SignatureDoesNotMatch': message = t('browser.error.auth'); break;
                    case 'NoSuchBucket': message = t('browser.error.bucket'); break;
                    case 'NetworkError': message = t('browser.error.network'); break;
                }
            }
            setErrorMessage(message);
            setStatus('error');
        }
    }, [prefix, t, getCachedList, setCachedList]);

    const handlePathPress = (newPath: string) => {
        setPrefix(newPath);
    };

    // Set header options (title and add button)
    useEffect(() => {
        navigation.setOptions({
            title: t('tabs.browser'),
            headerRight: () => (
                <TouchableOpacity
                    onPress={() => setIsCreateModalVisible(true)}
                    style={styles.headerButton}
                >
                    <Icon name="note-add" size={24} color={theme.colors.primary} />
                </TouchableOpacity>
            ),
        });
    }, [navigation, t]);

    const handleCreateFile = async (filename: string) => {
        setIsCreateModalVisible(false);

        let finalFilename = filename;
        if (!finalFilename.toLowerCase().endsWith('.md')) {
            finalFilename += '.md';
        }

        const fullPath = prefix + finalFilename;

        try {
            // Check if file already exists
            const exists = await fsService.exists(fullPath);
            if (exists) {
                Alert.alert(t('common.error'), t('browser.fileAlreadyExists') || 'File already exists');
                return;
            }

            // Navigate to editor with new file path
            navigation.navigate('Editor', { filePath: fullPath });
        } catch (error) {
            console.error('Error checking file existence:', error);
            Alert.alert(t('common.error'), String(error));
        }
    };

    // 恢复滚动位置
    useEffect(() => {
        if (status === 'success' && files.length > 0) {
            const savedPosition = scrollPositionsRef.current[prefix];
            if (savedPosition !== undefined) {
                // 延迟恢复，确保列表已渲染
                setTimeout(() => {
                    flatListRef.current?.scrollToOffset({
                        offset: savedPosition,
                        animated: false,
                    });
                }, 100);
            }
        }
    }, [status, prefix, files.length]);

    // This effect will handle the hardware back button
    useFocusEffect(
        useCallback(() => {
            const onBackPress = () => {
                if (prefix) {
                    const parts = prefix.split('/').filter(Boolean);
                    parts.pop();
                    const parentPrefix = parts.length > 0 ? parts.join('/') + '/' : '';
                    setPrefix(parentPrefix);
                    return true; // Prevent default action
                }
                return false; // Allow default action
            };

            const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);

            return () => subscription.remove();
        }, [prefix])
    );

    useFocusEffect(useCallback(() => {
        loadFiles();
    }, [loadFiles]));

    const handleDeleteFile = async (fileToDelete: FileItem) => {
        console.log('=== handleDeleteFile called ===');
        console.log('File to delete:', fileToDelete.name);

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
                                console.log('=== Starting delete operation ===');
                                console.log('File to delete:', fileToDelete.name);
                                console.log('File path:', fileToDelete.path);

                                // Step 1: Delete from local file system first (safer - can recover from cloud)
                                const localFileExists = await fsService.exists(fileToDelete.path);
                                console.log('Local file exists:', localFileExists);

                                if (localFileExists) {
                                    await fsService.deleteFile(fileToDelete.path);
                                    console.log('Local file deleted');
                                }

                                // Step 2: Delete from the cloud
                                console.log('Starting cloud delete...');
                                await cloudService.deleteFile(fileToDelete.path);
                                console.log('Cloud delete successful!');

                                // Temporarily remove Alert to avoid Android Activity issue
                                console.log('Delete completed successfully');
                                loadFiles(); // Refresh the list
                            } catch (error) {
                                console.error('Failed to delete file:', error);
                                console.error('Error type:', typeof error);
                                console.error('Error message:', error instanceof Error ? error.message : String(error));

                                // Show error alert with delay to ensure Activity is ready
                                setTimeout(() => {
                                    Alert.alert(t('common.error'), t('browser.deleteFailed') + '\n' + (error instanceof Error ? error.message : String(error)));
                                }, 500);
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

    // 处理长按文件
    const handleFileLongPress = (item: ExtendedFileItem) => {
        // 文件夹不支持删除、重命名、移动操作
        if (item.isDirectory) {
            return;
        }

        setSelectedFile(item);
        setShowActionSheet(true);
    };

    // 处理重命名
    const handleRename = async (newName: string) => {
        if (!selectedFile) return;

        try {
            const oldPath = selectedFile.path;
            const pathParts = oldPath.split('/');
            pathParts[pathParts.length - (selectedFile.isDirectory ? 2 : 1)] = newName;
            const newPath = pathParts.join('/');

            // 重命名本地文件
            const localExists = await fsService.exists(oldPath);
            if (localExists) {
                await fsService.moveFile(oldPath, newPath);
            }

            // 重命名云端文件（通过复制+删除实现）
            if (cloudService.isConfigured()) {
                // 对于文件，需要下载后重新上传
                if (!selectedFile.isDirectory) {
                    // 确保本地文件存在
                    if (!localExists) {
                        await cloudService.downloadFile(oldPath, oldPath);
                    }
                    // 读取文件内容
                    const content = await fsService.readFile(newPath);
                    // 上传到新路径
                    await cloudService.uploadFile(newPath, content);
                    // 删除旧路径
                    await cloudService.deleteFile(oldPath);
                }
            }

            Alert.alert(t('common.success'), '重命名成功');
            setShowRenameDialog(false);
            setSelectedFile(null);
            loadFiles();
        } catch (error) {
            console.error('Failed to rename:', error);
            Alert.alert(t('common.error'), '重命名失败：' + (error instanceof Error ? error.message : String(error)));
        }
    };

    // 处理移动
    const handleMove = async (targetPath: string) => {
        if (!selectedFile) return;

        try {
            const oldPath = selectedFile.path;
            const fileName = selectedFile.name;
            const newPath = targetPath ? `${targetPath}${fileName}` : fileName;

            if (oldPath === newPath) {
                Alert.alert(t('common.notice'), '目标位置与当前位置相同');
                setShowDirectoryPicker(false);
                setSelectedFile(null);
                return;
            }

            // 移动本地文件
            const localExists = await fsService.exists(oldPath);
            if (localExists) {
                await fsService.moveFile(oldPath, newPath);
            }

            // 移动云端文件
            if (cloudService.isConfigured()) {
                if (!selectedFile.isDirectory) {
                    // 确保本地文件存在
                    if (!localExists) {
                        await cloudService.downloadFile(oldPath, oldPath);
                    }
                    // 读取文件内容
                    const content = await fsService.readFile(newPath);
                    // 上传到新路径
                    await cloudService.uploadFile(newPath, content);
                    // 删除旧路径
                    await cloudService.deleteFile(oldPath);
                }
            }

            Alert.alert(t('common.success'), '移动成功');
            setShowDirectoryPicker(false);
            setSelectedFile(null);
            loadFiles();
        } catch (error) {
            console.error('Failed to move:', error);
            Alert.alert(t('common.error'), '移动失败：' + (error instanceof Error ? error.message : String(error)));
        }
    };

    const handleFilePress = async (item: ExtendedFileItem) => {
        if (isOfflineMode && !item.isDirectory && !item.isCached) {
            Alert.alert(t('common.notice'), t('browser.offlineFileNotCached') || 'File not cached locally');
            return;
        }

        if (item.isDirectory) {
            setPrefix(item.path);
        } else {
            if (item.name.endsWith('.md')) {
                try {
                    const exists = await fsService.exists(item.path);
                    if (exists) {
                        navigation.navigate('Preview', { filePath: item.path });
                    } else {
                        if (isOfflineMode) {
                            Alert.alert(t('common.notice'), t('browser.offlineFileNotCached') || 'File not cached locally');
                            return;
                        }
                        setStatus('loading');
                        const result = await cloudService.downloadFile(item.path, item.path);

                        // Set the metadata for the newly downloaded file
                        const { setMetadata } = useFileMetadataStore.getState();
                        setMetadata(item.path, result.etag, result.lastModified);

                        setStatus('success');
                        navigation.navigate('Preview', { filePath: item.path });
                    }
                } catch (error) {
                    console.error('Failed to open file:', error);
                    setStatus('success'); // Restore UI
                    Alert.alert(t('browser.error.downloadFailed'), String(error));
                }
            } else {
                console.log('Not a markdown file:', item.name);
                Alert.alert(t('browser.info.notMarkdown'));
            }
        }
    };

    const renderContent = () => {
        switch (status) {
            case 'loading':
            case 'idle':
                return <ActivityIndicator style={styles.messageContainer} size="large" />;
            case 'error':
                return <MessageView title={t('browser.loadingFailedTitle')} message={errorMessage} buttonText={t('browser.retry')} onButtonPress={loadFiles} />;
            case 'unconfigured':
                return <MessageView title={t('browser.unconfiguredTitle')} message={t('browser.unconfiguredMessage')} buttonText={t('browser.goToSettings')} onButtonPress={() => navigation.navigate('MainTabs', { screen: 'Settings' })} />;
            case 'success':
                return (
                    <View style={styles.fileListContainer}>
                        {isOfflineMode && (
                            <View style={styles.offlineBanner}>
                                <Text style={styles.offlineBannerText}>{t('browser.offlineMode') || 'Offline Mode - Showing cached list'}</Text>
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
                            refreshControl={<RefreshControl refreshing={false} onRefresh={loadFiles} />}
                            ListEmptyComponent={<MessageView title={t('browser.emptyTitle')} message={t('browser.emptyMessage')} />}
                            onScroll={(event) => {
                                const scrollY = event.nativeEvent.contentOffset.y;
                                currentScrollY.current = scrollY;
                                scrollPositionsRef.current[prefix] = scrollY;
                            }}
                            scrollEventThrottle={16}
                        />
                    </View>
                );
        }
    };

    // 准备操作菜单的选项
    const getFileActions = (): FileAction[] => {
        if (!selectedFile) return [];

        const actions: FileAction[] = [
            {
                label: '重命名',
                icon: 'edit',
                onPress: () => {
                    setShowActionSheet(false);
                    setShowRenameDialog(true);
                },
            },
            {
                label: '移动',
                icon: 'drive-file-move',
                onPress: () => {
                    setShowActionSheet(false);
                    setShowDirectoryPicker(true);
                },
            },
            {
                label: '删除',
                icon: 'delete',
                onPress: () => {
                    setShowActionSheet(false);
                    handleDeleteFile(selectedFile);
                    setSelectedFile(null);
                },
                destructive: true,
            },
        ];

        return actions;
    };

    return (
        <View style={styles.container}>
            <Breadcrumb path={prefix} onPathPress={handlePathPress} />
            {renderContent()}

            <CreateFileModal
                visible={isCreateModalVisible}
                onConfirm={handleCreateFile}
                onCancel={() => setIsCreateModalVisible(false)}
            />

            {/* 文件操作菜单 */}
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
                        currentName={selectedFile.name.replace(/\/$/, '')} // 移除文件夹名末尾的 /
                        onConfirm={handleRename}
                        onCancel={() => {
                            setShowRenameDialog(false);
                            setSelectedFile(null);
                        }}
                    />

                    <DirectoryPicker
                        visible={showDirectoryPicker}
                        currentPath={selectedFile.path}
                        onConfirm={(targetPath) => {
                            handleMove(targetPath);
                        }}
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
    headerBackButton: { marginLeft: -5, padding: 10 },
    headerBackButtonText: { color: theme.colors.primary, fontSize: 16 },
    offlineBanner: {
        backgroundColor: '#FFF3CD',
        padding: 8,
        alignItems: 'center',
        borderBottomWidth: 1,
        borderBottomColor: '#FFEEBA',
    },
    offlineBannerText: {
        color: '#856404',
        fontSize: 12,
    },
    fileListContainer: {
        flex: 1,
    },
    headerButton: {
        padding: 8,
    },
});
