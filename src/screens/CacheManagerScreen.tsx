import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
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
    // const [totalSize, setTotalSize] = useState(0);
    const [safeToDeleteSize, setSafeToDeleteSize] = useState(0);

    const { getMetadata, removeMetadata } = useFileMetadataStore();

    const loadFiles = useCallback(async () => {
        setLoading(true);
        try {
            const getRelativePath = (fullPath: string) => {
                const rootPath = fsService.getRootPath();

                const decodedFull = decodeURIComponent(fullPath);
                const decodedRoot = decodeURIComponent(rootPath);

                const cleanFull = decodedFull.replace(/^file:\/+/g, '/');
                const cleanRoot = decodedRoot.replace(/^file:\/+/g, '/');
                let relative = '';
                if (cleanFull.startsWith(cleanRoot)) {
                    relative = cleanFull.substring(cleanRoot.length);
                } else {
                    const rawFullClean = fullPath.replace(/^file:\/+/g, '/');
                    const rawRootClean = rootPath.replace(/^file:\/+/g, '/');
                    if (rawFullClean.startsWith(rawRootClean)) {
                        relative = rawFullClean.substring(rawRootClean.length);
                        relative = decodeURIComponent(relative);
                    } else {
                        return fullPath;
                    }
                }

                return relative.replace(/^\/+/, '');
            };

            // Use recursive list from SyncService enhancement
            const allFiles = await fsService.listFilesRecursive('');

            const processedFiles: CacheFileItem[] = allFiles.map(file => {
                const relativePath = getRelativePath(file.path);

                const metadata = getMetadata(relativePath);
                const isModified = metadata?.localHash === LOCAL_MODIFIED_HASH;
                const isUploading = metadata?.uploadState === 'uploading';
                const isFailed = metadata?.uploadState === 'failed';

                let status: CacheFileItem['status'] = 'synced';
                if (isModified) status = 'modified';
                else if (isUploading) status = 'uploading';
                else if (isFailed) status = 'failed';

                const isSafeToDelete = !isModified && !isUploading && !isFailed;

                return {
                    ...file,
                    isSafeToDelete,
                    status,
                    relativePath
                };
            });

            processedFiles.sort((a, b) => {
                if (a.isSafeToDelete !== b.isSafeToDelete) return a.isSafeToDelete ? 1 : -1;
                return b.size - a.size;
            });

            setFiles(processedFiles);

            // const total = processedFiles.reduce((acc, file) => acc + file.size, 0);
            const safe = processedFiles.filter(f => f.isSafeToDelete).reduce((acc, file) => acc + file.size, 0);
            // setTotalSize(total);
            setSafeToDeleteSize(safe);

        } catch (error) {
            console.error('Failed to load cache files:', error);
            Alert.alert(t('common.error'), t('cache.loadFailed'));
        } finally {
            setLoading(false);
        }
    }, [t, getMetadata]);

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

    const performDelete = async (file: CacheFileItem) => {
        try {
            console.log(`[CacheManager] Deleting file: ${file.relativePath}`);
            await fsService.deleteFile(file.relativePath);

            // Robust metadata clearing
            const rawPath = file.relativePath;
            const decodedPath = decodeURIComponent(rawPath);

            console.log(`[CacheManager] Removing metadata for keys: '${rawPath}', '${decodedPath}'`);

            removeMetadata(rawPath);
            if (rawPath !== decodedPath) removeMetadata(decodedPath);

            // Verify deletion
            const check = getMetadata(rawPath);
            console.log(`[CacheManager] Metadata verification after delete:`, check ? 'Still exists' : 'Removed');

            loadFiles();
        } catch (error) {
            console.error('Failed to delete file:', error);
            Alert.alert(t('common.error'), t('cache.deleteFailed'));
        }
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
                            const { syncService } = require('../services/SyncService');
                            await syncService.clearCache({ includeUnsynced: false });

                            Alert.alert(t('common.success'), t('cache.clearSuccess'));
                            loadFiles();
                        } catch (error) {
                            console.error('Failed to clear cache:', error);
                            Alert.alert(t('common.error'), t('cache.clearFailed'));
                        } finally {
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
                <View style={styles.topRow}>
                    <View style={styles.statsInfo}>
                        <Text style={styles.statsLabel}>{t('cache.safeToClear')}</Text>
                        <Text style={styles.statsValue}>{formatSize(safeToDeleteSize)}</Text>
                    </View>

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
    // header style matching fileItem
    header: {
        marginHorizontal: theme.spacing.sm, // Align with list content padding
        marginTop: theme.spacing.sm,
        marginBottom: theme.spacing.s, // Align with fileItem margin
        padding: theme.spacing.m,
        backgroundColor: theme.colors.surface,
        borderRadius: 8, // Match fileItem radius
    },
    topRow: {
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: theme.spacing.m,
    },
    statsInfo: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'center',
    },
    statsLabel: {
        fontSize: 16, // SLIGHTLY LARGER
        color: theme.colors.textSecondary,
    },
    statsValue: {
        fontSize: 32, // LARGER
        fontWeight: 'bold',
        color: theme.colors.primary,
        marginLeft: 8,
    },
    // Removed statsSub, settingRow, settingLabel as they are unused/removed
    clearButton: {
        backgroundColor: theme.colors.primary,
        paddingVertical: 12, // Taller button
        borderRadius: 8,
        alignItems: 'center',
        width: '100%', // Full width inside card
    },
    clearButtonDisabled: {
        backgroundColor: theme.colors.border,
    },
    clearButtonText: {
        color: theme.colors.white,
        fontSize: 16,
        fontWeight: '600',
    },
    listContent: {
        paddingHorizontal: theme.spacing.sm, // m -> sm (8)
        paddingVertical: theme.spacing.m,
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
        fontSize: 10,
        color: theme.colors.textSecondary,
    },
    filePath: {
        fontSize: 10,
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
});