import React, { useEffect, useState, useRef, useCallback, type ComponentRef } from 'react';
import { View, StyleSheet, ActivityIndicator, Alert, TouchableOpacity, Text, BackHandler } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, useNavigation, usePreventRemove, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { EnrichedMarkdownTextInputInstance } from 'react-native-enriched-markdown';
import { FlashNoteRichInput } from '../components/FlashNoteRichInput';
import AsyncStorage from '@react-native-async-storage/async-storage';
// import { Asset } from 'expo-asset'; // Removed
// import { File } from 'expo-file-system/next'; // Removed
import { RootStackParamList } from '../types/navigation';
import { fsService } from '../services/FileSystemService';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { theme } from '../utils/theme';
import { useSettingsFont } from '../components/settings';
import { normalizePath } from '../utils/pathUtils';
import { stableHash } from '../utils/identityHash';
import { syncService } from '../services/SyncService';
import { flashNoteService } from '../services/FlashNoteService';
import { serverFileService } from '../services/ServerFileService';
import { cloudService } from '../services/CloudService';
import { useAssistantStore } from '../store/useAssistantStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { getFontSizeMetrics } from '../utils/fontSize';
import * as Clipboard from 'expo-clipboard';

type EditorScreenRouteProp = RouteProp<RootStackParamList, 'Editor' | 'FlashNoteEditor'>;
type FlashEditorMode = 'checking' | 'rich' | 'source';

// 草稿载荷：内容与基线 mtime 以单键 JSON 原子存储，避免分开写入中断产生无基线草稿
interface DraftPayload {
    c: string;
    m: number;
}

const parseDraft = (raw: string | null): { content: string; baselineMtime: number } | null => {
    if (raw === null) return null;
    try {
        const parsed = JSON.parse(raw) as DraftPayload;
        // 内容与基线字段同时齐备才按新格式解析，避免旧纯文本草稿恰好是 JSON 对象时被误读
        if (typeof parsed.c === 'string' && typeof parsed.m === 'number') {
            return { content: parsed.c, baselineMtime: parsed.m > 0 ? parsed.m : 0 };
        }
    } catch {
        // 旧版以纯文本存储内容：可用但缺少基线
    }
    return { content: raw, baselineMtime: 0 };
};

// Helper Component for Header Button
const HeaderBackButton = ({ onPress, text }: { onPress: () => void, text: string }) => {
    const font = useSettingsFont();
    return (
    <TouchableOpacity onPress={onPress} style={styles.headerButton}>
        <Text style={[styles.headerButtonText, { fontSize: font.chatBody }]}>{text}</Text>
    </TouchableOpacity>
    );
};

export const EditorScreen = () => {
    const font = useSettingsFont();
    const route = useRoute<EditorScreenRouteProp>();
    const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
    const { t } = useTranslation();
    const flashParams = 'flashNoteId' in route.params ? route.params : undefined;
    const { flashNoteId, noteFilePath, fromShare } = flashParams ?? {};
    const { filePath: rawFilePath = '', source = 'local', title, expectedMtime: paramExpectedMtime } =
        'filePath' in route.params ? route.params : {};
    const { initialContent: paramInitialContent } = route.params;
    const filePath = source === 'server' ? rawFilePath : normalizePath(rawFilePath);
    const currentMtimeRef = useRef<number | undefined>(paramExpectedMtime);
    const serverUrl = useAssistantStore(state => source === 'server' ? state.serverUrl : undefined);
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const [isDirty, setIsDirty] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const saveInFlightRef = useRef(false);
    const [editorHtml, setEditorHtml] = useState<string | null>(null);
    const webViewRef = useRef<ComponentRef<typeof WebView>>(null);
    const richInputRef = useRef<EnrichedMarkdownTextInputInstance | null>(null);
    const [flashEditorMode, setFlashEditorMode] = useState<FlashEditorMode>('checking');
    const [flashInitialContent, setFlashInitialContent] = useState('');
    const [sourceReady, setSourceReady] = useState(false);
    const [flashExitApproved, setFlashExitApproved] = useState(false);
    const flashDraftWrite = useRef<Promise<void>>(Promise.resolve());
    const restoredLegacyDraftKey = useRef<string | null>(null);
    const flashSaveCommitted = useRef(false);
    const isDraftLoaded = useRef(false);
    const initialContentRef = useRef<string>('');

    const { markFileAsModified } = useFileMetadataStore();
    const { fontSize } = useSettingsStore();
    const editorFontSize = getFontSizeMetrics(fontSize).editorFontSize;

    const isFlashMode = flashParams !== undefined;
    const isNewFlash = flashNoteId === 'new';
    const legacyFlashDraftKey = !isFlashMode || fromShare ? null : isNewFlash
        ? 'flash_note_draft_new'
        : `flash_note_draft_edit_${flashNoteId}`;
    const flashTitle = t(isNewFlash ? 'timeline.newTitle' : 'timeline.editTitle');
    const canSaveFlash = Boolean(content.trim()) && (isNewFlash || isDirty)
        && (flashEditorMode === 'rich' || (flashEditorMode === 'source' && sourceReady));
    const markRichEditorReady = useCallback(() => setFlashEditorMode('rich'), []);
    const showSourceEditor = useCallback(() => setFlashEditorMode('source'), []);
    const { serverToken } = useAssistantStore.getState();
    // 服务前缀含地址与令牌：同地址换令牌（重装、反代按令牌选实例）视为不同服务，草稿互不串用
    const serverPrefix = source === 'server' ? (serverUrl ? stableHash(`${serverUrl}|${serverToken || ''}`) : 'default') : '';
    const { webDavConfig } = useSettingsStore.getState();
    const webdavPrefix = source === 'webdav'
        ? stableHash(`${webDavConfig?.server || ''}|${webDavConfig?.username || ''}`)
        : '';
    const DRAFT_KEY = isFlashMode
        ? fromShare
            ? `editor_draft_flash_share_${stableHash(paramInitialContent ?? '')}`
            : `editor_draft_flash_${flashNoteId}`
        : source === 'server'
            ? `editor_draft_server_${serverPrefix}_${filePath}`
            : source === 'webdav'
                ? `editor_draft_webdav_${webdavPrefix}_${filePath}`
                : `editor_draft_${source}_${filePath}`;

    const queueFlashDraftOperation = useCallback((operation: () => Promise<void>) => {
        const result = flashDraftWrite.current.then(operation);
        flashDraftWrite.current = result.catch(() => {});
        return result;
    }, []);
    const clearFlashDraft = useCallback(() => queueFlashDraftOperation(async () => {
        const legacy = restoredLegacyDraftKey.current;
        await AsyncStorage.multiRemove(legacy ? [DRAFT_KEY, legacy] : [DRAFT_KEY]);
        restoredLegacyDraftKey.current = null;
    }), [DRAFT_KEY, queueFlashDraftOperation]);

    const loadFile = useCallback(async () => {
        const openFlashEditor = (original: string, draft?: string) => {
            const initial = draft ?? original;
            initialContentRef.current = original;
            isDraftLoaded.current = true;
            setContent(initial);
            setIsDirty(initial !== original);
            setFlashInitialContent(initial);
            setFlashEditorMode(initial === '' ? 'rich' : 'checking');
            setLoading(false);
        };
        try {
            console.log('[EditorScreen] Loading...', isFlashMode ? `FlashNote: ${flashNoteId}` : `File: ${filePath} (${source})`);

            let fileContent = '';

            if (isFlashMode) {
                const original = paramInitialContent ?? '';
                let draft = parseDraft(await AsyncStorage.getItem(DRAFT_KEY))?.content;
                if (draft === undefined && legacyFlashDraftKey !== null) {
                    const legacy = await AsyncStorage.getItem(legacyFlashDraftKey);
                    if (legacy !== null) {
                        restoredLegacyDraftKey.current = legacyFlashDraftKey;
                        draft = legacy;
                    }
                }
                if (draft === undefined || draft === original) {
                    openFlashEditor(original);
                } else {
                    Alert.alert(t('common.draftFound'), t('common.restoreDraftPrompt'), [
                        {
                            text: t('common.discard'),
                            style: 'destructive',
                            onPress: () => {
                                clearFlashDraft().then(() => openFlashEditor(original), () => {
                                    Alert.alert(t('common.error'), t('timeline.saveError'));
                                    openFlashEditor(original, draft);
                                });
                            },
                        },
                        { text: t('common.restore'), onPress: () => openFlashEditor(original, draft) },
                    ], { cancelable: false });
                }
                return;
            }
            if (source !== 'local' && paramInitialContent !== undefined) {
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

            // 恢复文件草稿并兼容旧键名
            let draft = parseDraft(await AsyncStorage.getItem(DRAFT_KEY));
            if (draft === null && source === 'local') {
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
                    if (source === 'local') {
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
                    // 旧版 server 草稿缺少版本基线：恢复后保存会绕过乐观锁直接覆盖服务端内容，不提供恢复；
                    // 草稿内容当前界面不可见，先提供「复制到剪贴板」再丢弃，避免内容无处保留即被销毁
                    const legacyDraftContent = draft.content;
                    Alert.alert(
                        t('common.draftFound'),
                        t('common.legacyDraftNoBaseline'),
                        [
                            {
                                text: t('common.copyThenDiscard', { defaultValue: '复制后丢弃' }),
                                onPress: async () => {
                                    await Clipboard.setStringAsync(legacyDraftContent);
                                    await discardDraft();
                                    Alert.alert(t('common.tip'), t('common.draftCopied', { defaultValue: '草稿内容已复制到剪贴板' }));
                                },
                            },
                            {
                                text: t('common.discard'),
                                style: 'destructive',
                                onPress: discardDraft,
                            },
                        ]
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
            if (isFlashMode) {
                openFlashEditor(paramInitialContent ?? '');
            } else {
                setContent('');
                initialContentRef.current = '';
                isDraftLoaded.current = true;
            }
        } finally {
            if (!isFlashMode) setLoading(false);
        }
    }, [filePath, DRAFT_KEY, serverUrl, t, isFlashMode, flashNoteId, paramInitialContent, source, legacyFlashDraftKey, clearFlashDraft]);

    useEffect(() => {
        loadFile();
    }, [loadFile]);

    // Load editor HTML from generated TS file (Vite build output)
    useEffect(() => {
        if (isFlashMode && flashEditorMode !== 'source') return;
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
    }, [t, isFlashMode, flashEditorMode]);

    // Debounced Auto-save to Cache
    useEffect(() => {
        if (!isDraftLoaded.current) return;

        const saveDraft = async () => {
            try {
                // 内容与基线 mtime 以单键 JSON 原子存储。
                const draft = JSON.stringify({ c: content, m: currentMtimeRef.current ?? 0 } as DraftPayload);
                if (isFlashMode) {
                    if (saveInFlightRef.current || flashSaveCommitted.current) return;
                    if (!isDirty) {
                        await clearFlashDraft();
                        return;
                    }
                    await queueFlashDraftOperation(() => AsyncStorage.setItem(DRAFT_KEY, draft));
                } else if (isDirty) {
                    await AsyncStorage.setItem(DRAFT_KEY, draft);
                }
            } catch (error) {
                console.error('Failed to save draft:', error);
            }
        };

        const timeoutId = setTimeout(saveDraft, 500);
        return () => clearTimeout(timeoutId);
    }, [content, isDirty, DRAFT_KEY, isFlashMode, clearFlashDraft, queueFlashDraftOperation]);

    const handleAutoSave = useCallback((newContent: string) => {
        setContent(newContent);
        setIsDirty(newContent !== initialContentRef.current);
    }, []);

    const handleManualSave = useCallback(async (contentToSave: string) => {
        // 阻断保存进行中的重复触发（连点保存按钮、WebView 重复回调），避免并发保存与重复成功提示
        if (saveInFlightRef.current || flashSaveCommitted.current || (isFlashMode && !contentToSave.trim())) return;
        saveInFlightRef.current = true;
        setIsSaving(true);
        try {
            if (isFlashMode && flashNoteId) {
                // --- Flash Note Save Logic ---
                if (flashNoteId === 'new') {
                    await flashNoteService.addNote(contentToSave);
                } else {
                    await flashNoteService.updateNote(flashNoteId, contentToSave, noteFilePath);
                }
                flashSaveCommitted.current = true;
                // 正文已保存，独立处理清草稿失败，避免重试时再次追加相同闪念。
                await clearFlashDraft().catch(error => console.error('[EditorScreen] Failed to clear flash draft:', error));
                setFlashExitApproved(true);
                return;
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
            if (source === 'local') {
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
            if (isFlashMode) {
                Alert.alert(t('common.error'), t('timeline.saveError'));
            } else if (serverErr.code === 'PRECONDITION_FAILED') {
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
    }, [filePath, markFileAsModified, DRAFT_KEY, navigation, isFlashMode, flashNoteId, source, t, clearFlashDraft, noteFilePath]);

    const requestSaveFromWebView = () => {
        webViewRef.current?.postMessage(JSON.stringify({ type: 'GET_CONTENT' }));
    };

    const requestSave = () => {
        if (saveInFlightRef.current || flashSaveCommitted.current) return;
        if (!isFlashMode || flashEditorMode === 'source') {
            requestSaveFromWebView();
        } else if (flashEditorMode === 'rich') {
            richInputRef.current?.getMarkdown().then(handleManualSave, () => {
                Alert.alert(t('common.error'), t('timeline.saveError'));
            });
        }
    };

    usePreventRemove(isFlashMode && !flashExitApproved && (isDirty || isSaving), ({ data }) => {
        if (saveInFlightRef.current) return;
        const choices = [
            {
                text: t('common.dontSave'),
                style: 'destructive' as const,
                onPress: () => {
                    saveInFlightRef.current = true;
                    clearFlashDraft().then(() => navigation.dispatch(data.action), () => {
                        saveInFlightRef.current = false;
                        Alert.alert(t('common.error'), t('timeline.saveError'));
                    });
                },
            },
            { text: t('common.cancel'), style: 'cancel' as const },
        ];
        Alert.alert(t('common.confirm'), t('common.saveChangesPrompt'),
            canSaveFlash ? [...choices, { text: t('common.save'), onPress: requestSave }] : choices);
    });

    useEffect(() => {
        if (flashExitApproved) navigation.goBack();
    }, [flashExitApproved, navigation]);

    const handleBackPress = useCallback(() => {
        if (isFlashMode) return false;
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
                            if (source === 'local') {
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
        if (isFlashMode) return;
        const backHandler = BackHandler.addEventListener('hardwareBackPress', handleBackPress);
        return () => backHandler.remove();
    }, [handleBackPress, isFlashMode]);

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
            headerTitle: isFlashMode ? flashTitle : undefined
        });
    }, [navigation, headerLeft, isFlashMode, flashTitle]);


    const onWebViewMessage = (event: WebViewMessageEvent) => {
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
                            placeholder: t(isFlashMode ? 'timeline.placeholder' : 'editor.placeholder'),
                            autoFocus: isFlashMode,
                            compactSpacing: isFlashMode,
                            theme: 'light' // TODO: wire up dark mode based on system scheme
                        }
                    };
                    webViewRef.current.postMessage(JSON.stringify(payload));
                    if (isFlashMode) setSourceReady(true);
                    webViewRef.current.postMessage(JSON.stringify({
                        type: 'UPDATE_SETTINGS',
                        payload: {
                            theme: 'light',
                            fontSize: editorFontSize,
                        }
                    }));
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

    const showRichInput = isFlashMode && flashEditorMode !== 'source';
    const saveDisabled = (isFlashMode ? !canSaveFlash : !isDirty) || isSaving;

    if (loading || (!showRichInput && !editorHtml)) {
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
                    <Text style={[styles.headerButtonText, { fontSize: font.chatBody }]}>{t('common.back')}</Text>
                </TouchableOpacity>
                <View style={styles.titleContainer}>
                    <Text style={[styles.title, { fontSize: font.chatBody }]} numberOfLines={2}>
                        {isFlashMode ? flashTitle : (title || filePath.split('/').pop() || filePath)}
                    </Text>
                </View>
                <TouchableOpacity
                    onPress={requestSave}
                    style={styles.headerButton}
                    disabled={saveDisabled}
                >
                    <Text style={[
                        styles.headerButtonText,
                        saveDisabled && styles.headerButtonTextDisabled,
                        { fontSize: font.chatBody },
                    ]}>{t('common.save')}</Text>
                </TouchableOpacity>
            </View>

            {showRichInput ? (
                <FlashNoteRichInput
                    editorRef={richInputRef}
                    initialContent={flashInitialContent}
                    onChange={handleAutoSave}
                    onReady={markRichEditorReady}
                    onUnsupported={showSourceEditor}
                />
            ) : (
                <WebView
                    ref={webViewRef}
                    source={{ html: editorHtml ?? '', baseUrl: '' }}
                    originWhitelist={['*']}
                    onMessage={onWebViewMessage}
                    keyboardDisplayRequiresUserAction={!isFlashMode}
                    style={styles.webview}
                />
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
        marginHorizontal: theme.spacing.s,
        flexShrink: 1,
        textAlign: 'center',
    },
    webview: {
        flex: 1,
    },
});


