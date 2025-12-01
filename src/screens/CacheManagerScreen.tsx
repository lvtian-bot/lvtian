import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { Switch } from 'react-native'; // Import Switch component
import { useSettingsStore } from '../store/useSettingsStore'; // Import useSettingsStore
import { normalizePath } from '../utils/pathUtils'; // Import normalizePath
import { theme } from '../utils/theme';
import { fsService, FileItem } from '../services/FileSystemService';
import { useFileMetadataStore, LOCAL_MODIFIED_HASH } from '../store/useFileMetadataStore';

interface CacheFileItem extends FileItem {
    isSafeToDelete: boolean;
    status: 'synced' | 'modified' | 'uploading' | 'failed';
    relativePath: string;
}

export const CacheManagerScreen = () => {
    const { t } = useTranslation();
    const [files, setFiles] = useState<CacheFileItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [totalSize, setTotalSize] = useState(0);
    const [safeToDeleteSize, setSafeToDeleteSize] = useState(0);

    const { getMetadata } = useFileMetadataStore();
    const {
        flashNoteConfig,
        showFlashNotesInCache,
        setShowFlashNotesInCache,
    } = useSettingsStore();

    const isFlashNoteFile = useCallback((filePath: string): boolean => {
        // Ensure flashNoteConfig is fully loaded before using
        if (!flashNoteConfig || !flashNoteConfig.filename) return false;

        const { path, filename, historyPattern, historyFolderPath } = flashNoteConfig;



        // Normalize the main flash note path
        const mainFlashNotePath = path ? `${path}/${filename}` : filename;
        const normalizedMainFlashNotePath = normalizePath(mainFlashNotePath);

        // Check if it's the main flash note file
        if (normalizePath(filePath) === normalizedMainFlashNotePath) {
            return true;
        }

        // Check if it's a history flash note file
        if (historyPattern && historyPattern !== 'none') {
            const namePart = filename.replace(/\.md$/i, '');
            let regex: RegExp | null = null;

            // Define history file regex based on pattern
            // Note: These regexes are copied from FlashNoteService for consistency
            if (historyPattern === 'dash-yyyymm') {
                const escapedName = namePart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                regex = new RegExp(`^${escapedName}-(\\d{6})\\.md$`, 'i');
            } else if (historyPattern === 'underscore-yyyymm') {
                const escapedName = namePart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                regex = new RegExp(`^${escapedName}_(\\d{6})\\.md$`, 'i');
            } else if (historyPattern === 'dash-yyyy') {
                const escapedName = namePart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                regex = new RegExp(`^${escapedName}-(\\d{4})\\.md$`, 'i');
            } else if (historyPattern === 'chinese-yyyymm') {
                const escapedName = namePart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                regex = new RegExp(`^${escapedName}-(\\d{4})年(\\d{1,2})月\\.md$`, 'i');
            }

            if (regex) {
                const fileLocalName = filePath.split('/').pop() || '';
                if (regex.test(fileLocalName)) {
                    // Additionally, ensure it's in the flash note's path or history folder path
                    // This logic is crucial to avoid matching similarly named files in other folders
                    const scanDirPath = historyFolderPath || path || ''; // Use history folder if set, else main path
                    // Ensure the filePath starts with the expected directory for flash notes
                    if (normalizePath(filePath).startsWith(normalizePath(scanDirPath))) {
                        return true;
                    }
                }
            }
        }
        return false;
    }, [flashNoteConfig]);

    const loadFiles = useCallback(async () => {
        setLoading(true);
        try {
            // Recursively list all files
            const allFiles: FileItem[] = [];
            const processDirectory = async (path: string) => {
                const items = await fsService.listFiles(path);
                for (const item of items) {
                    if (item.isDirectory) {
                        // fsService.listFiles returns absolute paths, but expects relative paths as input.
                        // We must strip the root path before recursing.
                        const rootPath = fsService.getRootPath();
                        let relativePath = item.path;
                        if (relativePath.startsWith(rootPath)) {
                            relativePath = relativePath.substring(rootPath.length);
                        }
                        relativePath = relativePath.replace(/^\/+/, '');

                        await processDirectory(relativePath);
                    } else {
                        allFiles.push(item);
                    }
                }
            };

            // Start from root
            await processDirectory('');

            const processedFiles: CacheFileItem[] = allFiles.map(file => {
                // Get relative path for metadata lookup
                const rootPath = fsService.getRootPath();
                let relativePath = file.path;
                if (relativePath.startsWith(rootPath)) {
                    relativePath = relativePath.substring(rootPath.length);
                }
                relativePath = relativePath.replace(/^\/+/, '');

                const metadata = getMetadata(relativePath);
                const isModified = metadata?.localHash === LOCAL_MODIFIED_HASH;
                const isUploading = metadata?.uploadState === 'uploading';
                const isFailed = metadata?.uploadState === 'failed';

                let status: CacheFileItem['status'] = 'synced';
                if (isModified) status = 'modified';
                else if (isUploading) status = 'uploading';
                else if (isFailed) status = 'failed';

                // Safe to delete if not modified locally and not currently uploading
                const isSafeToDelete = !isModified && !isUploading && !isFailed;

                return {
                    ...file,
                    isSafeToDelete,
                    status,
                    relativePath
                };
            });

            // Sort: Unsafe first, then by size desc
            processedFiles.sort((a, b) => {
                if (a.isSafeToDelete !== b.isSafeToDelete) return a.isSafeToDelete ? 1 : -1;
                return b.size - a.size;
            });

            let finalFiles = processedFiles;
            if (!showFlashNotesInCache) {
                finalFiles = processedFiles.filter(file => !isFlashNoteFile(file.relativePath));
            }
            setFiles(finalFiles);

            // Calculate sizes
            const total = processedFiles.reduce((acc, file) => acc + file.size, 0);
            const safe = processedFiles.filter(f => f.isSafeToDelete).reduce((acc, file) => acc + file.size, 0);
            setTotalSize(total);
            setSafeToDeleteSize(safe);

        } catch (error) {
            console.error('Failed to load cache files:', error);
            Alert.alert(t('common.error'), t('cache.loadFailed'));
        } finally {
            setLoading(false);
        }
    }, [t, getMetadata, isFlashNoteFile, showFlashNotesInCache]);

    useEffect(() => {
        loadFiles();
    }, [loadFiles]);

    const formatSize = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const handleDelete = async (file: CacheFileItem) => {
        if (!file.isSafeToDelete) {
            Alert.alert(
                t('cache.unsafeDeleteTitle'),
                t('cache.unsafeDeleteMessage'),
                [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                        text: t('common.delete'),
                        style: 'destructive',
                        onPress: async () => {
                            await performDelete(file);
                        }
                    }
                ]
            );
            return;
        }
        await performDelete(file);
    };

    const performDelete = async (file: CacheFileItem) => {
        try {
            await fsService.deleteFile(file.relativePath);
            loadFiles();
        } catch (error) {
            console.error('Failed to delete file:', error);
            Alert.alert(t('common.error'), t('cache.deleteFailed'));
        }
    };

    const handleClearAll = () => {
        if (safeToDeleteSize === 0) {
            Alert.alert(t('common.notice'), t('cache.noSafeFiles'));
            return;
        }

        Alert.alert(
            t('cache.clearAllTitle'),
            t('cache.clearAllMessage', { size: formatSize(safeToDeleteSize) }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.confirm'),
                    style: 'destructive',
                    onPress: async () => {
                        setLoading(true);
                        try {
                            const safeFiles = files.filter(f => f.isSafeToDelete);
                            for (const file of safeFiles) {
                                await fsService.deleteFile(file.path);
                            }
                            Alert.alert(t('common.success'), t('cache.clearSuccess'));
                            loadFiles();
                        } catch (error) {
                            console.error('Failed to clear cache:', error);
                            Alert.alert(t('common.error'), t('cache.clearFailed'));
                            setLoading(false);
                        }
                    }
                }
            ]
        );
    };

    const renderItem = ({ item }: { item: CacheFileItem }) => (
        <View style={styles.fileItem}>
            <View style={styles.fileIcon}>
                <Icon
                    name={item.isSafeToDelete ? "file-check-outline" : "file-alert-outline"}
                    size={20}
                    color={item.isSafeToDelete ? theme.colors.textSecondary : theme.colors.warning}
                />
            </View>
            <View style={styles.fileContent}>
                <View style={styles.fileTopRow}>
                    <Text style={styles.fileName} numberOfLines={1}>{item.name}</Text>
                    <Text style={styles.fileSize}>{formatSize(item.size)}</Text>
                </View>
                <Text style={styles.filePath} numberOfLines={1}>{item.relativePath}</Text>
            </View>
            <TouchableOpacity onPress={() => handleDelete(item)} style={styles.deleteButton}>
                <Icon name="trash-can-outline" size={18} color={theme.colors.textSecondary} />
            </TouchableOpacity>
        </View>
    );

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <View style={styles.statsCard}>
                    <Text style={styles.statsLabel}>{t('cache.totalSize')}</Text>
                    <Text style={styles.statsValue}>{formatSize(totalSize)}</Text>
                    <Text style={styles.statsSub}>{t('cache.safeToClear')}: {formatSize(safeToDeleteSize)}</Text>
                </View>

                {/* Toggle to show/hide flash notes */}
                <View style={styles.settingRow}>
                    <Text style={styles.settingLabel}>{t('cache.showFlashNotes')}</Text>
                    <Switch
                        trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
                        thumbColor={theme.colors.white}
                        ios_backgroundColor={theme.colors.border}
                        onValueChange={setShowFlashNotesInCache}
                        value={showFlashNotesInCache}
                    />
                </View>

                <TouchableOpacity
                    style={[styles.clearButton, safeToDeleteSize === 0 && styles.clearButtonDisabled]}
                    onPress={handleClearAll}
                    disabled={safeToDeleteSize === 0}
                >
                    <Text style={styles.clearButtonText}>{t('cache.clearSafeCache')}</Text>
                </TouchableOpacity>
            </View>

            {loading ? (
                <ActivityIndicator size="large" color={theme.colors.primary} style={styles.loader} />
            ) : (
                <FlatList
                    data={files}
                    renderItem={renderItem}
                    keyExtractor={item => item.path}
                    contentContainerStyle={styles.listContent}
                    ListEmptyComponent={
                        <Text style={styles.emptyText}>{t('cache.empty')}</Text>
                    }
                />
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    header: {
        padding: theme.spacing.m,
        backgroundColor: theme.colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
    },
    statsCard: {
        alignItems: 'center',
        marginBottom: theme.spacing.m,
    },
    statsLabel: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginBottom: 4,
    },
    statsValue: {
        fontSize: 32,
        fontWeight: 'bold',
        color: theme.colors.text,
        marginBottom: 4,
    },
    statsSub: {
        fontSize: 12,
        color: theme.colors.success,
    },
    clearButton: {
        backgroundColor: theme.colors.primary,
        paddingVertical: 12,
        borderRadius: 8,
        alignItems: 'center',
    },
    clearButtonDisabled: {
        backgroundColor: theme.colors.border,
    },
    clearButtonText: {
        color: theme.colors.white,
        fontSize: 16,
        fontWeight: 'bold',
    },
    listContent: {
        padding: theme.spacing.m,
    },
    fileItem: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
        paddingVertical: 12,
        paddingLeft: theme.spacing.m,
        paddingRight: 4,
        borderRadius: 8,
        marginBottom: theme.spacing.s,
    },
    fileIcon: {
        marginRight: theme.spacing.m,
    },
    fileContent: {
        flex: 1,
        marginRight: 4,
    },
    fileTopRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 2,
    },
    fileName: {
        fontSize: 14,
        color: theme.colors.text,
        flex: 1,
        marginRight: 8,
    },
    fileSize: {
        fontSize: 10, // Reduced font size
        color: theme.colors.textSecondary,
    },
    filePath: {
        fontSize: 10, // Reduced font size
        color: theme.colors.textSecondary,
    },
    deleteButton: {
        padding: 8,
    },
    loader: {
        marginTop: theme.spacing.xl,
    },
    emptyText: {
        textAlign: 'center',
        marginTop: theme.spacing.xl,
        color: theme.colors.textSecondary,
    },
    settingRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 8,
        paddingHorizontal: theme.spacing.m,
        marginBottom: theme.spacing.m, // Add some margin below the setting
    },
    settingLabel: {
        fontSize: 16,
        color: theme.colors.text,
    },
});
