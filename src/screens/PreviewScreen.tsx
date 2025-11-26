import React, { useEffect, useState, useCallback } from 'react';
import NetInfo from "@react-native-community/netinfo";
import { View, Text, StyleSheet, ActivityIndicator, Alert, TouchableOpacity, ScrollView, DeviceEventEmitter, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, useNavigation, RouteProp, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import Markdown, { RenderRules } from 'react-native-markdown-display';
import FastImage from 'react-native-fast-image'; // 引入 FastImage
import { RootStackParamList } from '../types/navigation';
import { fsService } from '../services/FileSystemService';
import { cloudService, UPLOAD_COMPLETED_EVENT } from '../services/CloudService';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { theme } from '../utils/theme';
import { markdownThemes } from '../utils/markdownThemes';
import { normalizePath } from '../utils/pathUtils';

type PreviewScreenRouteProp = RouteProp<RootStackParamList, 'Preview'>;
type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

type SyncStatus = 'checking' | 'synced' | 'conflict' | 'error' | 'offline';
type ConflictType = 'localNewer' | 'cloudNewer' | null;

export const PreviewScreen = () => {
    const route = useRoute<PreviewScreenRouteProp>();
    const navigation = useNavigation<NavigationProp>();
    const { t } = useTranslation();
    const { filePath } = route.params;
    const { getMetadata, setMetadata, setUploadState } = useFileMetadataStore();
    const markdownTheme = useSettingsStore(state => state.markdownTheme);
    // Subscribe to metadata changes for this file to trigger re-renders
    const fileMetadata = useFileMetadataStore(state => state.metadata[filePath]);

    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const [syncStatus, setSyncStatus] = useState<SyncStatus>('checking');
    const [conflictType, setConflictType] = useState<ConflictType>(null);

    // 自定义 AutoImage 组件，使用 FastImage 优化性能
    const AutoImage = ({ source, style, accessibilityLabel }: any) => {
        const [ratio, setRatio] = useState<number | undefined>(undefined);

        useEffect(() => {
            if (source?.uri) {
                Image.getSize(source.uri, (width, height) => {
                    if (width > 0 && height > 0) {
                        setRatio(width / height);
                    }
                }, () => {});
            }
        }, [source?.uri]);

        return (
            <FastImage
                source={source}
                style={[
                    style,
                    { width: '100%' },
                    ratio ? { aspectRatio: ratio } : { height: 200 } // 加载前占位，加载后自适应
                ]}
                resizeMode={FastImage.resizeMode.contain}
                accessibilityLabel={accessibilityLabel}
            />
        );
    };

    // 自定义渲染规则，修复图片 key 展开警告导致的长文卡顿
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

    // 检查同步状态
    const checkSyncStatus = useCallback(async () => {
        setSyncStatus('checking');
        try {
            const key = filePath;
            const localMetadata = getMetadata(filePath);

            // 检查持久化的上传状态
            if (localMetadata?.uploadState === 'uploading') {
                // 正在上传中，保持 checking 或显示上传中
                setSyncStatus('checking');
                setConflictType(null);
                return;
            }




            // ...
            // 0. 检查网络状态
            const netState = await NetInfo.fetch();
            if (netState.isConnected === false) {
                // 离线状态
                // 优先检查是否有上传失败记录
                if (localMetadata?.uploadState === 'failed' || localMetadata?.uploadState === 'conflict-failed') {
                    setSyncStatus('conflict');
                    setConflictType('localNewer');
                } else {
                    setSyncStatus('offline');
                    setConflictType(null);
                }
                return;
            }

            const cloudMetadata = await cloudService.headFile(key);

            if (!cloudMetadata) {
                // 云端没有文件
                if (await fsService.exists(filePath)) {
                    setSyncStatus('conflict');
                    setConflictType('localNewer');
                }
                return;
            }

            if (localMetadata?.etag === cloudMetadata.etag) {
                setSyncStatus('synced');
                setConflictType(null);
                // 如果之前标记为失败但现在ETag一致，说明实际上同步了（可能是误报），清除失败状态
                if (localMetadata?.uploadState === 'failed' || localMetadata?.uploadState === 'conflict-failed') {
                    setUploadState(filePath, null);
                }
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

            // If upload failed previously, show conflict state so user sees the error
            const localMetadata = getMetadata(filePath);
            if (localMetadata?.uploadState === 'failed' || localMetadata?.uploadState === 'conflict-failed') {
                setSyncStatus('conflict');
                setConflictType('localNewer');
                return;
            }

            // Check if local file exists to show offline mode
            try {
                if (await fsService.exists(filePath)) {
                    setSyncStatus('offline');
                    setConflictType(null);
                    return;
                }
            } catch (_) { }
            setSyncStatus('error');
        }
    }, [filePath, getMetadata, setUploadState]);

    // 加载文件内容（不触发同步检查）
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

    // 监听上传完成事件 - 仅用于触发刷新，不再维护状态
    useEffect(() => {
        const subscription = DeviceEventEmitter.addListener(UPLOAD_COMPLETED_EVENT, (data: { filePath: string; success?: boolean }) => {
            if (data.filePath === filePath) {
                checkSyncStatus();
            }
        });

        return () => {
            subscription.remove();
        };
    }, [filePath, checkSyncStatus]);

    // 每次页面获得焦点时重新加载文件并检查同步状态
    useFocusEffect(
        useCallback(() => {
            loadFile();
            checkSyncStatus();
        }, [loadFile, checkSyncStatus])
    );

    // 冲突处理逻辑
    const handleOverwriteLocal = async () => {
        try {
            setLoading(true);
            const result = await cloudService.downloadFile(filePath, filePath);
            setMetadata(filePath, result.etag, result.lastModified);
            const newContent = await fsService.readFile(filePath);
            setContent(newContent);
            setSyncStatus('synced');
            setConflictType(null);
        } catch (_) {
            Alert.alert('Error', 'Failed to download cloud version');
        } finally {
            setLoading(false);
        }
    };

    const handleUploadOverwrite = async () => {
        try {
            setLoading(true);
            setUploadState(filePath, 'uploading');
            const result = await cloudService.uploadFile(filePath, filePath);
            if (result) {
                setMetadata(filePath, result.etag, result.lastModified);
            }
            checkSyncStatus();
        } catch (error: any) {
            console.error('Upload failed:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            setUploadState(filePath, 'failed');
            Alert.alert('Error', 'Failed to upload: ' + errorMessage);
            checkSyncStatus(); // Re-check to update UI with failed state
        } finally {
            setLoading(false);
        }
    };

    const handleSaveCopy = async () => {
        try {
            setLoading(true);
            const normalizedPath = normalizePath(filePath);
            const fileName = normalizedPath.split('/').pop() || '';
            const dir = normalizedPath.replace(fileName, '');
            const timestamp = new Date().getTime();
            const newName = `${fileName.replace('.md', '')}_old_${timestamp}.md`;
            const newPath = normalizePath(`${dir}${newName}`);

            await fsService.moveFile(normalizedPath, newPath);

            if (cloudService.isConfigured()) {
                setUploadState(newPath, 'uploading');
                try {
                    const result = await cloudService.uploadFile(newPath, newPath);
                    if (result) {
                        setMetadata(newPath, result.etag, result.lastModified);
                    }
                } catch (error: any) {
                    console.error('Upload failed:', error);

                    setUploadState(newPath, 'failed');
                }
            }

            navigation.replace('Preview', { filePath: newPath });
        } catch (_) {
            Alert.alert('Error', 'Failed to save copy');
        } finally {
            setLoading(false);
        }
    };

    if (loading) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={theme.colors.primary} />
            </View>
        );
    }

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerButton}>
                    <Text style={styles.headerButtonText}>{t('common.back')}</Text>
                </TouchableOpacity>
                <View style={styles.titleContainer}>
                    <Text style={styles.title} numberOfLines={2}>
                        {filePath.split('/').pop()}
                    </Text>
                    {syncStatus === 'checking' && <ActivityIndicator size="small" color={theme.colors.primary} />}
                    {syncStatus === 'synced' && <Text style={styles.syncIcon}>✅</Text>}
                    {(syncStatus === 'conflict' || syncStatus === 'offline') && <Text style={styles.syncIcon}>⚠️</Text>}
                </View>
                <TouchableOpacity
                    onPress={() => navigation.navigate('Editor', { filePath })}
                    style={styles.headerButton}
                >
                    <Text style={styles.headerButtonText}>{t('common.edit')}</Text>
                </TouchableOpacity>
            </View>

            {syncStatus === 'offline' && (
                <View style={styles.banner}>
                    <Text style={styles.bannerText}>
                        {t('preview.offlineMode') || '离线模式：当前显示本地版本，可能不是最新'}
                    </Text>
                    <View style={styles.bannerButtons}>
                        <TouchableOpacity onPress={checkSyncStatus} style={styles.bannerButton}>
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

            <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
                <Markdown
                    style={markdownThemes[markdownTheme] || markdownThemes.default}
                    rules={rules}
                >
                    {(() => {
    if (!content) return '# 空文件\n\n点击编辑按钮开始编写';
    // 尝试匹配文件开头的 YAML Front Matter
    const frontMatterRegex = /^(?:---\s*[\r\n]+)([\s\S]*?)(?:[\r\n]+---\s*[\r\n]+|$)/;
    const match = content.match(frontMatterRegex);

    if (match) {
        const metadataContent = match[1].trim(); // 获取 --- 之间的内容，并去除首尾空白
        const afterFrontMatterContent = content.substring(match[0].length); // 获取 Front Matter 之后的所有内容

        // 将元数据内容包裹在 ```yaml 代码块中
        const processedMetadata = `\`\`\`yaml\n${metadataContent}\n\`\`\`\n`;
        return processedMetadata + afterFrontMatterContent;
    }

    return content;
})()}
                </Markdown>
            </ScrollView>
        </SafeAreaView>
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
    },
    bannerButton: {
        backgroundColor: theme.colors.primary,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 4,
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
});

