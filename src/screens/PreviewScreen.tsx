import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Alert, TouchableOpacity, ScrollView, DeviceEventEmitter, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRoute, useNavigation, RouteProp, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import Markdown, { RenderRules } from 'react-native-markdown-display';
import FastImage from 'react-native-fast-image';
import { RootStackParamList } from '../types/navigation';
import { fsService } from '../services/FileSystemService';
import { UPLOAD_COMPLETED_EVENT } from '../services/CloudService';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { theme } from '../utils/theme';
import { markdownThemes } from '../utils/markdownThemes';
import { useCloudSync } from '../hooks/useCloudSync';

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
            <FastImage
                source={source}
                style={[
                    style,
                    { width: '100%' },
                    ratio ? { aspectRatio: ratio } : { height: 200 }
                ]}
                resizeMode={FastImage.resizeMode.contain}
                accessibilityLabel={accessibilityLabel}
            />
        );
    };

    const rules: RenderRules = {
        image: (node, children, parent, styles) => {
            const { src, alt } = node.attributes;
            return (
                <AutoImage
                    key={node.key}
                    source={{ uri: src }}
                    style={styles.image}
                    accessibilityLabel={alt}
                />
            );
        },
    };

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
                        <View style={styles.banner}>
                            <Text style={styles.bannerText}>
                                {t('preview.offlineMode') || '离线模式：当前显示本地版本，可能不是最新'}
                                {(fileMetadata?.uploadState === 'failed' || fileMetadata?.uploadState === 'conflict-failed') ? ' (上次上传失败)' : ''}
                            </Text>
                            <View style={styles.bannerButtons}>
                                <TouchableOpacity onPress={checkSync} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>{t('common.retry') || '重试连接'}</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    )}

                    {shouldShowConflictBanner && (
                        <View style={styles.banner}>
                            <Text style={styles.bannerText}>
                                {fileMetadata?.uploadState === 'failed'
                                    ? '上传失败'
                                    : '本地和云端已同时修改 (冲突)'
                                }
                            </Text>
                            <View style={styles.bannerButtons}>
                                {(fileMetadata?.uploadState === 'failed') ? (
                                    <TouchableOpacity onPress={handleUploadOverwrite} style={styles.bannerButton}>
                                        <Text style={styles.bannerButtonText}>上传本地覆盖云端</Text>
                                    </TouchableOpacity>
                                ) : (
                                    <>
                                        <TouchableOpacity onPress={handleOverwriteLocal} style={styles.bannerButton}>
                                            <Text style={styles.bannerButtonText}>使用云端版本覆盖本地</Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity onPress={handleSaveCopy} style={styles.bannerButton}>
                                            <Text style={styles.bannerButtonText}>保存本地为副本</Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity onPress={handleUploadOverwrite} style={styles.bannerButton}>
                                            <Text style={styles.bannerButtonText}>上传本地覆盖云端</Text>
                                        </TouchableOpacity>
                                    </>
                                )}
                            </View>
                        </View>
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
    banner: {
        backgroundColor: '#fff3cd',
        padding: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#ffc107',
    },
    bannerText: {
        color: '#856404',
        marginBottom: 8,
    },
    bannerButtons: {
        flexDirection: 'row',
        gap: 8,
        flexWrap: 'wrap',
    },
    bannerButton: {
        backgroundColor: theme.colors.primary,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 4,
        marginBottom: 4,
    },
    bannerButtonText: {
        color: 'white',
        fontSize: 14,
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
