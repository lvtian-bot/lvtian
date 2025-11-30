import React, { useEffect, useState, useCallback } from 'react';
import NetInfo from "@react-native-community/netinfo";
import { View, Text, StyleSheet, ActivityIndicator, Alert, TouchableOpacity, ScrollView, DeviceEventEmitter, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRoute, useNavigation, RouteProp, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import Markdown, { RenderRules } from 'react-native-markdown-display';
import FastImage from 'react-native-fast-image';
import { RootStackParamList } from '../types/navigation';
import { fsService } from '../services/FileSystemService';
import { cloudService, UPLOAD_COMPLETED_EVENT } from '../services/CloudService';
import { useFileMetadataStore, LOCAL_MODIFIED_HASH } from '../store/useFileMetadataStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { theme } from '../utils/theme';
import { markdownThemes } from '../utils/markdownThemes';
import { normalizePath } from '../utils/pathUtils';

type PreviewScreenRouteProp = RouteProp<RootStackParamList, 'Preview'>;
type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

type SyncStatus = 'checking' | 'synced' | 'conflict' | 'error' | 'offline';

export const PreviewScreen = () => {
    const route = useRoute<PreviewScreenRouteProp>();
    const navigation = useNavigation<NavigationProp>();
    const { t } = useTranslation();
    const { filePath } = route.params;
    const { getMetadata, setMetadata, setUploadState } = useFileMetadataStore();
    const { markdownTheme } = useSettingsStore();
    const fileMetadata = useFileMetadataStore(state => state.metadata[filePath]);
    const insets = useSafeAreaInsets();

    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const [syncStatus, setSyncStatus] = useState<SyncStatus>('checking');

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

    const handleOverwriteLocal = async () => {
        try {
            setLoading(true);
            const result = await cloudService.downloadFile(filePath, filePath);
            setMetadata(filePath, result.etag, result.etag, result.lastModified);
            const newContent = await fsService.readFile(filePath);
            setContent(newContent);
            setSyncStatus('synced');
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
                setMetadata(filePath, result.etag, result.etag, result.lastModified);
            }
            checkSyncStatus();
        } catch (error: any) {
            console.error('Upload failed:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            setUploadState(filePath, 'failed');
            Alert.alert('Error', 'Failed to upload: ' + errorMessage);
            checkSyncStatus();
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
                        setMetadata(newPath, result.etag, result.etag, result.lastModified);
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

    const checkSyncStatus = useCallback(async () => {
        setSyncStatus('checking');
        try {
            const key = filePath;
            const localMetadata = getMetadata(filePath);

            // 1. Check Network Status (Priority)
            const netState = await NetInfo.fetch();
            if (netState.isConnected === false) {
                setSyncStatus('offline');
                return;
            }

            // 2. Check Upload State
            if (localMetadata?.uploadState === 'uploading') {
                setSyncStatus('checking');
                return;
            }

            // 3. Check Cloud Status
            const cloudMetadata = await cloudService.headFile(key);

            // A. Cloud file does not exist -> Auto Upload
            if (!cloudMetadata) {
                if (await fsService.exists(filePath)) {
                    console.log('Cloud file missing, auto-uploading...');
                    handleUploadOverwrite();
                }
                return;
            }

            // B. Hash Match (Synced)
            if (localMetadata?.localHash === cloudMetadata.etag) {
                // Self-healing: update syncedHash to match
                if (localMetadata?.syncedHash !== cloudMetadata.etag) {
                    setMetadata(filePath, cloudMetadata.etag, localMetadata.localHash, localMetadata.lastModified || new Date().toISOString());
                }
                setSyncStatus('synced');
                // Clear failed state if it was a false alarm
                if (localMetadata?.uploadState === 'failed' || localMetadata?.uploadState === 'conflict-failed') {
                    setUploadState(filePath, null);
                }
                return;
            }

            // C. Hash Mismatch (Conflict/Inconsistent)
            // C1. Only Cloud Updated (localHash == syncedHash) -> Auto Download
            if (localMetadata?.localHash === localMetadata?.syncedHash) {
                console.log('Cloud newer, auto-downloading...');
                handleOverwriteLocal();
                return;
            }

            // C2. Only Local Updated (cloud.etag == syncedHash) -> Auto Upload
            if (cloudMetadata.etag === localMetadata?.syncedHash) {
                console.log('Local newer, auto-uploading...');
                handleUploadOverwrite();
                return;
            }

            // C3. Bidirectional Conflict -> Show UI
            setSyncStatus('conflict');

        } catch (error) {
            console.error('Error checking sync status:', error);

            const localMetadata = getMetadata(filePath);
            if (localMetadata?.uploadState === 'failed' || localMetadata?.uploadState === 'conflict-failed') {
                setSyncStatus('conflict');
                return;
            }

            try {
                if (await fsService.exists(filePath)) {
                    setSyncStatus('offline');
                    return;
                }
            } catch (_) { }
            setSyncStatus('error');
        }
    }, [filePath, getMetadata, setUploadState, setMetadata]);

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

    useFocusEffect(
        useCallback(() => {
            loadFile();
            checkSyncStatus();
        }, [loadFile, checkSyncStatus])
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
                                <TouchableOpacity onPress={checkSyncStatus} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>{t('common.retry') || '重试连接'}</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    )}

                    {syncStatus === 'conflict' && (
                        <View style={styles.banner}>
                            <Text style={styles.bannerText}>
                                {(fileMetadata?.uploadState === 'failed' || fileMetadata?.uploadState === 'conflict-failed')
                                    ? '上传失败'
                                    : '本地和云端已同时修改'}
                            </Text>
                            <View style={styles.bannerButtons}>
                                {(fileMetadata?.uploadState === 'failed' || fileMetadata?.uploadState === 'conflict-failed') ? (
                                    <TouchableOpacity onPress={handleUploadOverwrite} style={styles.bannerButton}>
                                        <Text style={styles.bannerButtonText}>重试</Text>
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
