import React, { useEffect, useState, useRef, useCallback } from 'react';
import { View, StyleSheet, ActivityIndicator, Alert, TouchableOpacity, Text, BackHandler } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, useNavigation, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system/next';
import { RootStackParamList } from '../types/navigation';
import { fsService } from '../services/FileSystemService';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { theme } from '../utils/theme';
import { normalizePath } from '../utils/pathUtils';
import { syncService } from '../services/SyncService';

type EditorScreenRouteProp = RouteProp<RootStackParamList, 'Editor'>;

// Helper Component for Header Button
const HeaderBackButton = ({ onPress, text }: { onPress: () => void, text: string }) => (
    <TouchableOpacity onPress={onPress} style={styles.headerButton}>
        <Text style={styles.headerButtonText}>{text}</Text>
    </TouchableOpacity>
);

export const EditorScreen = () => {
    const route = useRoute<EditorScreenRouteProp>();
    const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
    const { t } = useTranslation();
    const { filePath: rawFilePath } = route.params;
    const filePath = normalizePath(rawFilePath);
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const [isDirty, setIsDirty] = useState(false);
    const [editorHtml, setEditorHtml] = useState<string | null>(null);
    const webViewRef = useRef<WebView>(null);
    const isDraftLoaded = useRef(false);
    const initialContentRef = useRef<string>('');

    const { markFileAsModified } = useFileMetadataStore();

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
                    t('common.draftFound'),
                    t('common.restoreDraftPrompt'),
                    [
                        {
                            text: t('common.discard'),
                            style: 'destructive',
                            onPress: async () => {
                                await AsyncStorage.removeItem(DRAFT_KEY);
                                setContent(fileContent);
                                initialContentRef.current = fileContent;
                                isDraftLoaded.current = true;
                            },
                        },
                        {
                            text: t('common.restore'),
                            onPress: () => {
                                setContent(draftContent);
                                initialContentRef.current = fileContent; // Initial is still file content
                                setIsDirty(true); // Draft implies dirty
                                isDraftLoaded.current = true;
                            },
                        },
                    ]
                );
            } else {
                setContent(fileContent);
                initialContentRef.current = fileContent;
                isDraftLoaded.current = true;
            }

        } catch (error) {
            console.error('[EditorScreen] Error loading file:', error);
            Alert.alert(t('editor.loadFileFailed'), JSON.stringify(error));
            setContent('');
            initialContentRef.current = '';
            isDraftLoaded.current = true;
        } finally {
            setLoading(false);
        }
    }, [filePath, DRAFT_KEY, t]);

    useEffect(() => {
        loadFile();
    }, [loadFile]);

    // Load editor HTML asset
    useEffect(() => {
        const loadEditorHtml = async () => {
            try {
                const asset = Asset.fromModule(require('../../assets/editor.html'));
                await asset.downloadAsync();
                if (asset.localUri) {
                    const file = new File(asset.localUri);
                    const html = await file.text();
                    setEditorHtml(html);
                } else {
                    console.error('[EditorScreen] Failed to get localUri for editor.html');
                }
            } catch (error) {
                console.error('[EditorScreen] Failed to load editor HTML:', error);
            }
        };
        loadEditorHtml();
    }, []);

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
        // Only mark as dirty if content is different from initial or saved content
        setIsDirty(newContent !== initialContentRef.current);
    };

    const handleManualSave = useCallback(async (contentToSave: string) => {
        try {
            // 手动保存：写本地 + 触发云同步 + 返回预览页
            await fsService.writeFile(filePath, contentToSave);
            markFileAsModified(filePath);

            // Clear draft
            await AsyncStorage.removeItem(DRAFT_KEY);
            setIsDirty(false);
            setContent(contentToSave);
            initialContentRef.current = contentToSave;

            // Upload to cloud if configured (wait for upload to complete before navigating back)
            // syncService.uploadFile handles cloud configuration check internally
            const success = await syncService.uploadFile(filePath, { withLock: true });
            if (!success) {
                // 如果失败，已经在 syncService 内部处理了状态设置和事件发送
                // 但我们可能想给用户一个 Alert
                const metadata = useFileMetadataStore.getState().getMetadata(filePath);
                if (metadata?.uploadState === 'conflict-failed' || metadata?.uploadState === 'failed') {
                    Alert.alert(t('editor.uploadFailedTitle'), t('editor.uploadFailedMessage'));
                }
            }

            // 返回预览页
            navigation.goBack();
        } catch {
            Alert.alert('Error', 'Failed to save file');
        }
    }, [filePath, markFileAsModified, DRAFT_KEY, navigation]);

    const handleBackPress = useCallback(() => {
        if (isDirty) {
            Alert.alert(
                t('common.confirm'),
                t('common.saveChangesPrompt'),
                [
                    {
                        text: t('common.dontSave'),
                        style: 'destructive',
                        onPress: async () => {
                            await AsyncStorage.removeItem(DRAFT_KEY);
                            navigation.goBack();
                        },
                    },
                    {
                        text: t('common.cancel'),
                        style: 'cancel',
                    },
                    {
                        text: t('common.save'),
                        onPress: () => handleManualSave(content),
                    },
                ]
            );
            return true; // Prevent default behavior
        }
        return false; // Allow default behavior
    }, [isDirty, content, DRAFT_KEY, navigation, t, handleManualSave]);

    // Handle hardware back button
    useEffect(() => {
        const backHandler = BackHandler.addEventListener('hardwareBackPress', handleBackPress);
        return () => backHandler.remove();
    }, [handleBackPress]);

    // Handle header back button
    const headerLeft = useCallback(() => (
        <HeaderBackButton
            onPress={() => {
                if (!handleBackPress()) {
                    navigation.goBack();
                }
            }}
            text={t('common.back')}
        />
    ), [handleBackPress, navigation, t]);

    useEffect(() => {
        navigation.setOptions({
            headerLeft,
        });
    }, [navigation, headerLeft]);


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

    if (loading || !editorHtml) {
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
                    disabled={!isDirty}
                >
                    <Text style={[
                        styles.headerButtonText,
                        !isDirty && styles.headerButtonTextDisabled
                    ]}>{t('common.save')}</Text>
                </TouchableOpacity>
            </View>

            <WebView
                ref={webViewRef}
                source={{ html: editorHtml, baseUrl: '' }}
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
    headerButtonTextDisabled: {
        color: '#ccc',
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


