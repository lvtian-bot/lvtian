import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Alert, TouchableOpacity, ScrollView, DeviceEventEmitter, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRoute, useNavigation, RouteProp, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import Markdown, { RenderRules } from 'react-native-markdown-display';
import { Image as ExpoImage } from 'expo-image';
import { RootStackParamList } from '../types/navigation';
import { fsService } from '../services/FileSystemService';
import { cloudService, UPLOAD_COMPLETED_EVENT } from '../services/CloudService';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { theme } from '../utils/theme';
import { markdownThemes } from '../utils/markdownThemes';
import { useCloudSync } from '../hooks/useCloudSync';
import { StatusBanner } from '../components/StatusBanner';

type PreviewScreenRouteProp = RouteProp<RootStackParamList, 'Preview'>;
type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

export const PreviewScreen = () => {
    const route = useRoute<PreviewScreenRouteProp>();
    const navigation = useNavigation<NavigationProp>();
    const { t } = useTranslation();
    const { filePath } = route.params;
    // Removed unused getMetadata
    const { markdownTheme } = useSettingsStore();
    const fileMetadata = useFileMetadataStore(state => state.metadata[filePath]);
    const insets = useSafeAreaInsets();

    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);

    // Use the new hook
    const { syncStatus, conflictType, isSyncing, checkSync, performAutoSync, resolveConflict } = useCloudSync(filePath);

    // Helper to determine if we should show the conflict banner (only for bidirectional or failure)
    const shouldShowConflictBanner = syncStatus === 'conflict' && (
        conflictType === 'bidirectional' ||
        !conflictType || // Fallback
        fileMetadata?.uploadState === 'failed' ||
        fileMetadata?.uploadState === 'conflict-failed'
    );

    // Helper to determine effective sync state for icon
    const isEffectivelySyncing = isSyncing ||
        syncStatus === 'checking' ||
        (syncStatus === 'conflict' && (conflictType === 'cloudNewer' || conflictType === 'localNewer'));

    const loadFile = useCallback(async () => {
        try {
            const exists = await fsService.exists(filePath);
            if (exists) {
                const fileContent = await fsService.readFile(filePath);
                setContent(fileContent);
            }
        } catch (_) {
            Alert.alert('Error', 'Failed to load file');
        } finally {
            setLoading(false);
        }
    }, [filePath]);

    const handleOverwriteLocal = async () => {
        await resolveConflict('useCloud');
        await loadFile();
    };

    const handleUploadOverwrite = async () => {
        await resolveConflict('useLocal');
    };

    const handleSaveCopy = async () => {
        try {
            await resolveConflict('saveCopy');
            // The file content is reloaded via loadFile, but the path hasn't changed.
            // However, resolveConflict('saveCopy') renames the OLD file to backup and DOWNLOADS the new one to filePath.
            // So we are still viewing the same filePath, but content is now cloud content.
            // The backup is somewhere else. 
            // The original logic navigated to newPath, but that was because it moved current file to backup
            // and seemingly expected user to view the backup? 
            // Wait, original logic: moveFile(current, backup) -> upload(backup) -> navigate(backup).
            // This means user continues viewing the LOCAL version (which is now backup).

            // SyncService logic: moveFile(current, backup) -> upload(backup) -> download(cloud, current).
            // This means 'current' (filePath) now has Cloud content. 'backup' has Local content.

            // If we want to mimic original behavior strictly (keep viewing local content), we should navigate to backup.
            // BUT, usually 'Resolve Conflict -> Save Copy' means "I want to keep my changes safe, but accept cloud version as main".
            // So staying on filePath (which is now Cloud version) seems more correct for a "Sync" resolution.
            // And the backup is safe.

            // Let's stick to SyncService logic: View the now-synced file.
            await loadFile();
            Alert.alert(t('common.success'), 'Local changes saved to copy. Now viewing cloud version.');
        } catch (_) {
            Alert.alert('Error', 'Failed to save copy');
        }
    };

    // Listen for upload completion to reload content if needed (e.g. if we just downloaded)
    useEffect(() => {
        const subscription = DeviceEventEmitter.addListener(UPLOAD_COMPLETED_EVENT, (data: { filePath: string; success?: boolean }) => {
            if (data.filePath === filePath && data.success) {
                loadFile();
            }
        });
        return () => subscription.remove();
    }, [filePath, loadFile]);

    useFocusEffect(
        useCallback(() => {
            loadFile();
            performAutoSync();
        }, [loadFile, performAutoSync])
    );

    const rules = useMemo<RenderRules>(() => ({
        image: (node, children, parent, styles) => {
            const { src, alt } = node.attributes;

            // Check if it's a web URL
            if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
                return (
                    <AutoImage
                        key={node.key}
                        source={{ uri: src }}
                        style={styles.image}
                        accessibilityLabel={alt}
                    />
                );
            }

            // Otherwise, treat as local/repo file
            return (
                <RepoImage
                    key={node.key}
                    src={src}
                    alt={alt}
                    style={styles.image}
                    currentFilePath={filePath}
                />
            );
        },
    }), [filePath]);

    return (
        <View style={[styles.container, { paddingBottom: insets.bottom }]}>
            <View style={[styles.header, { paddingTop: insets.top + theme.spacing.s }]}>
                <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerButton}>
                    <Text style={styles.headerButtonText}>{t('common.back')}</Text>
                </TouchableOpacity>
                <View style={styles.titleContainer}>
                    <Text style={styles.title} numberOfLines={2}>
                        {filePath.split('/').pop()}
                    </Text>
                    {isEffectivelySyncing && <ActivityIndicator size="small" color={theme.colors.primary} />}
                    {!isEffectivelySyncing && syncStatus === 'synced' && <Text style={styles.syncIcon}>✅</Text>}
                    {!isEffectivelySyncing && (syncStatus === 'conflict' || syncStatus === 'offline') && <Text style={styles.syncIcon}>⚠️</Text>}
                    {!isEffectivelySyncing && syncStatus === 'error' && <Text style={styles.syncIcon}>❌</Text>}
                </View>
                <TouchableOpacity
                    onPress={() => navigation.navigate('Editor', { filePath })}
                    style={styles.headerButton}
                >
                    <Text style={styles.headerButtonText}>{t('common.edit')}</Text>
                </TouchableOpacity>
            </View>

            {loading ? (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={theme.colors.primary} />
                </View>
            ) : (
                <>
                    {syncStatus === 'offline' && (
                        <StatusBanner
                            visible={true}
                            message={`${t('preview.offlineMode') || '离线模式：当前显示本地版本，可能不是最新'}${(fileMetadata?.uploadState === 'failed' || fileMetadata?.uploadState === 'conflict-failed')
                                ? ' (上次上传失败)'
                                : ''
                                }`}
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
                                { label: '使用云端版本覆盖本地', onPress: handleOverwriteLocal },
                                { label: '保存本地为副本', onPress: handleSaveCopy },
                                { label: '上传本地覆盖云端', onPress: handleUploadOverwrite }
                            ]}
                        />
                    )}

                    <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
                        <Markdown
                            style={markdownThemes[markdownTheme] || markdownThemes.default}
                            rules={rules}
                        >
                            {(() => {
                                if (!content) return '# 空文件\n\n点击编辑按钮开始编写';
                                const frontMatterRegex = /^(?:---\s*[\r\n]+)([\s\S]*?)(?:[\r\n]+---\s*[\r\n]+|$)/;
                                const match = content.match(frontMatterRegex);

                                if (match) {
                                    const metadataContent = match[1].trim();
                                    const afterFrontMatterContent = content.substring(match[0].length);
                                    const processedMetadata = `\`\`\`yaml\n${metadataContent}\n\`\`\`\n`;
                                    return processedMetadata + afterFrontMatterContent;
                                }

                                return content;
                            })()}
                        </Markdown>
                    </ScrollView>
                </>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.white,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: theme.colors.white,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: theme.spacing.s,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        backgroundColor: theme.colors.surface,
    },
    headerButton: {
        padding: theme.spacing.s,
    },
    headerButtonText: {
        color: theme.colors.primary,
        fontSize: 16,
        fontWeight: 'bold',
    },
    titleContainer: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    title: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text,
        textAlign: 'center',
    },
    syncIcon: {
        fontSize: 16,
    },
    content: {
        flex: 1,
    },

    contentContainer: {
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: theme.spacing.l,
    },
    image: {
        width: '100%',
        height: 200,
        resizeMode: 'contain',
        marginVertical: theme.spacing.s,
    },
});

const AutoImage = ({ source, style, accessibilityLabel }: any) => {
    const [ratio, setRatio] = useState<number | undefined>(undefined);

    useEffect(() => {
        if (source?.uri) {
            Image.getSize(source.uri, (width, height) => {
                if (width > 0 && height > 0) {
                    setRatio(width / height);
                }
            }, () => { });
        }
    }, [source?.uri]);

    return (
        <ExpoImage
            source={source}
            style={[
                style,
                { width: '100%' },
                ratio ? { aspectRatio: ratio } : { height: 200 }
            ]}
            contentFit="contain"
            accessibilityLabel={accessibilityLabel}
        />
    );
};

const RepoImage = ({ src, alt, style, currentFilePath }: { src: string, alt?: string, style: any, currentFilePath: string }) => {
    const { t } = useTranslation();
    const [localUri, setLocalUri] = useState<string | null>(null);
    const [loadingImage, setLoadingImage] = useState(true);
    const [error, setError] = useState(false);

    useEffect(() => {
        let mounted = true;

        const checkAndDownload = async () => {
            try {
                setLoadingImage(true);
                setError(false);

                // 1. Resolve absolute path
                let absolutePath = '';
                if (src.startsWith('/') || src.startsWith('file://')) {
                    absolutePath = src;
                } else {
                    const currentDir = currentFilePath.substring(0, currentFilePath.lastIndexOf('/'));
                    const parts = (currentDir + '/' + src).split('/');
                    const stack: string[] = [];
                    for (const part of parts) {
                        if (part === '..') {
                            stack.pop();
                        } else if (part !== '.' && part !== '') {
                            stack.push(part);
                        }
                    }
                    absolutePath = (parts[0] === '' ? '/' : '') + stack.join('/');
                    if (!absolutePath.startsWith('file://') && absolutePath.startsWith('/')) {
                        absolutePath = 'file://' + absolutePath;
                    }
                }

                // 2. Check existence
                const exists = await fsService.exists(absolutePath);

                if (exists) {
                    if (mounted) {
                        setLocalUri(absolutePath);
                        setLoadingImage(false);
                    }
                    return;
                }

                // 3. If missing, try download
                const rootPath = fsService.getRootPath();
                const normalizedRoot = rootPath.replace('file://', '');
                const normalizedAbs = absolutePath.replace('file://', '');

                if (normalizedAbs.startsWith(normalizedRoot)) {
                    const key = normalizedAbs.substring(normalizedRoot.length + 1);
                    if (cloudService.isConfigured()) {
                        try {
                            await cloudService.downloadFile(key, absolutePath);
                            if (mounted) {
                                setLocalUri(absolutePath);
                                setLoadingImage(false);
                            }
                        } catch (e) {
                            console.warn('Failed to download image:', key, e);
                            interface ErrorWithCode { code?: string }
                            if ((e as ErrorWithCode)?.code === 'NoSuchKey' || (e as any)?.statusCode === 404) {
                                if (mounted) setError(true);
                            }
                            if (mounted) setLoadingImage(false);
                        }
                    } else {
                        if (mounted) setLoadingImage(false);
                    }
                } else {
                    if (mounted) setLoadingImage(false);
                }

            } catch (e) {
                console.error('Image resolution error', e);
                if (mounted) {
                    setError(true);
                    setLoadingImage(false);
                }
            }
        };

        checkAndDownload();

        return () => { mounted = false; };
    }, [src, currentFilePath]);

    if (loadingImage) {
        return (
            <View style={[styles.image, { justifyContent: 'center', alignItems: 'center', backgroundColor: theme.colors.surface }]}>
                <ActivityIndicator size="small" color={theme.colors.primary} />
            </View>
        );
    }

    if (error || !localUri) {
        return (
            <View style={[styles.image, { justifyContent: 'center', alignItems: 'center', backgroundColor: '#f0f0f0' }]}>
                <Text style={{ color: '#999', fontSize: 12 }}>{t('common.error')}: {alt || 'Image not found'}</Text>
            </View>
        );
    }

    return (
        <AutoImage
            source={{ uri: localUri }}
            style={style}
            accessibilityLabel={alt}
        />
    );
};
