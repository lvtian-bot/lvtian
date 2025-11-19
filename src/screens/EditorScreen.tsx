import React, { useEffect, useState, useRef } from 'react';
import { View, StyleSheet, ActivityIndicator, Alert, TouchableOpacity, Text, Platform, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, useNavigation, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import Markdown from 'react-native-markdown-display';
import { WebView } from 'react-native-webview';
import { RootStackParamList } from '../types/navigation';
import { fsService } from '../services/FileSystemService';
import { cloudService } from '../services/CloudService';
import { syncService } from '../services/SyncService';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { theme } from '../utils/theme';
import { markdownThemes } from '../utils/markdownThemes';

type EditorScreenRouteProp = RouteProp<RootStackParamList, 'Editor'>;

type SyncStatus = 'synced' | 'conflict' | 'checking' | 'error';
type ConflictType = 'cloudNewer' | 'localNewer' | null;

export const EditorScreen = () => {
    const route = useRoute<EditorScreenRouteProp>();
    const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
    const { t } = useTranslation();
    const { markdownTheme } = useSettingsStore();
    const { filePath, isNew } = route.params;
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const [isEditing, setIsEditing] = useState(isNew || false);
    const [syncStatus, setSyncStatus] = useState<SyncStatus>('checking');
    const [conflictType, setConflictType] = useState<ConflictType>(null);
    const webViewRef = useRef<WebView>(null);

    const { getMetadata, invalidateMetadata, setMetadata } = useFileMetadataStore();

    useEffect(() => {
        loadFile();
    }, [filePath]);

    const loadFile = async () => {
        try {
            const exists = await fsService.exists(filePath);
            if (exists) {
                const fileContent = await fsService.readFile(filePath);
                setContent(fileContent);
                checkSyncStatus();
            } else {
                setContent('');
                setSyncStatus('error');
            }
        } catch (error) {
            console.log('Error loading file:', error);
            setContent('');
        } finally {
            setLoading(false);
        }
    };

    const checkSyncStatus = async () => {
        setSyncStatus('checking');
        try {
            const key = filePath; // Assuming key is filePath for now
            const localMetadata = getMetadata(filePath);
            const cloudMetadata = await cloudService.headFile(key);

            // Check if file is currently uploading (temporary state after "Save As")
            if (localMetadata?.etag === 'uploading') {
                setSyncStatus('synced'); // Show as synced while uploading
                setConflictType(null);
                return;
            }

            if (!cloudMetadata) {
                // File might not exist in cloud yet
                setSyncStatus('error'); // Or 'localNewer' if we assume it's a new file?
                // For now, if cloud doesn't have it, it's effectively local newer if we have content
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
    };

    const handleAutoSave = async (newContent: string) => {
        try {
            // 自动保存：只写本地，不触发云同步，不退出编辑模式
            await fsService.writeFile(filePath, newContent);
            setContent(newContent);
            // 不调用 syncService.syncFile
            // 不调用 setIsEditing(false)
        } catch (error) {
            console.error('Auto save failed:', error);
            // 自动保存失败不打扰用户
        }
    };

    const handleManualSave = async (newContent: string) => {
        try {
            // 手动保存：写本地 + 触发云同步 + 退出编辑模式
            await fsService.writeFile(filePath, newContent);
            setContent(newContent);
            setIsEditing(false);
            invalidateMetadata(filePath); // Invalidate metadata on local edit

            // Trigger upload to cloud (Copy on Write pattern: Save -> Local -> Queue -> Upload)
            syncService.syncFile(filePath);

            checkSyncStatus(); // Re-check status (should become localNewer initially, then synced after upload)
        } catch (error) {
            Alert.alert('Error', 'Failed to save file');
        }
    };

    const onWebViewMessage = (event: any) => {
        try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data.type === 'autoSave') {
                handleAutoSave(data.content);
            } else if (data.type === 'manualSave') {
                handleManualSave(data.content);
            }
        } catch {
            // 兼容旧格式（纯字符串），当做手动保存处理
            handleManualSave(event.nativeEvent.data);
        }
    };

    const requestSaveFromWebView = () => {
        webViewRef.current?.injectJavaScript('window.getContent(); true;');
    };

    const handleOverwriteLocal = async () => {
        try {
            setLoading(true);
            const key = filePath;
            const result = await cloudService.downloadFile(key, filePath);
            setMetadata(filePath, result.etag, result.lastModified);
            await loadFile(); // Reload content
        } catch (error) {
            Alert.alert('Error', 'Failed to overwrite local file');
        } finally {
            setLoading(false);
        }
    };

    const handleSaveCopy = async () => {
        try {
            setLoading(true);
            // Rename local file and upload as copy (like "Save As" in Office apps)
            const newPath = await syncService.resolveConflict(filePath);

            // Navigate to the renamed file (user continues editing the renamed version)
            // Cloud version is NOT downloaded - user can open it manually from file list
            navigation.replace('Editor', { filePath: newPath });
        } catch (error) {
            Alert.alert('Error', 'Failed to save copy');
        } finally {
            setLoading(false);
        }
    };

    const handleUploadOverwrite = async () => {
        try {
            setLoading(true);
            await syncService.syncFile(filePath);
            // We need to wait for upload to finish to update metadata?
            // syncFile adds to queue. processQueue updates metadata.
            // We might need to poll or wait.
            // For now, let's just set status to checking and let the queue handle it.
            // Ideally we'd have a way to know when it's done.
            setTimeout(() => checkSyncStatus(), 2000); // Simple timeout for now
        } catch (error) {
            Alert.alert('Error', 'Failed to upload');
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
                    {syncStatus === 'synced' && <Text style={styles.syncIcon}>✅</Text>}
                    {syncStatus === 'conflict' && <Text style={styles.syncIcon}>⚠️</Text>}
                </View>
                <TouchableOpacity
                    onPress={() => {
                        if (isEditing) {
                            requestSaveFromWebView();
                        } else {
                            setIsEditing(true);
                        }
                    }}
                    style={styles.headerButton}
                >
                    <Text style={styles.headerButtonText}>{isEditing ? t('common.save') : t('common.edit')}</Text>
                </TouchableOpacity>
            </View>

            {syncStatus === 'conflict' && conflictType && (
                <View style={styles.banner}>
                    <Text style={styles.bannerText}>
                        {conflictType === 'cloudNewer' ? '云端有新版本' : '本地更改未同步'}
                    </Text>
                    <View style={styles.bannerButtons}>
                        {conflictType === 'cloudNewer' ? (
                            <>
                                <TouchableOpacity onPress={handleOverwriteLocal} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>覆盖本地</Text>
                                </TouchableOpacity>
                                <TouchableOpacity onPress={handleSaveCopy} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>另存副本</Text>
                                </TouchableOpacity>
                            </>
                        ) : (
                            <>
                                <TouchableOpacity onPress={handleUploadOverwrite} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>上传覆盖</Text>
                                </TouchableOpacity>
                                <TouchableOpacity onPress={handleSaveCopy} style={styles.bannerButton}>
                                    <Text style={styles.bannerButtonText}>另存副本</Text>
                                </TouchableOpacity>
                            </>
                        )}
                    </View>
                </View>
            )}

            {isEditing ? (
                <WebView
                    ref={webViewRef}
                    source={
                        Platform.OS === 'android'
                            ? { uri: 'file:///android_asset/editor.html' }
                            : require('../../android/app/src/main/assets/editor.html')
                    }
                    onMessage={onWebViewMessage}
                    onLoadEnd={() => {
                        webViewRef.current?.postMessage(content);
                    }}
                    style={styles.webview}
                />
            ) : (
                <ScrollView style={styles.viewerContainer}>
                    <Markdown style={markdownThemes[markdownTheme]}>
                        {content}
                    </Markdown>
                </ScrollView>
            )}
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
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: theme.spacing.s, // Reduced padding
        backgroundColor: theme.colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
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
        justifyContent: 'center',
        alignItems: 'center',
        marginHorizontal: 10,
    },
    title: {
        fontSize: 16, // Slightly smaller font
        // fontWeight removed
        marginHorizontal: theme.spacing.s,
        flexShrink: 1,
        textAlign: 'center', // Center text if it wraps
    },
    syncIcon: {
        fontSize: 16,
        marginLeft: 4,
    },
    webview: {
        flex: 1,
    },
    viewerContainer: {
        flex: 1,
        padding: theme.spacing.m,
    },
    banner: {
        backgroundColor: '#FFF3CD',
        padding: theme.spacing.s,
        borderBottomWidth: 1,
        borderBottomColor: '#FFEEBA',
        alignItems: 'center',
    },
    bannerText: {
        color: '#856404',
        marginBottom: theme.spacing.s,
    },
    bannerButtons: {
        flexDirection: 'row',
        gap: theme.spacing.m,
    },
    bannerButton: {
        backgroundColor: '#856404',
        paddingHorizontal: theme.spacing.m,
        paddingVertical: theme.spacing.xs,
        borderRadius: 4,
    },
    bannerButtonText: {
        color: 'white',
        fontSize: 12,
    },
});


