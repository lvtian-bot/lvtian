import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Alert, TouchableOpacity, ScrollView, DeviceEventEmitter } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, useNavigation, RouteProp, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import Markdown from 'react-native-markdown-display';
import { RootStackParamList } from '../types/navigation';
import { fsService } from '../services/FileSystemService';
import { cloudService, UPLOAD_COMPLETED_EVENT } from '../services/CloudService';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { theme } from '../utils/theme';
import { markdownThemes } from '../utils/markdownThemes';
import { normalizePath } from '../utils/pathUtils';

type PreviewScreenRouteProp = RouteProp<RootStackParamList, 'Preview'>;
type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

type SyncStatus = 'checking' | 'synced' | 'conflict' | 'error';
type ConflictType = 'localNewer' | 'cloudNewer' | null;

export const PreviewScreen = () => {
    const route = useRoute<PreviewScreenRouteProp>();
    const navigation = useNavigation<NavigationProp>();
    const { t } = useTranslation();
    const { filePath } = route.params;
    const { getMetadata, setMetadata } = useFileMetadataStore();

    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const [syncStatus, setSyncStatus] = useState<SyncStatus>('checking');
    const [conflictType, setConflictType] = useState<ConflictType>(null);
    const [uploadFailed, setUploadFailed] = useState(false);

    // 检查同步状态
    const checkSyncStatus = useCallback(async () => {
        setSyncStatus('checking');
        try {
            const key = filePath;
            const localMetadata = getMetadata(filePath);

            // 检查是否正在上传
            if (localMetadata?.etag === 'uploading') {
                setSyncStatus('checking');
                setConflictType(null);
                return;
            }

            // 如果没有配置云服务
            if (!cloudService.isConfigured()) {
                setSyncStatus('synced');
                setConflictType(null);
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
            setSyncStatus('error');
        }
    }, [filePath, getMetadata]);

    // 加载文件内容（不触发同步检查）
    const loadFile = useCallback(async () => {
        try {
            const exists = await fsService.exists(filePath);
            if (exists) {
                const fileContent = await fsService.readFile(filePath);
                setContent(fileContent);
            }
        } catch (error) {
            Alert.alert('Error', 'Failed to load file');
        } finally {
            setLoading(false);
        }
    }, [filePath]);

    // 监听上传完成事件
    useEffect(() => {
        const subscription = DeviceEventEmitter.addListener(UPLOAD_COMPLETED_EVENT, (data: { filePath: string; success?: boolean }) => {
            if (data.filePath === filePath) {
                if (data.success === false) {
                    // Upload failed, directly show conflict/local newer state
                    setUploadFailed(true);
                    setSyncStatus('conflict');
                    setConflictType('localNewer');
                } else {
                    // Upload success or unknown, re-check properly
                    setUploadFailed(false);
                    checkSyncStatus();
                }
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
            setUploadFailed(false); // 重新进入页面时清除上传失败标记
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
        } catch (error) {
            Alert.alert('Error', 'Failed to download cloud version');
        } finally {
            setLoading(false);
        }
    };

    const handleUploadOverwrite = async () => {
        try {
            setLoading(true);
            const result = await cloudService.uploadFile(filePath, filePath);
            if (result) {
                setMetadata(filePath, result.etag, result.lastModified);
            }
            checkSyncStatus();
        } catch (error) {
            Alert.alert('Error', 'Failed to upload');
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
                try {
                    const result = await cloudService.uploadFile(newPath, newPath);
                    if (result) {
                        setMetadata(newPath, result.etag, result.lastModified);
                    }
                } catch (error) {
                    console.error('Upload failed:', error);
                }
            }

            navigation.replace('Preview', { filePath: newPath });
        } catch (error) {
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
                    {syncStatus === 'conflict' && <Text style={styles.syncIcon}>⚠️</Text>}
                </View>
                <TouchableOpacity
                    onPress={() => navigation.navigate('Editor', { filePath })}
                    style={styles.headerButton}
                >
                    <Text style={styles.headerButtonText}>{t('common.edit')}</Text>
                </TouchableOpacity>
            </View>

            {syncStatus === 'conflict' && conflictType && (
                <View style={styles.banner}>
                    <Text style={styles.bannerText}>
                        {uploadFailed && '上传失败\n'}
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
                            <TouchableOpacity onPress={handleUploadOverwrite} style={styles.bannerButton}>
                                <Text style={styles.bannerButtonText}>上传到云端</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            )}

            <ScrollView style={styles.content}>
                <Markdown style={markdownThemes.default}>
                    {content || '# 空文件\n\n点击编辑按钮开始编写'}
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
        padding: 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        backgroundColor: theme.colors.surface,
    },
    headerButton: {
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    headerButtonText: {
        color: theme.colors.primary,
        fontSize: 16,
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
        padding: 16,
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
});
