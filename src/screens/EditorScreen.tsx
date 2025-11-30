import React, { useEffect, useState, useRef, useCallback } from 'react';
import { View, StyleSheet, ActivityIndicator, Alert, TouchableOpacity, Text, Platform, DeviceEventEmitter, BackHandler } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, useNavigation, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
    const [isDirty, setIsDirty] = useState(false);
    const webViewRef = useRef<WebView>(null);
    const isDraftLoaded = useRef(false);

    const { setMetadata, markFileAsModified } = useFileMetadataStore();

    const DRAFT_KEY = `editor_draft_${filePath}`;

    const loadFile = useCallback(async () => {
        try {
            console.log('[EditorScreen] Loading file:', filePath);
            const exists = await fsService.exists(filePath);
            let fileContent = '';

            if (exists) {
                fileContent = await fsService.readFile(filePath);
            }

            // Check for draft
            const draftContent = await AsyncStorage.getItem(DRAFT_KEY);

            if (draftContent && draftContent !== fileContent) {
                Alert.alert(
                    t('common.draftFound') || '发现未保存的草稿',
                    t('common.restoreDraftPrompt') || '是否恢复上次未保存的内容？',
                    [
                        {
                            text: t('common.discard') || '丢弃',
                            style: 'destructive',
                            onPress: async () => {
                                await AsyncStorage.removeItem(DRAFT_KEY);
                                setContent(fileContent);
                                isDraftLoaded.current = true;
                            },
                        },
                        {
                            text: t('common.restore') || '恢复',
                            onPress: () => {
                                setContent(draftContent);
                                setIsDirty(true);
                                isDraftLoaded.current = true;
                            },
                        },
                    ]
                );
            } else {
                setContent(fileContent);
                isDraftLoaded.current = true;
            }

        } catch (error) {
            console.error('[EditorScreen] Error loading file:', error);
            Alert.alert('加载文件失败', JSON.stringify(error));
            setContent('');
            isDraftLoaded.current = true;
        } finally {
            setLoading(false);
        }
    }, [filePath, DRAFT_KEY, t]);

    useEffect(() => {
        loadFile();
    }, [loadFile]);

    // Debounced Auto-save to Cache
    useEffect(() => {
        if (!isDraftLoaded.current) return;

        const saveDraft = async () => {
            try {
                if (isDirty) {
                    await AsyncStorage.setItem(DRAFT_KEY, content);
                }
            } catch (error) {
                console.error('Failed to save draft:', error);
            }
        };

        const timeoutId = setTimeout(saveDraft, 500);
        return () => clearTimeout(timeoutId);
    }, [content, isDirty, DRAFT_KEY]);

    const handleAutoSave = (newContent: string) => {
        // Update state, trigger effect to save to cache
        setContent(newContent);
        setIsDirty(true);
    };

    const handleManualSave = async (contentToSave: string) => {
        try {
            // 手动保存：写本地 + 触发云同步 + 返回预览页
            await fsService.writeFile(filePath, contentToSave);
            markFileAsModified(filePath);

            // Clear draft
            await AsyncStorage.removeItem(DRAFT_KEY);
            setIsDirty(false);
            setContent(contentToSave);

            // Upload to cloud if configured (wait for upload to complete before navigating back)
            if (cloudService.isConfigured()) {
                try {
                    // Set persistent uploading state
                    useFileMetadataStore.getState().setUploadState(filePath, 'uploading');

                    // Get current metadata for triple hash mechanism
                    const currentMetadata = useFileMetadataStore.getState().getMetadata(filePath);

                    // Get expected hash for optimistic locking (use syncedHash as expected)
                    const expectedEtag = currentMetadata?.syncedHash || undefined;

                    // Wait for upload to complete
                    const result = await cloudService.uploadFile(filePath, filePath, expectedEtag);
                    if (result) {
                        // setMetadata will implicitly set uploadState to 'success'
                        // After successful sync, syncedHash and localHash should match cloud's result
                        setMetadata(filePath, result.etag, result.etag, result.lastModified);
                    }
                    DeviceEventEmitter.emit(UPLOAD_COMPLETED_EVENT, { filePath, success: true });
                } catch (error: any) {
                    console.error('Upload failed:', error);

                    if (error.code === 'PreconditionFailed') {
                        useFileMetadataStore.getState().setUploadState(filePath, 'conflict-failed');
                    } else {
                        useFileMetadataStore.getState().setUploadState(filePath, 'failed');
                    }

                    DeviceEventEmitter.emit(UPLOAD_COMPLETED_EVENT, { filePath, success: false });

                    // Show upload failure alert
                    Alert.alert('上传失败', '文件已保存到本地，但云上传失败。您可以稍后重新同步。');
                }
            }

            // 返回预览页
            navigation.goBack();
        } catch {
            Alert.alert('Error', 'Failed to save file');
        }
    };

    const handleBackPress = useCallback(() => {
        if (isDirty) {
            Alert.alert(
                t('common.confirm') || '确认',
                t('common.saveChangesPrompt') || '是否保存更改？',
                [
                    {
                        text: t('common.dontSave') || '暂不保存',
                        style: 'destructive',
                        onPress: async () => {
                            await AsyncStorage.removeItem(DRAFT_KEY);
                            navigation.goBack();
                        },
                    },
                    {
                        text: t('common.cancel') || '取消',
                        style: 'cancel',
                    },
                    {
                        text: t('common.save') || '保存',
                        onPress: () => handleManualSave(content),
                    },
                ]
            );
            return true; // Prevent default behavior
        }
        return false; // Allow default behavior
    }, [isDirty, content, DRAFT_KEY, navigation, t]);

    // Handle hardware back button
    useEffect(() => {
        const backHandler = BackHandler.addEventListener('hardwareBackPress', handleBackPress);
        return () => backHandler.remove();
    }, [handleBackPress]);

    // Handle header back button
    useEffect(() => {
        navigation.setOptions({
            headerLeft: () => (
                <TouchableOpacity onPress={() => {
                    if (!handleBackPress()) {
                        navigation.goBack();
                    }
                }} style={styles.headerButton}>
                    <Text style={styles.headerButtonText}>{t('common.back')}</Text>
                </TouchableOpacity>
            ),
        });
    }, [navigation, handleBackPress, t]);


    const onWebViewMessage = (event: any) => {
        try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data.type === 'autoSave') {
                handleAutoSave(data.content);
            } else if (data.type === 'manualSave') {
                handleManualSave(data.content);
            } else if (data.type === 'log') {
                console.log('[WebView Log]', data.content);
            } else if (data.type === 'error') {
                console.error('[WebView Error]', data.content);
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
                <TouchableOpacity onPress={() => {
                    if (!handleBackPress()) {
                        navigation.goBack();
                    }
                }} style={styles.headerButton}>
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
                        ? { uri: 'file:///android_asset/editor_cm6.html' }
                        : require('../../android/app/src/main/assets/editor_cm6.html')
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


