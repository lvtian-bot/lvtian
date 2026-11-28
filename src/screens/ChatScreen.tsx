import React, { useState, useEffect, useRef, useCallback, useContext, useMemo, forwardRef, type ComponentRef } from 'react';
import {
    View,
    Text,
    Image,
    StyleSheet,
    TextInput,
    TouchableOpacity,
    Pressable,
    BackHandler,
    FlatList,
    ScrollView,
    ActivityIndicator,
    Alert,
    Platform,
    AppState,
    Keyboard,
    type LayoutChangeEvent,
    type ScrollViewProps,
    type NativeSyntheticEvent,
    type NativeScrollEvent,
} from 'react-native';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    useReducedMotion,
    interpolate,
} from 'react-native-reanimated';
import {
    KeyboardChatScrollView,
    KeyboardStickyView,
    useReanimatedKeyboardAnimation,
    type KeyboardChatScrollViewProps,
} from 'react-native-keyboard-controller';
import { useTranslation } from 'react-i18next';
import { useNavigation, type RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { fsService } from '../services/FileSystemService';
import Icon from '@expo/vector-icons/MaterialIcons';
import { ChatMarkdownBubble } from '../components/ChatMarkdownBubble';
import { ChatBubbleReveal } from '../components/ChatBubbleReveal';
import { ImageViewerModal } from '../components/ImageViewerModal';
import { TabBarHeightContext } from '../navigation/TabBarHeightContext';
import { textInputColors, theme } from '../utils/theme';
import {
    getInvertedChatScrollTarget,
    getInvertedDistanceFromBottom,
    shouldShowChatScrollBottom,
} from '../utils/chatScrollMetrics';
import { useAssistantStore } from '../store/useAssistantStore';
import { TypingIndicator } from '../components/TypingIndicator';
import { AssistantClient } from '../services/AssistantClient';
import { getChatTimeline, ChatTimelineMessage } from '../utils/chatTimeline';
import { AssistantMessage, ChatAttachment } from '../types/assistantProtocol';
import { getAssistantDisplayParts } from '../utils/assistantMessageParts';
import { isAttachmentBudgetExceeded } from '../utils/attachmentBudget';
import { ChatMessageMenu, type MessageAction, type MessageMenuAnchor } from '../components/ChatMessageMenu';
import { ChatBubbleText } from '../components/ChatBubbleText';
import { formatChatDate, formatChatTime, isPlainChatText, startsChatDay } from '../utils/chatDate';
import { ChatStackParamList, RootStackParamList } from '../types/navigation';
import { useSettingsStore } from '../store/useSettingsStore';
import { getFontSizeMetrics, auxFontSizes } from '../utils/fontSize';
import i18n from '../i18n';
import { useChatConnectionPresentation } from '../hooks/useChatConnectionPresentation';
import { connectionErrorKey } from '../utils/connectionErrorPresentation';
import { chatServerIdentity, readNotificationReply } from '../services/chatNotifications';
import { ConnectionConfigError } from '../services/connectionConfig';

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;
const TYPING_INDICATOR_DELAY_MS = 1000;

/** 服务端稳定错误码 → i18n 键：按码本地化渲染，未知码与历史中文文案按原文兜底显示 */
const ERROR_CODE_I18N_KEYS: Record<string, string> = {
    task_stopped: 'assistant.errorTaskStopped',
    approval_timeout: 'assistant.errorApprovalTimeout',
    engine_refusal: 'assistant.errorEngineRefusal',
    engine_error: 'assistant.errorEngineError',
    task_timeout: 'assistant.errorEngineError',
    service_upgrading: 'assistant.errorServiceUpgrading',
    task_cancelled: 'assistant.errorTaskCancelled',
    service_restarted: 'assistant.errorServiceRestarted',
};

const translateErrorMessage = (message: string): string => {
    const key = ERROR_CODE_I18N_KEYS[message];
    return key ? i18n.t(key, { defaultValue: message }) : message;
};
const ChatScrollView = forwardRef<
    ComponentRef<typeof KeyboardChatScrollView>,
    ScrollViewProps & KeyboardChatScrollViewProps
>((props, ref) => {
    const tabBarHeight = useContext(TabBarHeightContext);

    return (
        <KeyboardChatScrollView
            ref={ref}
            {...props}
            inverted={true}
            automaticallyAdjustContentInsets={false}
            contentInsetAdjustmentBehavior="never"
            keyboardDismissMode="interactive"
            offset={tabBarHeight}
        />
    );
});
ChatScrollView.displayName = 'ChatScrollView';

export const ChatScreen = ({ route }: { route?: RouteProp<ChatStackParamList, 'ChatScreen'> } = {}) => {
    const { t, i18n: chatI18n } = useTranslation();
    const [dateNow, setDateNow] = useState(Date.now);
    useEffect(() => {
        const refresh = () => setDateNow(Date.now());
        const timer = setInterval(refresh, 60_000);
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') refresh();
        });
        return () => { clearInterval(timer); subscription.remove(); };
    }, []);
    const navigation = useNavigation<NavigationProp>();
    const tabBarHeight = useContext(TabBarHeightContext);
    const { fontSize } = useSettingsStore();
    const metrics = useMemo(() => getFontSizeMetrics(fontSize), [fontSize]);

    const flatListRef = useRef<FlatList<ChatTimelineMessage>>(null);
    const chatInputRef = useRef<ComponentRef<typeof TextInput>>(null);
    const contentInsetsRef = useRef<{ top: number; bottom: number }>({ top: 0, bottom: 0 });
    const scrollOffset = useRef<number | undefined>(undefined);
    const entranceMessageId = useRef<string | undefined>(undefined);
    const reduceMotion = useReducedMotion();
    const extraContentPadding = useSharedValue(0);
    const composerHeight = useSharedValue(60);

    // 监听应用切回前台（热启动）：彻底阻止软键盘误触自动弹出（前台重连由 AssistantClient 统一守护）
    useEffect(() => {
        const subscription = AppState.addEventListener('change', (nextAppState) => {
            if (nextAppState === 'active') {
                chatInputRef.current?.blur();
            }
        });
        return () => {
            subscription.remove();
        };
    }, []);


    const handleComposerLayout = useCallback((event: LayoutChangeEvent) => {
        composerHeight.value = event.nativeEvent.layout.height;
    }, [composerHeight]);

    const { height: keyboardHeight, progress: keyboardProgress } = useReanimatedKeyboardAnimation();
    const animatedScrollBottomStyle = useAnimatedStyle(() => {
        const offset = interpolate(keyboardProgress.value, [0, 1], [0, tabBarHeight]);
        const translateY = -(composerHeight.value + 12) + (keyboardHeight.value + offset);
        return {
            transform: [{ translateY }],
        };
    }, [tabBarHeight]);

    const handleInputLayout = useCallback((event: LayoutChangeEvent) => {
        extraContentPadding.value = Math.max(event.nativeEvent.layout.height - 40, 0);
    }, [extraContentPadding]);
    const handleContentInsetChange = useCallback(
        (insets: Parameters<NonNullable<KeyboardChatScrollViewProps['onContentInsetChange']>>[0]) => {
            contentInsetsRef.current = { top: insets.top, bottom: insets.bottom };
        },
        [],
    );
    const renderChatScrollComponent = useCallback(
        (props: ScrollViewProps) => (
            <ChatScrollView
                {...props}
                extraContentPadding={extraContentPadding}
                onContentInsetChange={handleContentInsetChange}
            />
        ),
        [extraContentPadding, handleContentInsetChange],
    );

    const {
        serverUrl,
        serverToken,
        credentialsStatus,
        credentialsError,
        loadSavedCredentials,
        connectionState,
        isServerUpgrading,
        messages,
        clearedSeq,
        taskState,
        pendingApprovals,
        pendingSendQueue,
        skills,
        setServerConfig,
    } = useAssistantStore();
    const { banner, retryConnection } = useChatConnectionPresentation();

    const [inputContent, setInputContent] = useState('');
    const [retryingStorage, setRetryingStorage] = useState(false);
    const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
    const [submittedId, setSubmittedId] = useState<string>();
    const taskRunning = taskState === 'processing' || taskState === 'awaiting_approval';
    const [showTypingIndicator, setShowTypingIndicator] = useState(false);
    useEffect(() => {
        if (!taskRunning) {
            setShowTypingIndicator(false);
            return;
        }
        const timer = setTimeout(() => setShowTypingIndicator(true), TYPING_INDICATOR_DELAY_MS);
        return () => clearTimeout(timer);
    }, [taskRunning]);
    const submittedStatus = submittedId ? messages.find(message => message.id === submittedId)?.status : undefined;
    const awaitingStart = Boolean(submittedId) && !taskRunning && connectionState === 'connected' && !isServerUpgrading
        && (submittedStatus === 'sending' || submittedStatus === 'sent');
    useEffect(() => {
        if (!submittedId) return;
        if (!awaitingStart) {
            setSubmittedId(undefined);
        } else if (submittedStatus === 'sent') {
            // A duplicate acknowledgement may have no following task event.
            const timer = setTimeout(() => setSubmittedId(undefined), 500);
            return () => clearTimeout(timer);
        }
    }, [submittedId, submittedStatus, awaitingStart]);
    const [previewImageUri, setPreviewImageUri] = useState<string | null>(null);
    const pendingAttachmentsRef = useRef<ChatAttachment[]>([]);
    const updatePendingAttachments = useCallback((attachments: ChatAttachment[]) => {
        pendingAttachmentsRef.current = attachments;
        setPendingAttachments(attachments);
    }, []);
    const appendPendingAttachments = useCallback((newAttachments: ChatAttachment[]) => {
        // 服务端上限 30MiB；附件按实际 JSON UTF-8 字节计入 20MiB 预算，为正文及协议预留余量。
        const attachments = [...pendingAttachmentsRef.current, ...newAttachments];
        if (isAttachmentBudgetExceeded(attachments)) {
            Alert.alert(t('common.notice', '提示'), t('chat.attachmentTooLarge', '附件体积过大（上限 10MB）'));
            return;
        }
        updatePendingAttachments(attachments);
    }, [t, updatePendingAttachments]);
    const appendPendingAttachment = useCallback((attachment: ChatAttachment) => {
        appendPendingAttachments([attachment]);
    }, [appendPendingAttachments]);
    const [isAttachMenuVisible, setIsAttachMenuVisible] = useState(false);
    const [toastMessage, setToastMessage] = useState<string | null>(null);
    const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showToast = useCallback((msg: string) => {
        if (toastTimeoutRef.current) {
            clearTimeout(toastTimeoutRef.current);
        }
        setToastMessage(msg);
        toastTimeoutRef.current = setTimeout(() => {
            setToastMessage(null);
            toastTimeoutRef.current = null;
        }, 2000);
    }, []);

    useEffect(() => {
        return () => {
            if (toastTimeoutRef.current) {
                clearTimeout(toastTimeoutRef.current);
            }
        };
    }, []);

    const handleResendMessage = useCallback(async (messageId: string) => {
        setSelecting(undefined);
        const result = await AssistantClient.getInstance().retryPendingMessage(messageId);
        if (!result.ok && result.errorMessage) {
            showToast(result.errorMessage);
        }
    }, [showToast]);

    useEffect(() => {
        if (connectionState === 'connected') {
            AssistantClient.getInstance().fetchSkills().catch(() => {});
        }
    }, [connectionState]);

    const showSlashMenu = useMemo(() => {
        return inputContent.startsWith('/') && !inputContent.includes(' ') && !inputContent.includes('\n');
    }, [inputContent]);

    const filterText = useMemo(() => {
        return showSlashMenu ? inputContent.slice(1).toLowerCase().trim() : '';
    }, [showSlashMenu, inputContent]);

    const filteredSlashItems = useMemo(() => {
        if (!showSlashMenu) return [];
        const all: Array<{
            id: string;
            type: 'command' | 'skill';
            name: string;
            label: string;
            description: string;
            icon: keyof typeof Icon.glyphMap;
        }> = [
            {
                id: 'cmd-new',
                type: 'command',
                name: 'new',
                label: '/new',
                description: t('assistant.commandNewDesc', '重置会话上下文'),
                icon: 'restart-alt',
            },
            ...skills.map((s) => ({
                id: `skill-${s.name}`,
                type: 'skill' as const,
                name: s.name,
                label: `/${s.name}`,
                description: s.description || s.name,
                icon: 'extension' as const,
            })),
        ];
        if (!filterText) return all;
        return all.filter(
            (item) =>
                item.name.toLowerCase().includes(filterText) ||
                item.description.toLowerCase().includes(filterText)
        );
    }, [showSlashMenu, filterText, skills, t]);

    const handleSelectSlashItem = useCallback(async (item: { name: string; type: 'command' | 'skill' }) => {
        if (item.name === 'new') {
            setInputContent('');
            try {
                const ok = await AssistantClient.getInstance().resetSession();
                if (ok) {
                    showToast(t('assistant.sessionResetToast', '上下文已重置'));
                } else {
                    showToast(t('assistant.sessionResetFailed', '重置上下文失败，请稍后重试'));
                }
            } catch (err) {
                console.warn('[ChatScreen] resetSession failed:', err);
                showToast(t('assistant.sessionResetFailed', '重置上下文失败，请稍后重试'));
            }
        } else {
            setInputContent(`/${item.name} `);
            chatInputRef.current?.focus();
        }
    }, [showToast, t]);

    const [showScrollBottom, setShowScrollBottom] = useState(false);
    const scrollGestureRef = useRef({ active: false, startDistance: Number.NaN });
    useEffect(() => {
        // Keyboard/layout movement is not evidence that the user is browsing history.
        const cancelGesture = () => {
            scrollGestureRef.current = { active: false, startDistance: Number.NaN };
        };
        // Interactive keyboard dismissal can be part of an intentional history drag.
        // Keep that drag alive, but discard keyboard-induced distance changes.
        const rebaseGesture = () => {
            scrollGestureRef.current.startDistance = Number.NaN;
        };
        const subscriptions = [
            Keyboard.addListener('keyboardWillShow', cancelGesture),
            Keyboard.addListener('keyboardDidShow', cancelGesture),
            Keyboard.addListener('keyboardWillHide', rebaseGesture),
            Keyboard.addListener('keyboardDidHide', rebaseGesture),
        ];
        return () => subscriptions.forEach((subscription) => subscription.remove());
    }, []);
    const INITIAL_WINDOW_SIZE = 30;
    const WINDOW_BATCH_SIZE = 30;
    const [renderedCount, setRenderedCount] = useState(INITIAL_WINDOW_SIZE);

    const [menu, setMenu] = useState<MessageMenuAnchor>();
    const [selecting, setSelecting] = useState<string>();
    const openMessageMenu = useCallback((id: string, x: number, y: number) => {
        setSelecting(undefined);
        setMenu({ id, x, y });
    }, []);
    const pendingById = useMemo(() => new Map(pendingSendQueue.map(item => [item.messageId, item])), [pendingSendQueue]);
    useEffect(() => {
        if (!selecting) return;
        const back = BackHandler.addEventListener('hardwareBackPress', () => { setSelecting(undefined); return true; });
        return () => back.remove();
    }, [selecting]);
    const savedDrafts = useRef<Array<{ text: string; attachments: ChatAttachment[] }>>([]);
    useEffect(() => {
        const store = useAssistantStore.getState();
        const draft = store.pendingSendQueue.find(item => item.withdrawal === 'draft');
        if (!draft) return;
        if (inputContent || pendingAttachmentsRef.current.length) {
            savedDrafts.current.push({ text: inputContent, attachments: pendingAttachmentsRef.current });
        }
        setInputContent(draft.content);
        updatePendingAttachments(draft.attachments ?? []);
        store.removeMessage(draft.messageId);
    }, [pendingSendQueue, inputContent, updatePendingAttachments]);

    const finishComposer = () => {
        const previous = savedDrafts.current.pop();
        setInputContent(previous?.text ?? '');
        updatePendingAttachments(previous?.attachments ?? []);
    };

    const target = route?.params?.notificationTarget;
    const notificationTarget = target && serverUrl && serverToken && credentialsStatus === 'ready'
        && target.serverIdentity === chatServerIdentity(serverUrl, serverToken) ? target : undefined;
    const targetInChat = messages.some(message => message.id === notificationTarget?.messageId);
    const [fetchedReply, setFetchedReply] = useState<{ target: typeof target; message: AssistantMessage }>();
    useEffect(() => {
        if (!notificationTarget || targetInChat) return;
        const controller = new AbortController();
        readNotificationReply(notificationTarget, controller.signal).then(message => {
            if (message && !controller.signal.aborted) {
                setFetchedReply({ target: notificationTarget, message });
            }
        });
        return () => controller.abort();
    }, [notificationTarget, targetInChat, connectionState]);

    // Preserve the normal message order while displaying an older tapped reply.
    const extraReply = !targetInChat && notificationTarget && fetchedReply?.target === notificationTarget
        && fetchedReply.message.seq > clearedSeq ? fetchedReply.message : undefined;
    const reversedMessages = useMemo(() => {
        const visible = messages.filter(m => !pendingById.get(m.id)?.withdrawal).reverse();
        if (extraReply) {
            const index = visible.findIndex(message => message.seq > 0 && message.timestamp < extraReply.timestamp);
            visible.splice(index < 0 ? visible.length : index, 0, extraReply);
        }
        return getChatTimeline(visible.reverse()).reverse();
    }, [messages, pendingById, extraReply]);

    const displayMessages = useMemo(() => {
        return reversedMessages.slice(0, renderedCount);
    }, [reversedMessages, renderedCount]);

    const menuMessage = menu && (messages.find(message => message.id === menu.id)
        ?? (extraReply?.id === menu.id ? extraReply : undefined));
    const chooseMessageAction = (action: MessageAction) => {
        setMenu(undefined);
        if (!menuMessage) return;
        if (action === 'copy') Clipboard.setStringAsync(menuMessage.content).catch(() => {});
        else if (action === 'select') setSelecting(menuMessage.id);
        else AssistantClient.getInstance().withdrawPending(menuMessage.id, action);
    };

    const targetIndex = notificationTarget
        ? reversedMessages.findIndex(message => message.id === notificationTarget.messageId) : -1;
    const openedTarget = useRef<typeof target>(undefined);
    const retryTargetScroll = useRef<((info: { index: number; averageItemLength: number }) => void) | undefined>(undefined);
    useEffect(() => {
        if (!notificationTarget || targetIndex < 0 || openedTarget.current === notificationTarget) return;
        if (targetIndex >= renderedCount) {
            setRenderedCount(targetIndex + 1);
            return;
        }
        let retries = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const scroll = () => {
            const list = flatListRef.current;
            if (!list) return;
            openedTarget.current = notificationTarget;
            list.scrollToIndex({ index: targetIndex, viewPosition: 0.5, animated: false });
        };
        retryTargetScroll.current = ({ index, averageItemLength }) => {
            if (index !== targetIndex || retries >= 4) return;
            retries += 1;
            flatListRef.current?.scrollToOffset({ offset: averageItemLength * index, animated: false });
            clearTimeout(timer);
            timer = setTimeout(scroll, 100);
        };
        const frame = requestAnimationFrame(scroll);
        return () => {
            cancelAnimationFrame(frame);
            clearTimeout(timer);
            retryTargetScroll.current = undefined;
        };
    }, [notificationTarget, targetIndex, renderedCount]);

    const historyBefore = useAssistantStore(state => state.chatHistoryBefore);
    const [loadingHistory, setLoadingHistory] = useState(false);
    const [failedHistory, setFailedHistory] = useState<typeof historyBefore>();
    const historyRequest = useRef<Promise<number> | null>(null);
    const loadEarlierHistory = useCallback(() => {
        if (!historyBefore || historyRequest.current) return;
        setLoadingHistory(true);
        setFailedHistory(undefined);
        const request = AssistantClient.getInstance().loadEarlierChat();
        historyRequest.current = request;
        request.then(count => {
            if (count > 0) setRenderedCount(previous => previous + WINDOW_BATCH_SIZE);
            else if (useAssistantStore.getState().chatHistoryBefore === historyBefore) setFailedHistory(historyBefore);
        }).finally(() => {
            historyRequest.current = null;
            setLoadingHistory(false);
        });
    }, [historyBefore]);

    const handleLoadEarlier = useCallback(() => {
        if (renderedCount < reversedMessages.length) {
            setRenderedCount((prev) => Math.min(prev + WINDOW_BATCH_SIZE, reversedMessages.length));
        } else if (failedHistory !== historyBefore) {
            loadEarlierHistory();
        }
    }, [renderedCount, reversedMessages.length, failedHistory, historyBefore, loadEarlierHistory]);

    const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const offsetY = event.nativeEvent.contentOffset.y;
        scrollOffset.current = offsetY;
        // 倒序列表中，根据顶部 inset 补偿计算视口距最新消息的物理距离；向旧消息上滑时距离增大
        const distanceFromBottom = getInvertedDistanceFromBottom(offsetY, contentInsetsRef.current.top);
        const gesture = scrollGestureRef.current;
        if (distanceFromBottom <= 32 || (gesture.active && !Number.isFinite(gesture.startDistance))) {
            gesture.startDistance = distanceFromBottom;
        }
        setShowScrollBottom((visible) => shouldShowChatScrollBottom(
            visible, distanceFromBottom, gesture.active, gesture.startDistance,
        ));
    }, []);

    const handleScrollBeginDrag = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        setIsAttachMenuVisible(false);
        const distance = getInvertedDistanceFromBottom(
            event.nativeEvent.contentOffset.y, contentInsetsRef.current.top,
        );
        const previousStart = scrollGestureRef.current.startDistance;
        scrollGestureRef.current = {
            active: true,
            // Preserve progress across short drags, but rebase after keyboard movement.
            startDistance: Number.isFinite(previousStart) ? Math.min(previousStart, distance) : distance,
        };
    }, []);
    const handleScrollEndDrag = useCallback(() => {
        scrollGestureRef.current.active = false;
    }, []);

    const scrollToBottom = useCallback(() => {
        scrollGestureRef.current = { active: false, startDistance: Number.NaN };
        setShowScrollBottom(false);
        const targetOffset = getInvertedChatScrollTarget(contentInsetsRef.current.top);
        flatListRef.current?.scrollToOffset({ offset: targetOffset, animated: true });
    }, []);

    const renderListFooter = useCallback(() => {
        if (renderedCount < reversedMessages.length || loadingHistory) {
            return (
                <View style={styles.loadMoreContainer}>
                    <ActivityIndicator size="small" color={theme.colors.textTertiary} />
                    <Text style={styles.loadMoreText}>
                        {t('assistant.loadingEarlierMessages', '正在加载更早历史...')}
                    </Text>
                </View>
            );
        }
        if (historyBefore && failedHistory === historyBefore) {
            return (
                <TouchableOpacity style={styles.loadMoreContainer} onPress={loadEarlierHistory} accessibilityRole="button">
                    <Text style={styles.loadMoreText}>{t('common.retry', '重试')}</Text>
                </TouchableOpacity>
            );
        }
        return null;
    }, [renderedCount, reversedMessages.length, loadingHistory, failedHistory, historyBefore, loadEarlierHistory, t]);

    useEffect(() => {
        // 自动连接
        if (serverUrl && credentialsStatus === 'ready') {
            AssistantClient.getInstance().connect();
        }
    }, [serverUrl, serverToken, credentialsStatus]);

    const pickImage = useCallback(async () => {
        try {
            const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images'],
                allowsMultipleSelection: true,
                selectionLimit: 9,
                orderedSelection: true,
                quality: 0.7,
                base64: true,
            });
            if (!result.canceled && result.assets && result.assets.length > 0) {
                const MAX_SINGLE_SIZE = 10 * 1024 * 1024;
                const newAttachments: ChatAttachment[] = [];
                for (let i = 0; i < result.assets.length; i++) {
                    const asset = result.assets[i];
                    let base64Data = asset.base64 || undefined;
                    const approxSize = asset.fileSize ?? (base64Data ? Math.round((base64Data.length * 3) / 4) : 0);
                    if (approxSize > MAX_SINGLE_SIZE) {
                        Alert.alert(t('common.notice', '提示'), t('chat.attachmentTooLarge', '附件体积过大（上限 10MB）'));
                        continue;
                    }
                    const name = asset.fileName || `image_${Date.now()}_${i}.jpg`;
                    // 无内联数据时先读取，避免仅按 URI 元数据计算草稿预算。
                    let size = approxSize;
                    if (!base64Data) {
                        const readResult = await fsService.readAttachment(asset.uri, MAX_SINGLE_SIZE, asset.mimeType || 'image/jpeg', name);
                        if (!readResult.data) throw new Error('ATTACHMENT_DATA_MISSING');
                        base64Data = readResult.data;
                        size = readResult.size;
                    }
                    // expo-image-picker 在开启 base64 导出时统一压缩输出为 JPEG 编码，匹配声明类型以防模型 Provider 拒收
                    const mimeType = asset.base64 ? 'image/jpeg' : (asset.mimeType || 'image/jpeg');
                    newAttachments.push({
                        type: 'image',
                        name,
                        mimeType,
                        size,
                        uri: asset.uri,
                        data: base64Data,
                    });
                }
                if (newAttachments.length > 0) {
                    appendPendingAttachments(newAttachments);
                }
            }
        } catch (error: unknown) {
            if (error instanceof Error && error.message === 'ATTACHMENT_TOO_LARGE') {
                Alert.alert(t('common.notice', '提示'), t('chat.attachmentTooLarge', '附件体积过大（上限 10MB）'));
            } else {
                Alert.alert(t('common.error', '错误'), t('chat.pickImageError', '选择图片失败'));
            }
        }
    }, [appendPendingAttachments, t]);

    const pickDocument = useCallback(async () => {
        try {
            const result = await DocumentPicker.getDocumentAsync({
                copyToCacheDirectory: true,
            });
            if (!result.canceled && result.assets && result.assets.length > 0) {
                const asset = result.assets[0];
                const name = asset.name || `file_${Date.now()}`;
                const mimeType = asset.mimeType;

                let readResult: { content?: string; data?: string; size: number };
                try {
                    readResult = await fsService.readAttachment(asset.uri, 10 * 1024 * 1024, mimeType, name);
                } catch (readErr: unknown) {
                    const errorMsg = readErr instanceof Error ? readErr.message : String(readErr);
                    if (errorMsg === 'ATTACHMENT_TOO_LARGE') {
                        Alert.alert(t('common.notice', '提示'), t('chat.attachmentTooLarge', '附件体积过大（上限 10MB）'));
                    } else {
                        Alert.alert(t('common.error', '错误'), t('chat.attachmentReadError', '读取附件文件失败'));
                    }
                    return;
                }

                appendPendingAttachment({
                    type: 'file',
                    name,
                    mimeType,
                    size: readResult.size,
                    uri: asset.uri,
                    content: readResult.content,
                    data: readResult.data,
                });
            }
        } catch {
            Alert.alert(t('common.error', '错误'), t('chat.pickDocumentError', '选择文件失败'));
        }
    }, [appendPendingAttachment, t]);

    const handlePlusAction = useCallback(() => {
        setIsAttachMenuVisible((prev) => !prev);
    }, []);

    const handleSend = () => {
        const trimmed = inputContent.trim();
        if (trimmed === '/new') {
            finishComposer();
            const doReset = async () => {
                try {
                    const ok = await AssistantClient.getInstance().resetSession();
                    if (ok) {
                        showToast(t('assistant.sessionResetToast', '上下文已重置'));
                    } else {
                        showToast(t('assistant.sessionResetFailed', '重置上下文失败，请稍后重试'));
                    }
                } catch (err) {
                    console.warn('[ChatScreen] resetSession failed:', err);
                    showToast(t('assistant.sessionResetFailed', '重置上下文失败，请稍后重试'));
                }
            };
            doReset();
            return;
        }

        const attachments = pendingAttachmentsRef.current;
        const text = trimmed || (attachments.length > 0
            ? (attachments.every((attachment) => attachment.type === 'image')
                ? t('chat.attachedImage', '发送了图片')
                : `${t('chat.attachedFile', '发送了文件')}: ${attachments.map((attachment) => attachment.name).join(', ')}`)
            : '');
        if (!text) return;
        if (isAttachmentBudgetExceeded(attachments)) {
            Alert.alert(t('common.notice', '提示'), t('chat.attachmentTooLarge', '附件体积过大（上限 10MB）'));
            return;
        }
        const { top } = contentInsetsRef.current;
        const targetOffset = getInvertedChatScrollTarget(top);
        const distance = getInvertedDistanceFromBottom(scrollOffset.current ?? targetOffset, top);
        const atBottom = distance <= 1;
        const messageId = AssistantClient.getInstance().sendMessage(text, attachments.length > 0 ? attachments : undefined);
        entranceMessageId.current = atBottom && !reduceMotion ? messageId : undefined;
        setSubmittedId(taskRunning ? undefined : messageId);
        finishComposer();
        if (!atBottom) flatListRef.current?.scrollToOffset({ offset: targetOffset, animated: true });
    };

    const handleStop = () => {
        const sent = AssistantClient.getInstance().stopExecution();
        if (!sent) {
            Alert.alert(t('common.notice', '提示'), t('assistant.stopFailedOffline', '当前网络未就绪，停止指令未送达'));
        }
    };

    const handleApproval = (approvalId: string, approved: boolean) => {
        const sent = AssistantClient.getInstance().respondApproval(approvalId, approved);
        if (!sent) {
            Alert.alert(t('common.notice', '提示'), t('assistant.approvalFailedOffline', '当前网络未就绪，审批指令未送达'));
        }
    };

    const handlePasteQuickConnect = async () => {
        try {
            const text = await Clipboard.getStringAsync();
            if (!text.trim()) {
                Alert.alert(t('common.notice', '提示'), t('assistant.clipboardEmpty', '剪贴板内容为空'));
                return;
            }
            const parsed = AssistantClient.parseConnectionUrl(text);
            if (parsed.url && parsed.token) {
                try {
                    await setServerConfig(parsed.url, parsed.token);
                } catch (failure) {
                    Alert.alert(t('common.error'), t(failure instanceof ConnectionConfigError
                        ? connectionErrorKey(failure.code) : 'assistant.saveFailed'));
                    return;
                }
                AssistantClient.getInstance().connect();
                Alert.alert(t('common.success', '成功'), t('assistant.configApplied', '已成功解析并应用配置'));
            } else if (parsed.url && !parsed.token) {
                Alert.alert(t('common.error', '错误'), t('assistant.tokenMissingInClip', '剪贴板链接缺少访问令牌（Token）'));
            } else {
                Alert.alert(t('common.error', '错误'), t('assistant.configInvalid', '未能在剪贴板中识别出有效服务地址'));
            }
        } catch {
            Alert.alert(t('common.error', '错误'), t('assistant.clipboardFail', '读取剪贴板失败'));
        }
    };

    // Loading is not an unconfigured connection. Never offer replacement input
    // before the saved credentials have been read successfully.
    if (credentialsStatus === 'loading') {
        return <View style={styles.centerContainer}><ActivityIndicator color={theme.colors.primary} /></View>;
    }

    if (credentialsStatus === 'error') {
        const failureKey = connectionErrorKey(credentialsError);
        const retry = async () => {
            if (retryingStorage) return;
            setRetryingStorage(true);
            try {
                if (credentialsStatus === 'error') await loadSavedCredentials();
                await AssistantClient.getInstance().connect(true);
            } catch {
                // The store retains a localized, retryable failure; never report success.
            } finally { setRetryingStorage(false); }
        };
        return <View style={styles.centerContainer}>
            <View style={styles.guideCard}>
                <Text accessibilityRole="alert" style={[styles.guideDesc, { fontSize: metrics.chatBody, lineHeight: metrics.chatLineHeight }]}>
                    {t(failureKey)}
                </Text>
                <TouchableOpacity accessibilityRole="button" disabled={retryingStorage} style={styles.primaryBtn} onPress={retry}>
                    <Text style={[styles.primaryBtnText, { fontSize: metrics.chatBody }]}>{t('browser.retry')}</Text>
                </TouchableOpacity>
                <TouchableOpacity accessibilityRole="button" style={styles.secondaryBtn} onPress={() => navigation.navigate('AssistantConfig')}>
                    <Text style={[styles.secondaryBtnText, { fontSize: metrics.chatBody }]}>{t('assistant.goToConfig')}</Text>
                </TouchableOpacity>
            </View>
        </View>;
    }

    // 1. 未配置连接时的引导界面
    if (!serverUrl && credentialsStatus === 'ready') {
        return (
            <View style={styles.centerContainer}>
                <View style={styles.guideCard}>
                    <View style={styles.iconWrapper}>
                        <Icon name="smart-toy" size={44} color={theme.colors.primary} />
                    </View>
                    <Text style={[styles.guideTitle, { fontSize: metrics.chatHeading2 }]}>{t('assistant.notConnectedTitle', '尚未连接绿天助理服务')}</Text>
                    <Text style={[styles.guideDesc, { fontSize: metrics.chatBody, lineHeight: metrics.chatLineHeight }]}>
                        {t('assistant.notConnectedDesc', '助理服务运行在您的电脑或 VPS 上，提供常驻后台任务、记忆系统与长连接对话。')}
                    </Text>

                    <TouchableOpacity
                        style={styles.primaryBtn}
                        onPress={() => navigation.navigate('AssistantConfig')}
                        activeOpacity={0.8}
                    >
                        <Icon name="settings" size={20} color={theme.colors.white} />
                        <Text style={[styles.primaryBtnText, { fontSize: metrics.chatBody }]}>{t('assistant.goToConfig', '前往配置服务')}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.secondaryBtn}
                        onPress={handlePasteQuickConnect}
                        activeOpacity={0.8}
                    >
                        <Icon name="content-paste" size={18} color={theme.colors.primary} />
                        <Text style={[styles.secondaryBtnText, { fontSize: metrics.chatBody }]}>{t('assistant.pasteConfig', '一键粘贴完整配置链接')}</Text>
                    </TouchableOpacity>
                </View>
            </View>
        );
    }

    // 2. 正常聊天界面
    // 聊天消息列表与输入区分别使用库提供的聊天滚动视图和键盘粘附视图
    return (
        <View style={styles.chatContainer}>
            {toastMessage && (
                <View style={styles.toastContainer} pointerEvents="none">
                    <View style={styles.toastPill}>
                        <Icon name="check-circle" size={18} color={theme.colors.white} style={styles.toastIcon} />
                        <Text style={styles.toastText}>{toastMessage}</Text>
                    </View>
                </View>
            )}
            {/* 顶部异常状态横幅：日常建连由顶栏静默/轻量承载，仅在升级、鉴权失败或长时间无法连通时展开 */}
            {banner.kind === 'upgrading' ? (
                <View style={styles.upgradingBanner}>
                    <Text style={styles.upgradingBannerText}>
                        {t('assistant.serverUpgradingBanner', '⚡ 服务端正在升级新版本，稍候数秒自动恢复')}
                    </Text>
                </View>
            ) : banner.kind === 'auth_error' ? (
                <View style={styles.authErrorBanner} testID="chat-auth-error-banner">
                    <Icon name="error-outline" size={16} color={theme.colors.dangerText} style={styles.bannerIcon} />
                    <Text style={styles.authErrorBannerText}>
                        {banner.message || t('assistant.authTokenInvalid', '访问令牌已失效，请重新配置')}
                    </Text>
                    <TouchableOpacity
                        style={styles.authSettingsBtn}
                        onPress={() => navigation.navigate('AssistantConfig')}
                    >
                        <Text style={styles.authSettingsBtnText}>{t('assistant.goToSettings', '去设置')}</Text>
                    </TouchableOpacity>
                </View>
            ) : banner.kind === 'unreachable' ? (
                <View style={styles.statusBar} testID="chat-unreachable-banner">
                    <Icon name="cloud-off" size={16} color={theme.colors.warnText} style={styles.bannerIcon} />
                    <Text style={styles.statusText}>
                        {t('assistant.statusUnreachable', '暂时无法连接服务')}
                    </Text>
                    <TouchableOpacity
                        style={styles.reconnectBtn}
                        onPress={retryConnection}
                    >
                        <Text style={styles.reconnectBtnText}>{t('browser.retry', '重试')}</Text>
                    </TouchableOpacity>
                </View>
            ) : null}

            {/*
              消息流列表：倒序模型 (inverted)，最新消息处于视口物理原点 0，冷启动无需滚动即在最新。
              倒序列表的 ListHeaderComponent 落在视觉最底部，正好承载“正在工作”指示：
              它随列表滚动、不进消息数据、不参与排序，直到整轮工作结束才消失。
            */}
            <FlatList
                ref={flatListRef}
                data={displayMessages}
                inverted={true}
                keyExtractor={(item) => item.timelineKey ?? item.id}
                contentContainerStyle={styles.messageList}
                keyboardShouldPersistTaps="handled"
                onScrollBeginDrag={handleScrollBeginDrag}
                onScrollEndDrag={handleScrollEndDrag}
                onTouchStart={() => {
                    if (isAttachMenuVisible) {
                        setIsAttachMenuVisible(false);
                    }
                }}
                onScroll={handleScroll}
                scrollEventThrottle={16}
                onScrollToIndexFailed={info => retryTargetScroll.current?.(info)}
                onEndReached={handleLoadEarlier}
                onEndReachedThreshold={0.3}
                initialNumToRender={15}
                maxToRenderPerBatch={15}
                windowSize={11}
                renderScrollComponent={renderChatScrollComponent}
                ListFooterComponent={renderListFooter}
                ListHeaderComponent={taskRunning && showTypingIndicator
                    ? <TypingIndicator /> : undefined}
                extraData={`${dateNow}-${chatI18n.language}`}
                renderItem={({ item, index }) => {
                    const isUser = item.role === 'user';
                    const time = formatChatTime(item.timestamp, chatI18n.language);
                    // 工具调用已移出聊天：正文仍按锚点切段，但只渲染文字，不生成工具卡片。
                    const assistantParts = !isUser
                        ? getAssistantDisplayParts(item).filter((part) => part.type === 'text')
                        : [];
                    const lastTextPartKey = [...assistantParts].reverse().find((part) => part.type === 'text')?.key;
                    // Status changes must not move the clock from a footer into
                    // the body after acknowledgement. Only actionable states need a footer.
                    const inlineUserTime = isUser && Boolean(item.content);
                    const pendingItem = pendingById.get(item.id);
                    const dimUserBubble = isUser && pendingItem && !pendingItem.submittedOnline && !pendingItem.attempted;
                    const sendFailed = isUser && Boolean(pendingItem?.failed);
                    const selectingHere = selecting === item.id;
                    // Data is newest-first, while each cell remains top-to-bottom.
                    const showDate = startsChatDay(item.timelineTimestamp ?? item.timestamp, displayMessages[index + 1]?.timelineTimestamp ?? displayMessages[index + 1]?.timestamp);
                    const hasProseBubble = isUser || Boolean(item.attachments?.length ||
                        item.errorMessage || (item.stopReason && item.stopReason !== 'end_turn'));
                    // 纯工具消息已移出聊天：不保留空行，只在跨天时保留日期分隔。
                    const hasVisibleRow = isUser || assistantParts.length > 0 || hasProseBubble;
                    const bubblePressable = hasVisibleRow ? (
                        <Pressable accessible={false} disabled={selectingHere}
                            onPress={() => setSelecting(undefined)}
                            onLongPress={e => openMessageMenu(item.id, e.nativeEvent.pageX, e.nativeEvent.pageY)}
                            onPointerDown={e => { if (!selectingHere && e.nativeEvent.button === 2) openMessageMenu(item.id, e.nativeEvent.pageX, e.nativeEvent.pageY); }}
                            {...(Platform.OS === 'web' && !selectingHere ? { onContextMenu: (e: { preventDefault(): void; clientX: number; clientY: number }) => {
                                e.preventDefault();
                                openMessageMenu(item.id, e.clientX, e.clientY);
                            } } : {})}
                            style={[isUser ? styles.userBubblePressable : styles.assistantMessageGroup, dimUserBubble && styles.pendingBubble]}>
                            {!isUser && assistantParts.map((part) => {
                                const partTime = part.type === 'text' && part.key === lastTextPartKey && item.completedAt
                                    ? formatChatTime(item.completedAt, chatI18n.language)
                                    : time;
                                return isPlainChatText(part.text) ? (
                                    <View
                                        key={part.key}
                                        testID={`assistant-prose-${item.id}-${part.key}`}
                                        style={[styles.bubble, styles.assistantBubble]}
                                    >
                                        <ChatBubbleText selectable={selectingHere} text={part.text} time={partTime}
                                            textStyle={[styles.userText, { fontSize: metrics.chatBody, lineHeight: metrics.chatLineHeight }]} />
                                    </View>
                                ) : (
                                    <ChatMarkdownBubble selectable={selectingHere} messageId={item.id} onOpenMenu={openMessageMenu} key={part.key} text={part.text} time={partTime} metrics={metrics}
                                        testID={`assistant-prose-${item.id}-${part.key}`} />
                                );
                            })}
                            {hasProseBubble && <View
                                testID={isUser ? `user-bubble-${item.id}` : `assistant-prose-${item.id}`}
                                style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}
                            >
                                {item.attachments && item.attachments.map((att, idx) => {
                                    const imageUri = att.type === 'image'
                                        ? (att.data ? `data:${att.mimeType || 'image/jpeg'};base64,${att.data}` : att.uri)
                                        : undefined;
                                    return imageUri ? (
                                        <TouchableOpacity
                                            key={idx}
                                            activeOpacity={0.85}
                                            onLongPress={selectingHere ? undefined : e => openMessageMenu(item.id, e.nativeEvent.pageX, e.nativeEvent.pageY)}
                                            onPress={() => setPreviewImageUri(imageUri)}
                                            accessibilityRole="button"
                                            accessibilityLabel={`${t('chat.previewImage', '预览图片')} ${att.name || ''}`}
                                        >
                                            <Image
                                                source={{ uri: imageUri }}
                                                style={styles.attachmentImage}
                                                resizeMode="cover"
                                            />
                                        </TouchableOpacity>
                                    ) : (
                                        <View
                                            key={idx}
                                            style={[
                                                styles.attachmentFileBox,
                                                isUser ? styles.attachmentFileBoxUser : styles.attachmentFileBoxAssistant,
                                            ]}
                                        >
                                            <Icon
                                                name={att.type === 'image' ? 'image' : 'insert-drive-file'}
                                                size={18}
                                                color={isUser ? theme.colors.white : theme.colors.primary}
                                                style={styles.attachmentFileIcon}
                                            />
                                            <Text
                                                style={[
                                                    styles.attachmentFileName,
                                                    isUser ? styles.attachmentFileNameUser : styles.attachmentFileNameAssistant,
                                                ]}
                                                numberOfLines={1}
                                            >
                                                {att.name}
                                            </Text>
                                        </View>
                                    );
                                })}

                                {isUser ? (
                                    <View>
                                        {inlineUserTime ? <ChatBubbleText text={item.content} time={time} selectable={selectingHere}
                                            textStyle={[styles.userText, { fontSize: metrics.chatBody, lineHeight: metrics.chatLineHeight }]} /> : <Text
                                            style={[
                                                styles.userText,
                                                {
                                                    fontSize: metrics.chatBody,
                                                    lineHeight: metrics.chatLineHeight,
                                                },
                                            ]}
                                            selectable={selectingHere}
                                        >
                                            {item.content}
                                        </Text>}
                                    </View>
                                ) : (
                                    <View style={styles.assistantContentContainer}>
                                        {/* 错误提示：稳定错误码按码本地化，未知码按原文兜底 */}
                                        {item.status === 'error' && item.errorMessage && (
                                            <Text style={styles.errorText}>
                                                {translateErrorMessage(item.errorMessage)}
                                            </Text>
                                        )}

                                        {/* 回复截断提示（引擎 stopReason 本地化展示） */}
                                        {item.status === 'done' && item.stopReason && item.stopReason !== 'end_turn' && (
                                            <Text style={styles.truncatedText}>
                                                {t('assistant.replyTruncated', '回复因达到最大长度被截断')}
                                            </Text>
                                        )}
                                    </View>
                                )}

                                {/* 时间与状态 */}
                                {!inlineUserTime && <View style={styles.msgFooter}>
                                    <Text style={[styles.timeText, isUser ? styles.userTime : styles.assistantTime]}>
                                        {!isUser && item.completedAt ? formatChatTime(item.completedAt, chatI18n.language) : time}
                                    </Text>
                                </View>}
                            </View>}
                        </Pressable>
                    ) : null;
                    const dateSeparator = showDate ? (
                        <View style={styles.dateSeparator} testID={`chat-date-${item.id}`}>
                            <Text style={styles.dateSeparatorText}>
                                {formatChatDate(item.timelineTimestamp ?? item.timestamp, dateNow, chatI18n.language, t)}
                            </Text>
                        </View>
                    ) : null;
                    return (
                        <View>
                        {hasVisibleRow ? <ChatBubbleReveal
                            layoutKey={JSON.stringify([item.id, metrics])}
                            dateSeparator={dateSeparator}
                            streaming={!isUser && item.status === 'processing'}
                            consumeEntrance={isUser && entranceMessageId.current === item.id ? () => {
                                if (entranceMessageId.current === item.id) entranceMessageId.current = undefined;
                            } : undefined}
                            style={[
                                styles.messageRow,
                                isUser ? styles.userRow : styles.assistantRow,
                            ]}
                        >
                            {isUser ? (
                                <View style={styles.userMessageGroup}>
                                    {bubblePressable}
                                    {sendFailed && (
                                        <TouchableOpacity
                                            testID={`resend-message-${item.id}`}
                                            style={styles.resendButton}
                                            onPress={() => handleResendMessage(item.id)}
                                            activeOpacity={0.7}
                                            hitSlop={{ top: 6, bottom: 6, left: 10, right: 6 }}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('chat.resend', '重发')}
                                        >
                                            <Text style={styles.resendText}>{t('chat.resend', '重发')}</Text>
                                        </TouchableOpacity>
                                    )}
                                </View>
                            ) : bubblePressable}
                        </ChatBubbleReveal> : dateSeparator}
                        </View>
                    );
                }}
            />

            {/* 向上滚动时出现的快速回到底部悬浮小圆钮：置于主容器内保证触摸响应边界完整，并跟随键盘与输入框高度平滑位移 */}
            {showScrollBottom && (
                <Animated.View
                    style={[styles.scrollBottomContainer, animatedScrollBottomStyle]}
                    pointerEvents="box-none"
                >
                    <TouchableOpacity
                        style={styles.scrollBottomBtn}
                        onPress={scrollToBottom}
                        activeOpacity={0.85}
                    >
                        <Icon name="arrow-downward" size={18} color={theme.colors.primaryDark} />
                    </TouchableOpacity>
                </Animated.View>
            )}

            <KeyboardStickyView
                style={styles.keyboardSticky}
                offset={{ opened: tabBarHeight }}
                onLayout={handleComposerLayout}
            >
                {/* 人工审批卡片：并发审批按登记顺序逐卡展示，各自独立应答 */}
            {pendingApprovals.map((approval) => (
                <View key={approval.approvalId} style={styles.approvalCard}>
                    <View style={styles.approvalHeader}>
                        <Icon name="warning" size={20} color={theme.colors.warnText} />
                        <Text style={[styles.approvalTitle, { fontSize: metrics.chatBody }]}>{t('assistant.approvalRequired', '需要人工审批')}</Text>
                    </View>
                    <Text style={styles.approvalPrompt}>{approval.prompt}</Text>
                    {approval.toolName && (
                        <Text style={styles.approvalSub}>
                            {t('assistant.toolRequested', '请求调用的工具')}: {approval.toolName}
                        </Text>
                    )}
                    <View style={styles.approvalBtnRow}>
                        <TouchableOpacity
                            style={[styles.approvalBtn, styles.rejectBtn]}
                            onPress={() => handleApproval(approval.approvalId, false)}
                        >
                            <Text style={styles.rejectBtnText}>{t('assistant.reject', '拒绝')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.approvalBtn, styles.approveBtn]}
                            onPress={() => handleApproval(approval.approvalId, true)}
                        >
                            <Text style={styles.approveBtnText}>{t('assistant.approve', '同意执行')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            ))}

            {/* 底部输入区 */}
            <View style={styles.inputArea}>
                {/* 附件选择轻量悬浮气泡菜单 (Popover) */}
                {isAttachMenuVisible && (
                    <View style={styles.attachMenuPopover}>
                        <TouchableOpacity
                            style={styles.attachMenuItem}
                            onPress={() => {
                                setIsAttachMenuVisible(false);
                                pickImage();
                            }}
                            activeOpacity={0.7}
                            accessibilityRole="button"
                            accessibilityLabel={t('chat.pickImage', '图片')}
                        >
                            <View style={[styles.attachMenuIconBg, styles.attachMenuPhotoBg]}>
                                <Icon name="photo" size={18} color={theme.colors.primaryDark} />
                            </View>
                            <Text style={[styles.attachMenuText, { fontSize: metrics.chatBody }]}>{t('chat.pickImage', '图片')}</Text>
                        </TouchableOpacity>

                        <View style={styles.attachMenuDivider} />

                        <TouchableOpacity
                            style={styles.attachMenuItem}
                            onPress={() => {
                                setIsAttachMenuVisible(false);
                                pickDocument();
                            }}
                            activeOpacity={0.7}
                            accessibilityRole="button"
                            accessibilityLabel={t('chat.pickDocument', '文件')}
                        >
                            <View style={[styles.attachMenuIconBg, styles.attachMenuDocBg]}>
                                <Icon name="insert-drive-file" size={18} color="#D97706" />
                            </View>
                            <Text style={[styles.attachMenuText, { fontSize: metrics.chatBody }]}>{t('chat.pickDocument', '文件')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {showSlashMenu && filteredSlashItems.length > 0 && (
                    <View style={styles.slashMenuContainer}>
                        <FlatList
                            data={filteredSlashItems}
                            keyExtractor={(item) => item.id}
                            keyboardShouldPersistTaps="always"
                            style={styles.slashMenuList}
                            contentContainerStyle={styles.slashMenuContent}
                            renderItem={({ item }) => (
                                <TouchableOpacity
                                    style={styles.slashMenuItem}
                                    activeOpacity={0.7}
                                    onPress={() => handleSelectSlashItem(item)}
                                >
                                    <View
                                        style={[
                                            styles.slashItemIconWrap,
                                            item.type === 'command'
                                                ? styles.slashCommandIcon
                                                : styles.slashSkillIcon,
                                        ]}
                                    >
                                        <Icon
                                            name={item.icon}
                                            size={18}
                                            color={item.type === 'command' ? theme.colors.primary : theme.colors.textSecondary}
                                        />
                                    </View>
                                    <View style={styles.slashItemTextWrap}>
                                        <View style={styles.slashItemTitleRow}>
                                            <Text style={[styles.slashItemLabel, { fontSize: metrics.chatBody }]}>{item.label}</Text>
                                            <Text style={styles.slashItemTypeTag}>
                                                {item.type === 'command'
                                                    ? t('assistant.slashMenuCommands', '命令')
                                                    : t('assistant.slashMenuSkills', '技能')}
                                            </Text>
                                        </View>
                                        <Text style={styles.slashItemDesc} numberOfLines={1} ellipsizeMode="tail">
                                            {item.description}
                                        </Text>
                                    </View>
                                </TouchableOpacity>
                            )}
                        />
                    </View>
                )}
                <View style={styles.inputCapsule}>
                    {pendingAttachments.length > 0 && (
                        <ScrollView
                            horizontal
                            style={styles.draftAttachmentsScroll}
                            contentContainerStyle={styles.draftAttachmentsContent}
                            showsHorizontalScrollIndicator={false}
                            keyboardShouldPersistTaps="handled"
                        >
                            {pendingAttachments.map((attachment, index) => {
                                const imageUri = attachment.type === 'image'
                                    ? (attachment.uri || (attachment.data ? `data:${attachment.mimeType || 'image/jpeg'};base64,${attachment.data}` : undefined))
                                    : undefined;
                                return (
                                    <View key={`${attachment.uri}-${index}`} style={styles.draftAttachmentCard} testID={`draft-attachment-${index}`}>
                                        {imageUri ? (
                                            <TouchableOpacity
                                                activeOpacity={0.8}
                                                onPress={() => setPreviewImageUri(imageUri)}
                                                accessibilityRole="button"
                                                accessibilityLabel={`${t('chat.previewImage', '预览图片')} ${attachment.name}`}
                                            >
                                                <Image
                                                    source={{ uri: imageUri }}
                                                    style={styles.draftImageThumb}
                                                    resizeMode="cover"
                                                />
                                            </TouchableOpacity>
                                        ) : (
                                            <View style={styles.draftFileBox}>
                                                <Icon name="insert-drive-file" size={20} color={theme.colors.primary} />
                                                <Text style={styles.draftFileName} numberOfLines={1}>{attachment.name}</Text>
                                            </View>
                                        )}
                                        <TouchableOpacity
                                            onPress={() => {
                                                const remaining = pendingAttachmentsRef.current.filter((_, itemIndex) => itemIndex !== index);
                                                if (!remaining.length && !inputContent && savedDrafts.current.length) finishComposer();
                                                else updatePendingAttachments(remaining);
                                            }}
                                            accessibilityRole="button"
                                            accessibilityLabel={`${t('common.delete', '删除')} ${attachment.name}`}
                                            style={styles.draftDeleteBadge}
                                            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                                        >
                                            <Icon name="close" size={12} color={theme.colors.white} />
                                        </TouchableOpacity>
                                    </View>
                                );
                            })}
                        </ScrollView>
                    )}
                    <View style={styles.inputRow}>
                        <TouchableOpacity
                            style={[styles.plusBtn, isAttachMenuVisible && styles.plusBtnActive]}
                            onPress={handlePlusAction}
                            activeOpacity={0.7}
                            accessibilityRole="button"
                            accessibilityLabel={t('chat.addAttachment', '添加内容')}
                        >
                            <Icon
                                name={isAttachMenuVisible ? 'close' : 'add'}
                                size={24}
                                color={isAttachMenuVisible ? theme.colors.primary : theme.colors.textSecondary}
                            />
                        </TouchableOpacity>
                        <TextInput
                            {...textInputColors}
                            ref={chatInputRef}
                            autoFocus={false}
                            style={[
                                styles.chatInput,
                                { fontSize: metrics.chatInput },
                            ]}
                            placeholder={t('assistant.inputPlaceholder', '消息')}
                            placeholderTextColor={theme.colors.textTertiary}
                            value={inputContent}
                            onFocus={() => {
                                setSelecting(undefined);
                                if (isAttachMenuVisible) setIsAttachMenuVisible(false);
                            }}
                            onChangeText={(text) => {
                                if (!text && !pendingAttachmentsRef.current.length && savedDrafts.current.length) finishComposer();
                                else setInputContent(text);
                                if (isAttachMenuVisible) setIsAttachMenuVisible(false);
                            }}
                            multiline
                            maxLength={5000}
                            onLayout={handleInputLayout}
                        />
                        {inputContent.trim() || pendingAttachments.length > 0 ? (
                            <TouchableOpacity
                                style={styles.sendBtnActive}
                                onPress={handleSend}
                                activeOpacity={0.8}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.send', '发送')}
                            >
                                <Icon name="arrow-upward" size={18} color={theme.colors.white} />
                            </TouchableOpacity>
                        ) : taskRunning ? (
                            <TouchableOpacity
                                style={styles.stopBtnActive}
                                onPress={handleStop}
                                activeOpacity={0.7}
                                accessibilityRole="button"
                                accessibilityLabel={t('assistant.stop', '停止执行')}
                            >
                                <View style={styles.stopSquare} />
                            </TouchableOpacity>
                        ) : (
                            <TouchableOpacity
                                style={[styles.sendBtnActive, !awaitingStart && styles.sendBtnDisabled]}
                                disabled
                                accessibilityRole="button"
                                accessibilityLabel={t('common.send', '发送')}
                                accessibilityState={{ disabled: true }}
                            >
                                <Icon name="arrow-upward" size={18} color={theme.colors.white} />
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            </View>
            </KeyboardStickyView>
            {menu && menuMessage && <ChatMessageMenu anchor={menu} pending={pendingById.has(menu.id)}
                close={() => setMenu(undefined)} choose={chooseMessageAction} />}
            <ImageViewerModal
                visible={!!previewImageUri}
                imageUri={previewImageUri}
                onClose={() => setPreviewImageUri(null)}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    centerContainer: {
        flex: 1,
        backgroundColor: theme.colors.background,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    guideCard: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        padding: 24,
        alignItems: 'center',
        width: '100%',
        maxWidth: 360,
        elevation: 2,
    },
    iconWrapper: {
        width: 72,
        height: 72,
        borderRadius: 36,
        backgroundColor: theme.colors.primaryLight,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 16,
    },
    guideTitle: {
        fontWeight: 'bold',
        color: theme.colors.text,
        marginBottom: 8,
        textAlign: 'center',
    },
    guideDesc: {
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginBottom: 20,
    },
    primaryBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.primary,
        borderRadius: 10,
        paddingVertical: 12,
        width: '100%',
        marginBottom: 12,
    },
    primaryBtnText: {
        color: theme.colors.white,
        fontWeight: '600',
        marginLeft: 8,
    },
    secondaryBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.primaryLight,
        borderRadius: 10,
        paddingVertical: 11,
        width: '100%',
        borderWidth: 1,
        borderColor: theme.colors.primary,
    },
    secondaryBtnText: {
        color: theme.colors.primary,
        fontWeight: '600',
        marginLeft: 6,
    },
    chatContainer: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    keyboardSticky: {
        backgroundColor: theme.colors.surface,
        zIndex: 20,
    },
    upgradingBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.warnBgStrong,
        paddingHorizontal: 16,
        paddingVertical: 9,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.warnBorder,
    },
    upgradingBannerText: {
        fontSize: auxFontSizes.secondary,
        color: theme.colors.warnText,
        fontWeight: '500',
    },
    statusBar: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.warnBg,
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.warnBorder,
    },
    authErrorBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.dangerBg,
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: '#FFCDD2',
    },
    bannerIcon: {
        marginRight: 8,
    },
    authErrorBannerText: {
        fontSize: auxFontSizes.caption,
        color: theme.colors.dangerText,
        flex: 1,
    },
    authSettingsBtn: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#FFCDD2',
    },
    authSettingsBtnText: {
        fontSize: auxFontSizes.caption,
        color: theme.colors.dangerText,
        fontWeight: '600',
    },
    statusText: {
        fontSize: auxFontSizes.caption,
        color: theme.colors.textSecondary,
        flex: 1,
    },
    reconnectBtn: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
    },
    reconnectBtnText: {
        fontSize: auxFontSizes.caption,
        color: theme.colors.text,
    },
    messageList: {
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    loadMoreContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 12,
        gap: 8,
    },
    loadMoreText: {
        fontSize: auxFontSizes.caption,
        color: theme.colors.textTertiary,
    },
    dateSeparator: { alignItems: 'center', marginTop: 4, marginBottom: 12 },
    dateSeparatorText: { fontSize: auxFontSizes.caption, color: theme.colors.textSecondary, backgroundColor: theme.colors.background, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12 },
    messageRow: {
        flexDirection: 'row',
        marginBottom: 12,
    },
    userRow: {
        justifyContent: 'flex-end',
    },
    assistantRow: {
        justifyContent: 'flex-start',
    },
    bubble: {
        borderRadius: 20,
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    pendingBubble: { opacity: 0.5 },
    userMessageGroup: {
        maxWidth: '85%',
        flexShrink: 1,
        alignItems: 'flex-end',
    },
    userBubblePressable: {
        maxWidth: '100%',
    },
    resendButton: {
        marginTop: 4,
        paddingHorizontal: 4,
        paddingVertical: 2,
    },
    resendText: {
        fontSize: auxFontSizes.caption,
        color: theme.colors.dangerText,
        fontWeight: '500',
    },
    assistantMessageGroup: {
        width: '92%',
        flexShrink: 1,
        alignItems: 'flex-start',
        gap: 6,
    },
    userBubble: {
        backgroundColor: '#D9EAFD',
    },
    assistantBubble: {
        alignSelf: 'flex-start',
        backgroundColor: theme.colors.background,
        maxWidth: '100%',
        minWidth: 48,
    },
    assistantContentContainer: {
        width: '100%',
    },
    userText: {
        color: theme.colors.text,
        lineHeight: 23,
    },
    errorText: {
        fontSize: auxFontSizes.caption,
        color: theme.colors.dangerText,
        marginTop: 6,
    },
    truncatedText: {
        fontSize: auxFontSizes.caption,
        color: theme.colors.warnText,
        marginTop: 6,
    },
    msgFooter: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        marginTop: 4,
    },
    timeText: {
        fontSize: auxFontSizes.caption,
    },
    userTime: {
        color: 'rgba(17, 24, 39, 0.5)',
    },
    assistantTime: {
        color: theme.colors.textTertiary,
    },
    approvalCard: {
        backgroundColor: theme.colors.warnBgStrong,
        borderRadius: 16,
        padding: 14,
        marginHorizontal: 16,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: theme.colors.warnBorder,
    },
    approvalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 6,
    },
    approvalTitle: {
        fontWeight: 'bold',
        color: theme.colors.warnText,
        marginLeft: 6,
    },
    approvalPrompt: {
        fontSize: auxFontSizes.secondary,
        color: theme.colors.text,
        lineHeight: 18,
        marginBottom: 4,
    },
    approvalSub: {
        fontSize: auxFontSizes.caption,
        color: theme.colors.textSecondary,
        marginBottom: 10,
    },
    approvalBtnRow: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 10,
    },
    approvalBtn: {
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: 6,
    },
    rejectBtn: {
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.border,
    },
    rejectBtnText: {
        fontSize: auxFontSizes.secondary,
        color: theme.colors.textSecondary,
    },
    approveBtn: {
        backgroundColor: theme.colors.successText,
    },
    approveBtnText: {
        fontSize: auxFontSizes.secondary,
        color: theme.colors.white,
        fontWeight: 'bold',
    },
    inputArea: {
        paddingHorizontal: 14,
        paddingVertical: 8,
        backgroundColor: theme.colors.surface,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border,
        position: 'relative',
        zIndex: 25,
    },
    attachMenuPopover: {
        position: 'absolute',
        bottom: '100%',
        left: 14,
        marginBottom: 8,
        backgroundColor: theme.colors.white,
        borderRadius: 14,
        paddingVertical: 4,
        paddingHorizontal: 4,
        minWidth: 140,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.12,
        shadowRadius: 10,
        elevation: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
        zIndex: 100,
    },
    attachMenuItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderRadius: 10,
    },
    attachMenuIconBg: {
        width: 30,
        height: 30,
        borderRadius: 8,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 10,
    },
    attachMenuPhotoBg: {
        backgroundColor: '#EFF6FF',
    },
    attachMenuDocBg: {
        backgroundColor: '#FEF3C7',
    },
    attachMenuText: {
        fontWeight: '500',
        color: theme.colors.text,
    },
    attachMenuDivider: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.inputBg,
        marginHorizontal: 8,
        marginVertical: 1,
    },
    draftAttachmentsScroll: {
        marginBottom: 6,
        maxHeight: 76,
    },
    draftAttachmentsContent: {
        alignItems: 'center',
        paddingHorizontal: 2,
        paddingTop: 4,
    },
    draftAttachmentCard: {
        position: 'relative',
        marginRight: 10,
    },
    draftImageThumb: {
        width: 58,
        height: 58,
        borderRadius: 8,
        backgroundColor: theme.colors.border,
    },
    draftFileBox: {
        flexDirection: 'row',
        alignItems: 'center',
        height: 58,
        paddingHorizontal: 10,
        backgroundColor: theme.colors.border,
        borderRadius: 8,
        maxWidth: 160,
    },
    draftFileName: {
        fontSize: auxFontSizes.caption,
        color: theme.colors.text,
        marginLeft: 4,
        flexShrink: 1,
    },
    draftDeleteBadge: {
        position: 'absolute',
        top: -4,
        right: -4,
        width: 18,
        height: 18,
        borderRadius: 9,
        backgroundColor: 'rgba(0, 0, 0, 0.55)',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 10,
    },
    draftAttachments: {
        marginBottom: 8,
        maxHeight: 72,
    },
    draftAttachment: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.background,
        borderRadius: 12,
        padding: 6,
        marginRight: 8,
        maxWidth: 220,
    },
    draftImage: {
        width: 48,
        height: 48,
        borderRadius: 6,
    },
    draftAttachmentName: {
        flexShrink: 1,
        maxWidth: 120,
        marginHorizontal: 6,
        fontSize: auxFontSizes.caption,
        color: theme.colors.text,
    },
    draftAttachmentRemove: {
        padding: 8,
    },
    inputCapsule: {
        backgroundColor: theme.colors.background,
        borderRadius: 22,
        paddingHorizontal: 8,
        paddingTop: 6,
        paddingBottom: Platform.OS === 'ios' ? 6 : 4,
    },
    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 38,
    },
    plusBtn: {
        width: 32,
        height: 32,
        borderRadius: 16,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 4,
    },
    plusBtnActive: {
        backgroundColor: '#E0E7FF',
    },
    attachmentImage: {
        width: 200,
        height: 140,
        borderRadius: 10,
        marginBottom: 6,
        backgroundColor: theme.colors.border,
    },
    attachmentFileBox: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 8,
        marginBottom: 6,
        maxWidth: 240,
    },
    attachmentFileBoxUser: {
        backgroundColor: 'rgba(255, 255, 255, 0.2)',
    },
    attachmentFileBoxAssistant: {
        backgroundColor: theme.colors.border,
    },
    attachmentFileIcon: {
        marginRight: 6,
    },
    attachmentFileName: {
        fontSize: auxFontSizes.secondary,
        fontWeight: '500',
        flexShrink: 1,
    },
    attachmentFileNameUser: {
        color: theme.colors.white,
    },
    attachmentFileNameAssistant: {
        color: theme.colors.text,
    },
    chatInput: {
        flex: 1,
        maxHeight: 120,
        minHeight: 36,
        paddingHorizontal: 4,
        paddingVertical: 6,
        color: theme.colors.text,
        lineHeight: 20,
    },
    sendBtnActive: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: theme.colors.primary,
        justifyContent: 'center',
        alignItems: 'center',
        marginLeft: 6,
    },
    sendBtnDisabled: {
        backgroundColor: theme.colors.chevron,
    },
    stopBtnActive: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: theme.colors.primary,
        justifyContent: 'center',
        alignItems: 'center',
        marginLeft: 6,
    },
    stopSquare: {
        width: 12,
        height: 12,
        backgroundColor: theme.colors.white,
        borderRadius: 2,
    },
    scrollBottomContainer: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        alignItems: 'center',
        zIndex: 10,
    },
    scrollBottomBtn: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: '#D9EAFD',
        justifyContent: 'center',
        alignItems: 'center',
        elevation: 4,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.15,
        shadowRadius: 4,
    },
    toastContainer: {
        position: 'absolute',
        top: 20,
        left: 0,
        right: 0,
        alignItems: 'center',
        zIndex: 9999,
        elevation: 10,
    },
    toastPill: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(31, 41, 55, 0.92)',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 20,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
        elevation: 6,
    },
    toastIcon: {
        marginRight: 6,
    },
    toastText: {
        color: theme.colors.white,
        fontSize: auxFontSizes.secondary,
        fontWeight: '500',
    },
    slashMenuContainer: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        marginHorizontal: 12,
        marginBottom: 8,
        maxHeight: 220,
        borderWidth: 1,
        borderColor: theme.colors.border,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 4,
        overflow: 'hidden',
    },
    slashMenuList: {
        maxHeight: 220,
    },
    slashMenuContent: {
        paddingVertical: 4,
    },
    slashMenuItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.inputBg,
    },
    slashItemIconWrap: {
        width: 32,
        height: 32,
        borderRadius: 16,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 10,
    },
    slashCommandIcon: {
        backgroundColor: 'rgba(37, 99, 235, 0.1)',
    },
    slashSkillIcon: {
        backgroundColor: 'rgba(107, 114, 128, 0.1)',
    },
    slashItemTextWrap: {
        flex: 1,
    },
    slashItemTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    slashItemLabel: {
        fontWeight: '600',
        color: theme.colors.text,
    },
    slashItemTypeTag: {
        fontSize: auxFontSizes.caption,
        color: theme.colors.textSecondary,
        backgroundColor: theme.colors.inputBg,
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
    },
    slashItemDesc: {
        fontSize: auxFontSizes.caption,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
});
