import React, { useEffect, useState, useCallback, useRef, type ComponentRef } from 'react';
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
import { useAssistantStore } from '../store/useAssistantStore';
import { theme } from '../utils/theme';
import { useSettingsFont } from '../components/settings';
import { stableHash } from '../utils/identityHash';
import { useCloudSync } from '../hooks/useCloudSync';
import { StatusBannerContainer } from '../components/StatusBannerContainer';
import { previewHtml } from '../preview-web/previewHtml';
import { serverFileService } from '../services/ServerFileService';
import { getFontSizeMetrics } from '../utils/fontSize';

type PreviewScreenRouteProp = RouteProp<RootStackParamList, 'Preview'>;
type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

export const PreviewScreen = () => {
    const font = useSettingsFont();
    const route = useRoute<PreviewScreenRouteProp>();
    const navigation = useNavigation<NavigationProp>();
    const { t } = useTranslation();
    const { filePath, source = 'local', title } = route.params;
    const { markdownTheme, fontSize } = useSettingsStore();
    const previewFontSize = getFontSizeMetrics(fontSize).chatBody;
    const fileMetadata = useFileMetadataStore(state => state.metadata[filePath]);
    const insets = useSafeAreaInsets();

    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const [loadFailed, setLoadFailed] = useState(false);
    const [fileMtime, setFileMtime] = useState<number | undefined>(undefined);
    const [isWebViewReady, setIsWebViewReady] = useState(false);
    const webViewRef = useRef<ComponentRef<typeof WebView>>(null);

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

        // 在线图片缓存有效期：过期后重新下载，避免云端图片原地更新后长期显示陈旧内容
        const IMAGE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
        const isCacheUsable = (info: { exists: boolean; modificationTime: number | null }) =>
            info.exists && info.modificationTime !== null && Date.now() - info.modificationTime < IMAGE_CACHE_TTL_MS;

        let result = rawText;
        for (const item of matches) {
            const { full, src: rawSrc } = item;
            if (rawSrc.startsWith('http://') || rawSrc.startsWith('https://') || rawSrc.startsWith('data:')) {
                continue;
            }
            // 与链接一致：图片路径可能带 URI 百分号编码（如空格变 %20），先解码再解析
            let src = rawSrc;
            try {
                src = decodeURIComponent(rawSrc);
            } catch {
                // 无效编码序列时按原样处理
            }

            try {
                // 分类图片引用：file:// URI 与根绝对路径不拼接笔记目录，仅真正的相对路径才相对笔记目录解析
                let resolvedRemoteOrLocalPath: string;
                if (src.startsWith('file://')) {
                    // 本地文件 URI 原样保留，由 WebView 按自身访问能力渲染
                    resolvedRemoteOrLocalPath = src;
                } else {
                    const isRootAbsolute = src.startsWith('/');
                    const currentDir = (!isRootAbsolute && filePath.includes('/'))
                        ? filePath.substring(0, filePath.lastIndexOf('/'))
                        : '';
                    const parts = (isRootAbsolute ? src : (currentDir ? currentDir + '/' + src : src)).split('/');
                    const stack: string[] = [];
                    for (const part of parts) {
                        if (part === '..') {
                            stack.pop();
                        } else if (part !== '.' && part !== '') {
                            stack.push(part);
                        }
                    }
                    // 服务端路径以根绝对形式表示（filePath 以 / 开头），拼接结果需保留前导斜杠，
                    // 否则服务端会相对进程工作目录解析导致找不到文件
                    const needsLeadingSlash = isRootAbsolute || (source === 'server' && filePath.startsWith('/'));
                    resolvedRemoteOrLocalPath = (needsLeadingSlash ? '/' : '') + stack.join('/');
                }

                if (source === 'server') {
                    // 服务端模式：下载相对图片到沙盒缓存供 WebView 渲染
                    // 存在性检查直接使用缓存目录感知的 API，避免 fsService 将路径清洗重定向到文档根后永远判定不存在
                    if (resolvedRemoteOrLocalPath.startsWith('file://')) {
                        // 在线模式无法解析本地文件 URI，维持原引用
                        continue;
                    }
                    // 缓存键含助理服务地址维度，切换服务端后不复用旧服务的同名路径缓存
                    const { serverUrl } = useAssistantStore.getState();
                    const digest = stableHash(`${serverUrl || ''}|${resolvedRemoteOrLocalPath}`);
                    const localUri = fsService.getCacheFileUri(`img_server_${digest}`);
                    let cacheInfo = fsService.getCacheFileInfo(localUri);
                    if (!isCacheUsable(cacheInfo)) {
                        try {
                            await serverFileService.downloadFile(resolvedRemoteOrLocalPath, localUri);
                        } catch (e) {
                            console.warn('Failed to download server image:', resolvedRemoteOrLocalPath, e);
                        }
                    }
                    cacheInfo = fsService.getCacheFileInfo(localUri);
                    if (cacheInfo.exists) {
                        result = result.replace(full, full.replace(rawSrc, localUri));
                    }
                } else if (source === 'webdav') {
                    // 纯在线网盘模式：下载到沙盒临时目录
                    // 缓存键含账号维度哈希与路径哈希，避免不同账号或不同路径互相覆盖
                    if (resolvedRemoteOrLocalPath.startsWith('file://')) {
                        // 在线模式无法解析本地文件 URI，维持原引用
                        continue;
                    }
                    const cleanKey = resolvedRemoteOrLocalPath.startsWith('/') ? resolvedRemoteOrLocalPath.slice(1) : resolvedRemoteOrLocalPath;
                    const { webDavConfig } = useSettingsStore.getState();
                    const accountDigest = stableHash(`${webDavConfig?.server || ''}|${webDavConfig?.username || ''}`);
                    const digest = stableHash(`${accountDigest}|${cleanKey}`);
                    const localUri = fsService.getCacheFileUri(`img_webdav_${digest}`);
                    let cacheInfo = fsService.getCacheFileInfo(localUri);
                    if (!isCacheUsable(cacheInfo)) {
                        try {
                            await cloudService.downloadFile(cleanKey, localUri);
                        } catch (e) {
                            console.warn('Failed to download webdav image:', cleanKey, e);
                        }
                    }
                    cacheInfo = fsService.getCacheFileInfo(localUri);
                    if (cacheInfo.exists) {
                        result = result.replace(full, full.replace(rawSrc, localUri));
                    }
                } else {
                    // 本地模式
                    let absolutePath = resolvedRemoteOrLocalPath;
                    if (!absolutePath.startsWith('file://')) {
                        absolutePath = 'file://' + absolutePath;
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
                    result = result.replace(full, full.replace(src, absolutePath));
                }
            } catch (err) {
                console.error('Error resolving image:', src, err);
            }
        }
        return result;
    }, [filePath, source]);

    // 记录最近一次待渲染的原始正文：图片解析是异步的，二次推送前核对正文未被更新，防止旧图片版本覆盖新内容
    const latestRawContentRef = useRef('');

    const sendContentToWebView = useCallback(async (rawText: string) => {
        if (!webViewRef.current) return;
        latestRawContentRef.current = rawText;
        // 先推送原文让预览立即可见；在线图片在后台解析替换完成后二次推送，
        // 避免多张未缓存图片串行下载（每张最长 30 秒超时）阻塞整个预览渲染
        webViewRef.current.postMessage(JSON.stringify({
            type: 'SET_CONTENT',
            payload: {
                content: rawText,
                theme: markdownTheme,
            },
        }));
        const resolved = await resolveMarkdownImages(rawText);
        if (resolved !== rawText && latestRawContentRef.current === rawText && webViewRef.current) {
            webViewRef.current.postMessage(JSON.stringify({
                type: 'SET_CONTENT',
                payload: {
                    content: resolved,
                    theme: markdownTheme,
                },
            }));
        }
    }, [resolveMarkdownImages, markdownTheme]);

    const loadFile = useCallback(async () => {
        try {
            setLoading(true);
            setIsWebViewReady(false); // 重置 WebView 就绪状态，确保重新挂载后能再次收到正文
            setLoadFailed(false);
            let fileContent = '';

            if (source === 'server') {
                const res = await serverFileService.readFileContent(filePath);
                fileContent = res.content;
                setFileMtime(res.mtime);
            } else if (source === 'webdav') {
                fileContent = await cloudService.getCloudFileContent(filePath);
            } else {
                const exists = await fsService.exists(filePath);
                if (exists) {
                    fileContent = await fsService.readFile(filePath);
                }
            }

            setContent(fileContent);
        } catch (err: unknown) {
            setLoadFailed(true);
            // 清除上一次的陈旧内容，防止 WebView 因加载周期重新挂载后把旧正文再次推送渲染
            setContent('');
            const serverErr = err as { code?: string; message?: string };
            const code = serverErr.code;
            let message = (err as Error).message || t('browser.fileLoadFailed', { defaultValue: 'Failed to load file' });
            if (code) {
                message = t(`browser.error.${code}`, { defaultValue: message });
            }
            Alert.alert(t('common.error'), message);
        } finally {
            setLoading(false);
        }
    }, [filePath, source, t]);

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

    // Push font size change to WebView
    useEffect(() => {
        if (isWebViewReady) {
            const fontScript = `
                (function() {
                    var styleEl = document.getElementById('lvtian-font-style');
                    if (!styleEl) {
                        styleEl = document.createElement('style');
                        styleEl.id = 'lvtian-font-style';
                        document.head.appendChild(styleEl);
                    }
                    styleEl.innerHTML = '#preview, .markdown-body { font-size: ${previewFontSize}px !important; }';
                })();
                true;
            `;
            webViewRef.current?.injectJavaScript(fontScript);
        }
    }, [fontSize, isWebViewReady, previewFontSize]);

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
        // 在线模式下的相对链接：按当前文件路径解析后跳转到另一个在线预览，而非交给系统浏览器
        const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);
        if (!hasScheme && (source === 'server' || source === 'webdav')) {
            // 先拆出锚点片段：`next.md#usage` 不能把 `#usage` 当作文件名的一部分
            const hashIdx = url.indexOf('#');
            const linkPathOnly = hashIdx !== -1 ? url.substring(0, hashIdx) : url;
            if (!linkPathOnly) {
                // 纯锚点链接（#xxx）指向当前文档内位置，在线预览暂不支持锚点定位，忽略
                return;
            }
            // Markdown 渲染器输出的 href 可能带 URI 百分号编码（如空格变 %20），先解码再解析
            let decodedLink = linkPathOnly;
            try {
                decodedLink = decodeURIComponent(linkPathOnly);
            } catch {
                // 无效编码序列时按原样处理
            }
            const currentDir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';
            const parts = (decodedLink.startsWith('/') ? decodedLink : (currentDir ? currentDir + '/' + decodedLink : decodedLink)).split('/');
            const stack: string[] = [];
            for (const part of parts) {
                if (part === '..') stack.pop();
                else if (part !== '.' && part !== '') stack.push(part);
            }
            const needsLeadingSlash = decodedLink.startsWith('/') || (source === 'server' && filePath.startsWith('/'));
            const resolvedLink = (needsLeadingSlash ? '/' : '') + stack.join('/');
            navigation.navigate('Preview', {
                filePath: resolvedLink,
                source,
                title: resolvedLink.split('/').pop(),
            });
            return;
        }

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
                    <Text style={[styles.headerButtonText, { fontSize: font.chatBody }]}>{t('common.back')}</Text>
                </TouchableOpacity>
                <View style={styles.titleContainer}>
                    <Text style={[styles.title, { fontSize: font.chatBody }]} numberOfLines={2}>
                        {title || filePath.split('/').pop() || filePath}
                    </Text>
                    {isLocalMode && isEffectivelySyncing && <ActivityIndicator size="small" color={theme.colors.primary} />}
                    {isLocalMode && !isEffectivelySyncing && syncStatus === 'synced' && <Text style={styles.syncIcon}>✅</Text>}
                    {isLocalMode && !isEffectivelySyncing && (syncStatus === 'conflict' || syncStatus === 'offline' || syncStatus === 'not-configured' || (syncStatus === 'error' && fileMetadata?.uploadState === 'failed')) && <Text style={styles.syncIcon}>⚠️</Text>}
                    {isLocalMode && !isEffectivelySyncing && syncStatus === 'error' && fileMetadata?.uploadState !== 'failed' && <Text style={styles.syncIcon}>❌</Text>}
                </View>
                <TouchableOpacity
                    onPress={() => navigation.navigate('Editor', {
                        filePath,
                        source,
                        initialContent: content,
                        expectedMtime: fileMtime,
                        title: title || filePath.split('/').pop(),
                    })}
                    style={[styles.headerButton, (loading || loadFailed) && styles.headerButtonDisabled]}
                    disabled={loading || loadFailed}
                >
                    <Text style={[styles.headerButtonText, (loading || loadFailed) && styles.headerButtonTextDisabled, { fontSize: font.chatBody }]}>
                        {t('common.edit')}
                    </Text>
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
    headerButtonDisabled: {
        opacity: 0.4,
    },
    headerButtonText: {
        color: theme.colors.primary,
        fontWeight: 'bold',
    },
    headerButtonTextDisabled: {
        color: theme.colors.textSecondary,
    },
    titleContainer: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    title: {
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
