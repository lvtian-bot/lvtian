import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Alert, TouchableOpacity, DeviceEventEmitter, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRoute, useNavigation, RouteProp, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { WebView } from 'react-native-webview';
import { RootStackParamList } from '../types/navigation';
import { fsService } from '../services/FileSystemService';
import { cloudService, UPLOAD_COMPLETED_EVENT } from '../services/CloudService';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { theme } from '../utils/theme';
import { useCloudSync } from '../hooks/useCloudSync';
import { StatusBannerContainer } from '../components/StatusBannerContainer';
import { previewHtml } from '../preview-web/previewHtml';
import { serverFileService } from '../services/ServerFileService';

type PreviewScreenRouteProp = RouteProp<RootStackParamList, 'Preview'>;
type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

export const PreviewScreen = () => {
    const route = useRoute<PreviewScreenRouteProp>();
    const navigation = useNavigation<NavigationProp>();
    const { t } = useTranslation();
    const { filePath, source = 'local', title } = route.params;
    const { markdownTheme } = useSettingsStore();
    const fileMetadata = useFileMetadataStore(state => state.metadata[filePath]);
    const insets = useSafeAreaInsets();

    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const [isWebViewReady, setIsWebViewReady] = useState(false);
    const webViewRef = useRef<WebView>(null);

    // 仅在 local 模式使用本地云同步 hook
    const isLocalMode = source === 'local';
    const { syncStatus, conflictType, isSyncing, checkSync, performAutoSync, resolveConflict } = useCloudSync(isLocalMode ? filePath : '');

    // Helper to determine if we should show the conflict banner
    const shouldShowConflictBanner = syncStatus === 'conflict' && (
        conflictType === 'bidirectional' ||
        !conflictType ||
        fileMetadata?.uploadState === 'conflict-failed'
    );

    // Helper to determine effective sync state for icon
    const isEffectivelySyncing = isSyncing ||
        syncStatus === 'checking' ||
        (syncStatus === 'conflict' && (conflictType === 'cloudNewer' || conflictType === 'localNewer'));

    // Resolve markdown local image references and download missing ones from cloud
    const resolveMarkdownImages = useCallback(async (rawText: string): Promise<string> => {
        if (!rawText) return '';
        const imgRegex = /!\[(.*?)\]\((\S+?)(?:\s+["'].*?["'])?\)/g;
        const matches: { full: string; alt: string; src: string }[] = [];
        let match;
        while ((match = imgRegex.exec(rawText)) !== null) {
            matches.push({ full: match[0], alt: match[1], src: match[2] });
        }
        if (matches.length === 0) return rawText;

        let result = rawText;
        for (const item of matches) {
            const { full, src } = item;
            if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
                continue;
            }

            try {
                let absolutePath = '';
                if (src.startsWith('file://')) {
                    absolutePath = src;
                } else if (src.startsWith('/')) {
                    absolutePath = 'file://' + src;
                } else {
                    const currentDir = filePath.substring(0, filePath.lastIndexOf('/'));
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
                    if (!absolutePath.startsWith('file://')) {
                        absolutePath = 'file://' + absolutePath;
                    }
                }

                const exists = await fsService.exists(absolutePath);
                if (!exists && cloudService.isConfigured()) {
                    const rootPath = fsService.getRootPath();
                    const normalizedRoot = rootPath.replace('file://', '');
                    const normalizedAbs = absolutePath.replace('file://', '');
                    if (normalizedAbs.startsWith(normalizedRoot)) {
                        const key = normalizedAbs.substring(normalizedRoot.length + 1);
                        try {
                            await cloudService.downloadFile(key, absolutePath);
                        } catch (e) {
                            console.warn('Failed to download image:', key, e);
                        }
                    }
                }

                const newImg = full.replace(src, absolutePath);
                result = result.replace(full, newImg);
            } catch (err) {
                console.error('Error resolving image:', src, err);
            }
        }
        return result;
    }, [filePath]);

    const sendContentToWebView = useCallback(async (rawText: string) => {
        if (!webViewRef.current) return;
        const resolved = isLocalMode ? await resolveMarkdownImages(rawText) : rawText;
        webViewRef.current.postMessage(JSON.stringify({
            type: 'SET_CONTENT',
            payload: {
                content: resolved,
                theme: markdownTheme,
            },
        }));
    }, [isLocalMode, resolveMarkdownImages, markdownTheme]);

    const loadFile = useCallback(async () => {
        try {
            setLoading(true);
            let fileContent = '';

            if (source === 'server') {
                const res = await serverFileService.readFileContent(filePath);
                fileContent = res.content;
            } else if (source === 'webdav') {
                fileContent = await cloudService.getCloudFileContent(filePath);
            } else {
                const exists = await fsService.exists(filePath);
                if (exists) {
                    fileContent = await fsService.readFile(filePath);
                }
            }

            setContent(fileContent);
            if (isWebViewReady) {
                await sendContentToWebView(fileContent);
            }
        } catch (err: unknown) {
            Alert.alert(t('common.error'), (err as Error).message || t('browser.fileLoadFailed', { defaultValue: 'Failed to load file' }));
        } finally {
            setLoading(false);
        }
    }, [filePath, source, isWebViewReady, sendContentToWebView, t]);

    // Push content when WebView is ready
    useEffect(() => {
        if (isWebViewReady && content) {
            sendContentToWebView(content);
        }
    }, [isWebViewReady, content, sendContentToWebView]);

    // Push theme change when user switches theme
    useEffect(() => {
        if (isWebViewReady) {
            webViewRef.current?.postMessage(JSON.stringify({
                type: 'SET_THEME',
                payload: markdownTheme,
            }));
        }
    }, [markdownTheme, isWebViewReady]);

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
            await loadFile();
            Alert.alert(t('common.success'), t('sync.savedCopy', { defaultValue: 'Local changes saved to copy. Now viewing cloud version.' }));
        } catch (_) {
            Alert.alert(t('common.error'), t('sync.saveCopyFailed', { defaultValue: 'Failed to save copy' }));
        }
    };

    // Listen for upload completion to reload content if needed
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
            if (isLocalMode) {
                performAutoSync();
            }
        }, [loadFile, isLocalMode, performAutoSync])
    );

    const handleLinkClick = async (url: string) => {
        try {
            const supported = await Linking.canOpenURL(url);
            if (supported) {
                await Linking.openURL(url);
            } else {
                Alert.alert(t('common.error'), url);
            }
        } catch (e) {
            console.warn('Failed to open link:', url, e);
        }
    };

    const onWebViewMessage = (event: { nativeEvent: { data: string } }) => {
        try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data.type === 'ON_READY') {
                setIsWebViewReady(true);
                // 同步当前语言给预览 WebView（中英文案）
                webViewRef.current?.postMessage(JSON.stringify({
                    type: 'SET_LOCALE',
                    payload: i18n.language?.startsWith('zh') ? 'zh' : 'en',
                }));
            } else if (data.type === 'LINK_CLICK') {
                handleLinkClick(data.payload);
            } else if (data.type === 'COPY_CODE') {
                console.log('[PreviewScreen] Code copied');
            } else if (data.type === 'LOG') {
                console.log('[Preview WebView Log]', data.payload);
            } else if (data.type === 'ERROR') {
                console.error('[Preview WebView Error]', data.payload);
            }
        } catch {
            console.warn('Received non-JSON message from preview WebView');
        }
    };

    return (
        <View style={[styles.container, { paddingBottom: insets.bottom }]}>
            <View style={[styles.header, { paddingTop: insets.top + theme.spacing.s }]}>
                <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerButton}>
                    <Text style={styles.headerButtonText}>{t('common.back')}</Text>
                </TouchableOpacity>
                <View style={styles.titleContainer}>
                    <Text style={styles.title} numberOfLines={2}>
                        {title || filePath.split('/').pop() || filePath}
                    </Text>
                    {isLocalMode && isEffectivelySyncing && <ActivityIndicator size="small" color={theme.colors.primary} />}
                    {isLocalMode && !isEffectivelySyncing && syncStatus === 'synced' && <Text style={styles.syncIcon}>✅</Text>}
                    {isLocalMode && !isEffectivelySyncing && (syncStatus === 'conflict' || syncStatus === 'offline' || syncStatus === 'not-configured' || (syncStatus === 'error' && fileMetadata?.uploadState === 'failed')) && <Text style={styles.syncIcon}>⚠️</Text>}
                    {isLocalMode && !isEffectivelySyncing && syncStatus === 'error' && fileMetadata?.uploadState !== 'failed' && <Text style={styles.syncIcon}>❌</Text>}
                </View>
                <TouchableOpacity
                    onPress={() => navigation.navigate('Editor', { filePath, source, initialContent: content, title: title || filePath.split('/').pop() })}
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
                    {isLocalMode && (
                        <StatusBannerContainer
                            syncStatus={syncStatus}
                            conflictType={conflictType}
                            checkSync={checkSync}
                            hasFailedUpload={fileMetadata?.uploadState === 'failed'}
                            uploadErrorFiles={fileMetadata?.uploadState === 'failed' ? [filePath] : []}
                            conflictedFiles={shouldShowConflictBanner ? [filePath] : []}
                            onResolveUseCloud={handleOverwriteLocal}
                            onResolveUseLocal={handleUploadOverwrite}
                            onResolveSaveCopy={handleSaveCopy}
                        />
                    )}

                    <WebView
                        ref={webViewRef}
                        source={{ html: previewHtml, baseUrl: isLocalMode ? fsService.getRootPath() : undefined }}
                        originWhitelist={['*']}
                        allowFileAccess={true}
                        allowFileAccessFromFileURLs={true}
                        allowUniversalAccessFromFileURLs={true}
                        allowingReadAccessToURL={isLocalMode ? fsService.getRootPath() : undefined}
                        onMessage={onWebViewMessage}
                        style={styles.webview}
                    />
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
    webview: {
        flex: 1,
        backgroundColor: 'transparent',
    },
});
