import React, { useEffect, useState, useRef, useCallback } from 'react';
import { View, StyleSheet, ActivityIndicator, Alert, TouchableOpacity, Text, BackHandler } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, useNavigation, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
// import { Asset } from 'expo-asset'; // Removed
// import { File } from 'expo-file-system/next'; // Removed
import { RootStackParamList } from '../types/navigation';
import { fsService } from '../services/FileSystemService';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { theme } from '../utils/theme';
import { normalizePath } from '../utils/pathUtils';
import { stableHash } from '../utils/identityHash';
import { syncService } from '../services/SyncService';
import { flashNoteService } from '../services/FlashNoteService';
import { serverFileService } from '../services/ServerFileService';
import { cloudService } from '../services/CloudService';
import { useAssistantStore } from '../store/useAssistantStore';
import { useSettingsStore } from '../store/useSettingsStore';

type EditorScreenRouteProp = RouteProp<RootStackParamList, 'Editor'>;

// 草稿载荷：内容与基线 mtime 以单键 JSON 原子存储，避免分开写入中断产生无基线草稿
interface DraftPayload {
    c: string;
    m: number;
}

const parseDraft = (raw: string | null): { content: string; baselineMtime: number } | null => {
    if (raw === null) return null;
    try {
        const parsed = JSON.parse(raw) as DraftPayload;
        if (typeof parsed.c === 'string') {
            return { content: parsed.c, baselineMtime: typeof parsed.m === 'number' ? parsed.m : 0 };
        }
    } catch {
        // 旧版以纯文本存储内容：可用但缺少基线
    }
    return { content: raw, baselineMtime: 0 };
};

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
    const { filePath: rawFilePath, flashNoteId, initialContent: paramInitialContent, source = 'local', title, expectedMtime: paramExpectedMtime } = route.params; // Get params
    const filePath = source === 'server' ? rawFilePath : normalizePath(rawFilePath);
    const currentMtimeRef = useRef<number | undefined>(paramExpectedMtime);
    const serverUrl = useAssistantStore(state => state.serverUrl);
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const [isDirty, setIsDirty] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const saveInFlightRef = useRef(false);
    const [editorHtml, setEditorHtml] = useState<string | null>(null);
    const webViewRef = useRef<WebView>(null);
    const isDraftLoaded = useRef(false);
    const initialContentRef = useRef<string>('');

    const { markFileAsModified } = useFileMetadataStore();

    const isFlashMode = !!flashNoteId;
    const { serverToken } = useAssistantStore.getState();
    // 服务前缀含地址与令牌：同地址换令牌（重装、反代按令牌选实例）视为不同服务，草稿互不串用
    const serverPrefix = source === 'server' ? (serverUrl ? stableHash(`${serverUrl}|${serverToken || ''}`) : 'default') : '';
    const { webDavConfig } = useSettingsStore.getState();
    const webdavPrefix = source === 'webdav'
        ? stableHash(`${webDavConfig?.server || ''}|${webDavConfig?.username || ''}`)
        : '';
    const DRAFT_KEY = isFlashMode
        ? `editor_draft_flash_${flashNoteId}`
        : source === 'server'
            ? `editor_draft_server_${serverPrefix}_${filePath}`
            : source === 'webdav'
                ? `editor_draft_webdav_${webdavPrefix}_${filePath}`
                : `editor_draft_${source}_${filePath}`;

    const loadFile = useCallback(async () => {
        try {
            console.log('[EditorScreen] Loading...', isFlashMode ? `FlashNote: ${flashNoteId}` : `File: ${filePath} (${source})`);

            let fileContent = '';

            if (isFlashMode) {
                // Flash Note Mode: Use passed content directly
                fileContent = paramInitialContent || '';
            } else if (source !== 'local' && paramInitialContent !== undefined) {
                // 纯在线模式（VPS / 网盘）：直接信任并复用刚拉取的预览快照，避免重复网络请求
                fileContent = paramInitialContent;
            } else if (source === 'server') {
                const res = await serverFileService.readFileContent(filePath);
                fileContent = res.content;
                currentMtimeRef.current = res.mtime;
            } else if (source === 'webdav') {
                fileContent = await cloudService.getCloudFileContent(filePath);
            } else {
                // 本地文件模式：始终从手机本地沙盒重新读取最新内容，防止覆盖后台同步拉取的最新版本
                const exists = await fsService.exists(filePath);
                if (exists) {
                    fileContent = await fsService.readFile(filePath);
                }
            }

            // Check for draft (Both modes support drafts)
            let draft = parseDraft(await AsyncStorage.getItem(DRAFT_KEY));
            if (draft === null && source === 'local' && !isFlashMode) {
                // 兼容旧版本地草稿键名，若存在则自动平滑迁移
                const legacyDraftKey = `editor_draft_${filePath}`;
                draft = parseDraft(await AsyncStorage.getItem(legacyDraftKey));
                if (draft !== null) {
                    await AsyncStorage.setItem(DRAFT_KEY, JSON.stringify({ c: draft.content, m: 0 } as DraftPayload));
                    await AsyncStorage.removeItem(legacyDraftKey);
                }
            } else if (draft === null && source === 'webdav') {
                // 兼容旧版未带账号前缀的 WebDAV 草稿键名，若存在则自动平滑迁移
                const legacyDraftKey = `editor_draft_webdav_${filePath}`;
                draft = parseDraft(await AsyncStorage.getItem(legacyDraftKey));
                if (draft !== null) {
                    await AsyncStorage.setItem(DRAFT_KEY, JSON.stringify({ c: draft.content, m: 0 } as DraftPayload));
                    await AsyncStorage.removeItem(legacyDraftKey);
                }
            } else if (draft === null && source === 'server' && serverUrl) {
                // 兼容旧版仅按服务地址哈希的 server 草稿键名（不含令牌维度），自动迁移
                const legacyServerKey = `editor_draft_server_${stableHash(serverUrl)}_${filePath}`;
                draft = parseDraft(await AsyncStorage.getItem(legacyServerKey));
                if (draft !== null) {
                    await AsyncStorage.setItem(DRAFT_KEY, JSON.stringify({ c: draft.content, m: 0 } as DraftPayload));
                    await AsyncStorage.removeItem(legacyServerKey);
                }
            }

            if (draft !== null && draft.content !== fileContent) {
                const discardDraft = async () => {
                    await AsyncStorage.removeItem(DRAFT_KEY);
                    if (source === 'local' && !isFlashMode) {
                        await AsyncStorage.removeItem(`editor_draft_${filePath}`);
                    }
                    if (source === 'webdav') {
                        await AsyncStorage.removeItem(`editor_draft_webdav_${filePath}`);
                    }
                    setContent(fileContent);
                    initialContentRef.current = fileContent;
                    isDraftLoaded.current = true;
                    webViewRef.current?.postMessage(JSON.stringify({
                        type: 'SET_CONTENT',
                        payload: fileContent,
                    }));
                };

                if (source === 'server' && !(draft.baselineMtime > 0)) {
                    // 旧版 server 草稿缺少版本基线：恢复后保存会绕过乐观锁直接覆盖服务端内容，不提供恢复
                    Alert.alert(
                        t('common.draftFound'),
                        t('editor.legacyDraftNoBaseline', { defaultValue: '检测到旧版本保存的草稿。为防止覆盖服务端最新内容，该草稿不支持一键恢复；如需保留其中内容，请先复制后再丢弃。' }),
                        [{ text: t('common.confirm'), onPress: discardDraft }]
                    );
                } else {
                    Alert.alert(
                        t('common.draftFound'),
                        t('common.restoreDraftPrompt'),
                        [
                            {
                                text: t('common.discard'),
                                style: 'destructive',
                                onPress: discardDraft,
                            },
                            {
                                text: t('common.restore'),
                                onPress: () => {
                                    // 还原草稿的基线 mtime：草稿之后文件若被外部修改，保存会触发乐观锁冲突
                                    if (draft && source === 'server' && draft.baselineMtime > 0) {
                                        currentMtimeRef.current = draft.baselineMtime;
                                    }
                                    setContent(draft ? draft.content : fileContent);
                                    initialContentRef.current = fileContent; // Initial is still origin content
                                    setIsDirty(true); // Draft implies dirty
                                    isDraftLoaded.current = true;
                                    webViewRef.current?.postMessage(JSON.stringify({
                                        type: 'SET_CONTENT',
                                        payload: draft ? draft.content : fileContent,
                                    }));
                                },
                            },
                        ]
                    );
                }
            } else {
                setContent(fileContent);
                initialContentRef.current = fileContent;
                isDraftLoaded.current = true;
            }

        } catch (error) {
            console.error('[EditorScreen] Error loading content:', error);
            Alert.alert(t('editor.loadFileFailed'), JSON.stringify(error));
            setContent('');
            initialContentRef.current = '';
            isDraftLoaded.current = true;
        } finally {
            setLoading(false);
        }
    }, [filePath, DRAFT_KEY, serverUrl, t, isFlashMode, flashNoteId, paramInitialContent, source]);

    useEffect(() => {
        loadFile();
    }, [loadFile]);

    // Load editor HTML from generated TS file (Vite build output)
    useEffect(() => {
        const loadEditor = async () => {
            // In the new build system, editorHtml is a string constant import. 
            // We use require to avoid top-level import issues if the file doesn't exist yet (though it should after build).
            try {
                const { editorHtml: htmlContent } = require('../editor-web/editorHtml');
                setEditorHtml(htmlContent);
            } catch (e) {
                console.error('Failed to load editorHtml.ts. Did you run npm run build:editor?', e);
                Alert.alert(t('common.error'), t('editor.buildMissing'));
            }
        };
        loadEditor();
    }, [t]);

    // Debounced Auto-save to Cache
    useEffect(() => {
        if (!isDraftLoaded.current) return;

        const saveDraft = async () => {
            try {
                // Only save draft if dirty
                if (isDirty) {
                    // 内容与基线 mtime 以单键 JSON 原子写入，避免分开写入中断产生无基线草稿
                    await AsyncStorage.setItem(DRAFT_KEY, JSON.stringify({ c: content, m: currentMtimeRef.current ?? 0 } as DraftPayload));
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
        // 阻断保存进行中的重复触发（连点保存按钮、WebView 重复回调），避免并发保存与重复成功提示
        if (saveInFlightRef.current) return;
        saveInFlightRef.current = true;
        setIsSaving(true);
        try {
            if (isFlashMode && flashNoteId) {
                // --- Flash Note Save Logic ---
                if (flashNoteId === 'new') {
                    await flashNoteService.addNote(contentToSave);
                } else {
                    await flashNoteService.updateNote(flashNoteId, contentToSave);
                }
                Alert.alert(t('common.success'), t('timeline.noteUpdated')); // Feedback for user
            } else if (source === 'server') {
                // --- Server File Save Logic ---
                const saveRes = await serverFileService.saveFileContent(filePath, contentToSave, currentMtimeRef.current);
                currentMtimeRef.current = saveRes.mtime;
                Alert.alert(t('common.success'), t('editor.savedSuccessfully', { defaultValue: '已成功保存至服务端' }));
            } else if (source === 'webdav') {
                // --- Pure Online WebDAV Save Logic ---
                await cloudService.uploadContent(filePath, contentToSave);
                Alert.alert(t('common.success'), t('editor.savedSuccessfully', { defaultValue: '已成功保存至网盘' }));
            } else {
                // --- Standard File Save Logic ---
                // 手动保存：写本地 + 触发云同步
                await fsService.writeFile(filePath, contentToSave);
                markFileAsModified(filePath);

                // Upload to cloud if configured (wait for upload to complete before navigating back)
                const success = await syncService.uploadFile(filePath, { withLock: true });
                if (!success) {
                    const metadata = useFileMetadataStore.getState().getMetadata(filePath);
                    if (metadata?.uploadState === 'conflict-failed' || metadata?.uploadState === 'failed') {
                        Alert.alert(t('editor.uploadFailedTitle'), t('editor.uploadFailedMessage'));
                    }
                }
            }

            // Common Post-Save Cleanup
            await AsyncStorage.removeItem(DRAFT_KEY);
            if (source === 'local' && !isFlashMode) {
                await AsyncStorage.removeItem(`editor_draft_${filePath}`);
            }
            if (source === 'webdav') {
                await AsyncStorage.removeItem(`editor_draft_webdav_${filePath}`);
            }
            setIsDirty(false);
            setContent(contentToSave);
            initialContentRef.current = contentToSave;

            // Navigate back
            navigation.goBack();

        } catch (error: unknown) {
            console.error('Save failed:', error);
            const serverErr = error as { code?: string; message?: string };
            if (serverErr.code === 'PRECONDITION_FAILED') {
                Alert.alert(
                    t('common.conflict', { defaultValue: '保存冲突' }),
                    t('editor.conflictMtimeMessage', { defaultValue: '服务端该文件在您编辑期间已被外部修改。为防止覆盖他人内容，本次保存已被阻止。建议先返回重新进入。' })
                );
            } else {
                // 结构化错误码经国际化映射后再提示，避免直接透出服务层硬编码文案
                let message = (error as Error).message || t('editor.saveFailed');
                if (serverErr.code) {
                    message = t(`browser.error.${serverErr.code}`, { defaultValue: message });
                }
                Alert.alert(t('common.error'), message);
            }
        } finally {
            saveInFlightRef.current = false;
            setIsSaving(false);
        }
    }, [filePath, markFileAsModified, DRAFT_KEY, navigation, isFlashMode, flashNoteId, source, t]);

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
                            if (source === 'local' && !isFlashMode) {
                                await AsyncStorage.removeItem(`editor_draft_${filePath}`);
                            }
                            if (source === 'webdav') {
                                await AsyncStorage.removeItem(`editor_draft_webdav_${filePath}`);
                            }
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
    }, [isDirty, content, DRAFT_KEY, navigation, t, handleManualSave, filePath, isFlashMode, source]);

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
            headerTitle: isFlashMode
                ? (t('timeline.editTitle') || 'Edit Note') // Fallback translation
                : undefined // Default behavior (usually route param title, but we customize it below in container)
        });
    }, [navigation, headerLeft, isFlashMode, t]);


    const onWebViewMessage = (event: any) => {
        try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data.type === 'ON_CHANGE') {
                handleAutoSave(data.payload);
            } else if (data.type === 'CONTENT_RESULT') {
                handleManualSave(data.payload);
            } else if (data.type === 'ON_READY') {
                // Editor is ready, send initial content
                if (webViewRef.current) {
                    const payload = {
                        type: 'INITIAL_LOAD_DATA',
                        payload: {
                            content: content,
                            placeholder: t('editor.placeholder'),
                            autoFocus: false, // Let user tap to focus
                            theme: 'light' // TODO: wire up dark mode based on system scheme
                        }
                    };
                    webViewRef.current.postMessage(JSON.stringify(payload));
                }
            } else if (data.type === 'log') {
                console.log('[WebView Log]', data.payload);
            } else if (data.type === 'ERROR') {
                console.error('[WebView Error]', data.payload);
            }
        } catch {
            // Compatible with legacy strings if any (shouldn't happen with new build)
            console.warn('Received non-JSON message from WebView');
        }
    };

    const requestSaveFromWebView = () => {
        // Send JSON request
        webViewRef.current?.postMessage(JSON.stringify({ type: 'GET_CONTENT' }));
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
                        {isFlashMode ? (t('timeline.editTitle') || 'Edit Note') : (title || filePath.split('/').pop() || filePath)}
                    </Text>
                </View>
                <TouchableOpacity
                    onPress={requestSaveFromWebView}
                    style={styles.headerButton}
                    disabled={!isDirty || isSaving}
                >
                    <Text style={[
                        styles.headerButtonText,
                        (!isDirty || isSaving) && styles.headerButtonTextDisabled
                    ]}>{t('common.save')}</Text>
                </TouchableOpacity>
            </View>

            <WebView
                ref={webViewRef}
                source={{ html: editorHtml, baseUrl: '' }}
                originWhitelist={['*']}
                onMessage={onWebViewMessage}
                // Removed onLoadEnd as we now wait for ON_READY message from the app
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


