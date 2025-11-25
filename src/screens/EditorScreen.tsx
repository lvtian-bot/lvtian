import React, { useEffect, useState, useRef, useCallback } from 'react';
import { View, StyleSheet, ActivityIndicator, Alert, TouchableOpacity, Text, Platform, DeviceEventEmitter } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, useNavigation, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { WebView } from 'react-native-webview';
import { RootStackParamList } from '../types/navigation';
import { fsService } from '../services/FileSystemService';
import { cloudService, UPLOAD_COMPLETED_EVENT } from '../services/CloudService';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { theme } from '../utils/theme';
import { normalizePath } from '../utils/pathUtils';

type EditorScreenRouteProp = RouteProp<RootStackParamList, 'Editor'>;

export const EditorScreen = () => {
    const route = useRoute<EditorScreenRouteProp>();
    const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
    const { t } = useTranslation();
    const { filePath: rawFilePath } = route.params;
    const filePath = normalizePath(rawFilePath);
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const webViewRef = useRef<WebView>(null);

    const { setMetadata } = useFileMetadataStore();

    const loadFile = useCallback(async () => {
        try {
            console.log('[EditorScreen] Loading file:', filePath);
            const exists = await fsService.exists(filePath);
            console.log('[EditorScreen] File exists:', exists);

            if (exists) {
                const fileContent = await fsService.readFile(filePath);
                console.log('[EditorScreen] File content length:', fileContent.length);
                setContent(fileContent);
            } else {
                console.log('[EditorScreen] File does not exist');
                setContent('');
            }
        } catch (error) {
            console.error('[EditorScreen] Error loading file:', error);
            Alert.alert('加载文件失败', JSON.stringify(error));
            setContent('');
        } finally {
            setLoading(false);
        }
    }, [filePath]);

    useEffect(() => {
        loadFile();
    }, [loadFile]);

    const handleAutoSave = async (newContent: string) => {
        try {
            // 自动保存：只写本地，不触发云上传，不退出编辑模式
            await fsService.writeFile(filePath, newContent);
            setContent(newContent);
            // 不调用 cloudService.uploadFile
            // 不调用 setIsEditing(false)
        } catch (error) {
            console.error('Auto save failed:', error);
            // 自动保存失败不打扰用户
        }
    };

    const handleManualSave = async (newContent: string) => {
        try {
            // 手动保存：写本地 + 触发云同步 + 返回预览页
            await fsService.writeFile(filePath, newContent);
            setContent(newContent);

            // Upload to cloud if configured (async, don't wait)
            if (cloudService.isConfigured()) {
                // Set persistent uploading state
                useFileMetadataStore.getState().setUploadState(filePath, 'uploading');

                // Get current local ETag for optimistic locking
                const currentMetadata = useFileMetadataStore.getState().getMetadata(filePath);
                const expectedEtag = currentMetadata?.etag || undefined;

                // Start upload in background
                cloudService.uploadFile(filePath, filePath, expectedEtag).then(result => {
                    if (result) {
                        // setMetadata will implicitly set uploadState to 'success'
                        setMetadata(filePath, result.etag, result.lastModified);
                    }
                    DeviceEventEmitter.emit(UPLOAD_COMPLETED_EVENT, { filePath, success: true });
                }).catch((error: any) => {
                    console.error('Upload failed:', error);

                    if (error.code === 'PreconditionFailed') {
                        useFileMetadataStore.getState().setUploadState(filePath, 'conflict-failed');
                    } else {
                        useFileMetadataStore.getState().setUploadState(filePath, 'failed');
                    }

                    DeviceEventEmitter.emit(UPLOAD_COMPLETED_EVENT, { filePath, success: false });
                });
            }

            // 返回预览页
            navigation.goBack();
        } catch {
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
                </View>
                <TouchableOpacity
                    onPress={requestSaveFromWebView}
                    style={styles.headerButton}
                >
                    <Text style={styles.headerButtonText}>{t('common.save')}</Text>
                </TouchableOpacity>
            </View>

            <WebView
                ref={webViewRef}
                source={
                    Platform.OS === 'android'
                        ? { uri: 'file:///android_asset/editor.html' }
                        : require('../../android/app/src/main/assets/editor.html')
                }
                originWhitelist={['*']}
                allowFileAccess={true}
                allowFileAccessFromFileURLs={true}
                allowUniversalAccessFromFileURLs={true}
                onMessage={onWebViewMessage}
                onLoadEnd={() => {
                    webViewRef.current?.postMessage(content);
                }}
                style={styles.webview}
            />
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
        padding: theme.spacing.s,
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
        fontSize: 16,
        marginHorizontal: theme.spacing.s,
        flexShrink: 1,
        textAlign: 'center',
    },
    webview: {
        flex: 1,
    },
});


