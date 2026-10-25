import React, { useState, useEffect, useRef, useCallback, useContext, useMemo, forwardRef, type ComponentRef } from 'react';
import {
    View,
    Text,
    Image,
    StyleSheet,
    TextInput,
    TouchableOpacity,
    FlatList,
    ActivityIndicator,
    Alert,
    Platform,
    AppState,
    type LayoutChangeEvent,
    type ScrollViewProps,
    type NativeSyntheticEvent,
    type NativeScrollEvent,
} from 'react-native';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    interpolate,
} from 'react-native-reanimated';
import {
    KeyboardChatScrollView,
    KeyboardStickyView,
    useReanimatedKeyboardAnimation,
    type KeyboardChatScrollViewProps,
} from 'react-native-keyboard-controller';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { fsService } from '../services/FileSystemService';
import Icon from '@expo/vector-icons/MaterialIcons';
import Markdown from 'react-native-markdown-display';
import { TabBarHeightContext } from '../navigation/TabBarHeightContext';
import { theme } from '../utils/theme';
import {
    getInvertedChatScrollTarget,
    getInvertedDistanceFromBottom,
} from '../utils/chatScrollMetrics';
import { useAssistantStore } from '../store/useAssistantStore';
import { AssistantClient } from '../services/AssistantClient';
import { AssistantMessage, ToolCallState } from '../types/assistantProtocol';
import { RootStackParamList } from '../types/navigation';
import i18n from '../i18n';

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

/** 服务端稳定错误码 → i18n 键：按码本地化渲染，未知码与历史中文文案按原文兜底显示 */
const ERROR_CODE_I18N_KEYS: Record<string, string> = {
    task_stopped: 'assistant.errorTaskStopped',
    approval_timeout: 'assistant.errorApprovalTimeout',
    engine_refusal: 'assistant.errorEngineRefusal',
    engine_error: 'assistant.errorEngineError',
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

/** Markdown 全量选择复制规则（正文、行内代码与代码块均开启 selectable） */
const markdownRules = {
    text: (node: any, _children: any, _parent: any, styles: any, inheritedStyles: any = {}) => (
        <Text key={node.key} style={[inheritedStyles, styles.text]} selectable={true}>
            {node.content}
        </Text>
    ),
    textgroup: (node: any, children: any, _parent: any, styles: any) => (
        <Text key={node.key} style={styles.textgroup} selectable={true}>
            {children}
        </Text>
    ),
    code_inline: (node: any, _children: any, _parent: any, styles: any, inheritedStyles: any = {}) => (
        <Text key={node.key} style={[inheritedStyles, styles.code_inline]} selectable={true}>
            {node.content}
        </Text>
    ),
    code_block: (node: any, _children: any, _parent: any, styles: any, inheritedStyles: any = {}) => {
        let content = node.content;
        if (typeof content === 'string' && content.endsWith('\n')) {
            content = content.slice(0, -1);
        }
        return (
            <Text key={node.key} style={[inheritedStyles, styles.code_block]} selectable={true}>
                {content}
            </Text>
        );
    },
    fence: (node: any, _children: any, _parent: any, styles: any, inheritedStyles: any = {}) => {
        let content = node.content;
        if (typeof content === 'string' && content.endsWith('\n')) {
            content = content.slice(0, -1);
        }
        return (
            <Text key={node.key} style={[inheritedStyles, styles.fence]} selectable={true}>
                {content}
            </Text>
        );
    },
};

interface ToolCallsCardProps {
    toolCalls: ToolCallState[];
    isProcessing?: boolean;
}

export function formatToolSummaryLocalized(
    tool: { summary?: string; name?: string },
    t: TFunction
): string {
    const summary = tool.summary;
    if (!summary) return tool.name || '';
    if (summary.startsWith('$')) {
        return summary;
    }
    const match = summary.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (match) {
        const [, action, rest] = match;
        const lowerAction = action.toLowerCase();
        let localizedAction: string | null = null;
        if (lowerAction === 'read') {
            localizedAction = t('assistant.toolActionRead', { defaultValue: '读取' });
        } else if (lowerAction === 'write') {
            localizedAction = t('assistant.toolActionWrite', { defaultValue: '写入' });
        } else if (lowerAction === 'edit') {
            localizedAction = t('assistant.toolActionEdit', { defaultValue: '编辑' });
        } else if (lowerAction === 'search' || lowerAction === 'find') {
            localizedAction = t('assistant.toolActionSearch', { defaultValue: '搜索' });
        } else if (lowerAction === 'fetch') {
            localizedAction = t('assistant.toolActionFetch', { defaultValue: '访问' });
        } else if (lowerAction === 'file') {
            localizedAction = t('assistant.toolActionFile', { defaultValue: '文件' });
        }
        if (localizedAction) {
            return rest ? `${localizedAction} ${rest}` : localizedAction;
        }
    }
    return summary;
}

export const ToolCallsCard: React.FC<ToolCallsCardProps> = ({ toolCalls, isProcessing }) => {
    const { t } = useTranslation();
    const isSingle = toolCalls.length === 1;
    // 多工具调用默认折叠，单工具调用默认展开；在流式执行中新增工具时，未手动干预则自适应折叠
    const [userToggled, setUserToggled] = useState(false);
    const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
    const expanded = userToggled && manualExpanded !== null ? manualExpanded : isSingle;

    const hasRunning =
        toolCalls.some((tc) => tc.status === 'running') ||
        Boolean(isProcessing && toolCalls[toolCalls.length - 1]?.status === 'running');
    const hasFailed = toolCalls.some((tc) => tc.status === 'failed');

    const runningTool = [...toolCalls].reverse().find((tc) => tc.status === 'running');
    const latestTool = toolCalls[toolCalls.length - 1];

    let headerTitle = '';
    if (isSingle) {
        headerTitle = formatToolSummaryLocalized(latestTool, t);
    } else if (hasRunning) {
        const activeName = runningTool
            ? formatToolSummaryLocalized(runningTool, t)
            : t('assistant.executingTool', '系统操作');
        headerTitle = `${t('assistant.runningAction', '正在执行')}: ${activeName}`;
    } else if (hasFailed) {
        headerTitle = `${t('assistant.completedWithErrors', '已执行')} ${toolCalls.length} ${t('assistant.actionsCount', '项操作 (含失败)')}`;
    } else {
        headerTitle = `${t('assistant.completedActions', '已完成')} ${toolCalls.length} ${t('assistant.actionsCount', '项操作')}`;
    }

    return (
        <View style={styles.toolCardContainer}>
            <TouchableOpacity
                style={styles.toolCardHeader}
                activeOpacity={0.7}
                onPress={() => {
                    setUserToggled(true);
                    setManualExpanded(!expanded);
                }}
            >
                <View style={styles.toolCardHeaderLeft}>
                    {hasRunning ? (
                        <ActivityIndicator
                            size="small"
                            color={theme.colors.primaryDark}
                            style={styles.toolStatusIcon}
                        />
                    ) : hasFailed ? (
                        <Icon
                            name="error"
                            size={16}
                            color={theme.colors.dangerText}
                            style={styles.toolStatusIcon}
                        />
                    ) : (
                        <Icon
                            name="check-circle"
                            size={16}
                            color={theme.colors.successText}
                            style={styles.toolStatusIcon}
                        />
                    )}
                    <Text style={styles.toolCardHeaderTitle} numberOfLines={1}>
                        {headerTitle}
                    </Text>
                </View>
                <Icon
                    name={expanded ? 'expand-less' : 'expand-more'}
                    size={20}
                    color="#6B7280"
                />
            </TouchableOpacity>

            {expanded && (
                <View style={styles.toolCardBody}>
                    {toolCalls.map((tool, idx) => {
                        const isCmd = Boolean(tool.summary?.startsWith('$'));
                        const displaySummary = formatToolSummaryLocalized(tool, t);
                        return (
                            <View key={tool.id || idx} style={styles.toolItemRow}>
                                <View style={styles.toolItemHeader}>
                                    <View style={styles.toolItemStatusRow}>
                                        {tool.status === 'running' ? (
                                            <ActivityIndicator
                                                size="small"
                                                color={theme.colors.primaryDark}
                                                style={styles.toolMiniIcon}
                                            />
                                        ) : tool.status === 'done' ? (
                                            <Icon
                                                name="check-circle"
                                                size={13}
                                                color={theme.colors.successText}
                                                style={styles.toolMiniIcon}
                                            />
                                        ) : (
                                            <Icon
                                                name="error"
                                                size={13}
                                                color={theme.colors.dangerText}
                                                style={styles.toolMiniIcon}
                                            />
                                        )}
                                        <Text style={styles.toolItemName}>
                                            {tool.name}
                                        </Text>
                                    </View>
                                </View>
                                {tool.summary ? (
                                    <View style={[styles.toolCommandBox, isCmd ? styles.terminalBox : null]}>
                                        <Text
                                            style={[styles.toolCommandText, isCmd ? styles.terminalText : null]}
                                            selectable={true}
                                        >
                                            {displaySummary}
                                        </Text>
                                    </View>
                                ) : null}
                                {tool.output ? (
                                    <View style={styles.toolOutputBox}>
                                        <Text style={styles.toolOutputText} selectable={true} numberOfLines={8}>
                                            {tool.output.trim()}
                                        </Text>
                                    </View>
                                ) : null}
                            </View>
                        );
                    })}
                </View>
            )}
        </View>
    );
};

export const ChatScreen = () => {
    const { t } = useTranslation();
    const navigation = useNavigation<NavigationProp>();
    const tabBarHeight = useContext(TabBarHeightContext);
    const flatListRef = useRef<FlatList<AssistantMessage>>(null);
    const chatInputRef = useRef<ComponentRef<typeof TextInput>>(null);
    const contentInsetsRef = useRef<{ top: number; bottom: number }>({ top: 0, bottom: 0 });
    const extraContentPadding = useSharedValue(0);
    const composerHeight = useSharedValue(60);

    // 监听应用切回前台（热启动）：彻底阻止软键盘误触自动弹出
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
        connectionState,
        connectionError,
        isServerUpgrading,
        messages,
        taskState,
        pendingApprovals,
        setServerConfig,
    } = useAssistantStore();

    const [inputContent, setInputContent] = useState('');
    const [showScrollBottom, setShowScrollBottom] = useState(false);
    const INITIAL_WINDOW_SIZE = 30;
    const WINDOW_BATCH_SIZE = 30;
    const [renderedCount, setRenderedCount] = useState(INITIAL_WINDOW_SIZE);

    const queuedCount = messages.filter((m) => m.role === 'user' && m.status === 'queued').length;

    const handleCancelQueued = useCallback((msg: AssistantMessage) => {
        Alert.alert(
            t('assistant.cancelQueuedTitle', '排队中消息'),
            t('assistant.cancelQueuedPrompt', '是否取消该条排队消息？文字将退回输入框。'),
            [
                { text: t('common.cancel', '保留'), style: 'cancel' },
                {
                    text: t('assistant.cancelQueuedConfirm', '取消排队'),
                    style: 'destructive',
                    onPress: () => {
                        AssistantClient.getInstance().cancelQueued(msg.id);
                        setInputContent(msg.content);
                    },
                },
            ]
        );
    }, [t]);

    // 倒序排列：第 0 项为最新消息（处于倒序视口最底部），数组末尾为最早历史消息
    const reversedMessages = useMemo(() => {
        return [...messages].reverse();
    }, [messages]);

    // 视口开窗：冷启动与初始状态仅切片装载最新批次，绝不预加载全量历史
    const displayMessages = useMemo(() => {
        return reversedMessages.slice(0, renderedCount);
    }, [reversedMessages, renderedCount]);

    // 用户往上翻阅历史（触达倒序列表末尾）时，增量开窗加载更早记录
    const handleLoadEarlier = useCallback(() => {
        if (renderedCount < reversedMessages.length) {
            setRenderedCount((prev) => Math.min(prev + WINDOW_BATCH_SIZE, reversedMessages.length));
        }
    }, [renderedCount, reversedMessages.length]);

    const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const offsetY = event.nativeEvent.contentOffset.y;
        // 倒序列表中，根据顶部 inset 补偿计算视口距最新消息的物理距离；向旧消息上滑时距离增大
        const distanceFromBottom = getInvertedDistanceFromBottom(offsetY, contentInsetsRef.current.top);
        setShowScrollBottom(distanceFromBottom > 160);
    }, []);

    const scrollToBottom = useCallback(() => {
        const targetOffset = getInvertedChatScrollTarget(contentInsetsRef.current.top);
        flatListRef.current?.scrollToOffset({ offset: targetOffset, animated: true });
    }, []);

    const renderListFooter = useCallback(() => {
        if (renderedCount < reversedMessages.length) {
            return (
                <View style={styles.loadMoreContainer}>
                    <ActivityIndicator size="small" color="#9CA3AF" />
                    <Text style={styles.loadMoreText}>
                        {t('assistant.loadingEarlierMessages', '正在加载更早历史...')}
                    </Text>
                </View>
            );
        }
        return null;
    }, [renderedCount, reversedMessages.length, t]);

    useEffect(() => {
        // 自动连接
        if (serverUrl) {
            AssistantClient.getInstance().connect();
        }
    }, [serverUrl]);

    const pickImage = useCallback(async () => {
        try {
            const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images'],
                allowsEditing: false,
                quality: 0.8,
                base64: true,
            });
            if (!result.canceled && result.assets && result.assets.length > 0) {
                const asset = result.assets[0];
                const base64Data = asset.base64 || undefined;
                const approxSize = asset.fileSize ?? (base64Data ? Math.round((base64Data.length * 3) / 4) : 0);
                if (approxSize > 750 * 1024) {
                    Alert.alert(t('common.notice', '提示'), t('chat.attachmentTooLarge', '附件体积过大（上限 750KB）'));
                    return;
                }
                const name = asset.fileName || `image_${Date.now()}.jpg`;
                // expo-image-picker 在开启 base64 导出时统一压缩输出为 JPEG 编码，匹配声明类型以防模型 Provider 拒收
                const mimeType = base64Data ? 'image/jpeg' : (asset.mimeType || 'image/jpeg');
                const text = inputContent.trim() || t('chat.attachedImage', '发送了图片');
                setInputContent('');
                const targetOffset = getInvertedChatScrollTarget(contentInsetsRef.current.top);
                flatListRef.current?.scrollToOffset({ offset: targetOffset, animated: true });
                AssistantClient.getInstance().sendMessage(text, [
                    {
                        type: 'image',
                        name,
                        mimeType,
                        size: asset.fileSize,
                        uri: asset.uri,
                        data: base64Data,
                    },
                ]);
            }
        } catch {
            Alert.alert(t('common.error', '错误'), t('chat.pickImageError', '选择图片失败'));
        }
    }, [inputContent, t]);

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
                    readResult = await fsService.readAttachment(asset.uri, 750 * 1024, mimeType, name);
                } catch (readErr: unknown) {
                    const errorMsg = readErr instanceof Error ? readErr.message : String(readErr);
                    if (errorMsg === 'ATTACHMENT_TOO_LARGE') {
                        Alert.alert(t('common.notice', '提示'), t('chat.attachmentTooLarge', '附件体积过大（上限 750KB）'));
                    } else {
                        Alert.alert(t('common.error', '错误'), t('chat.attachmentReadError', '读取附件文件失败'));
                    }
                    return;
                }

                const text = inputContent.trim() || `${t('chat.attachedFile', '发送了文件')}: ${name}`;
                setInputContent('');
                const targetOffset = getInvertedChatScrollTarget(contentInsetsRef.current.top);
                flatListRef.current?.scrollToOffset({ offset: targetOffset, animated: true });
                AssistantClient.getInstance().sendMessage(text, [
                    {
                        type: 'file',
                        name,
                        mimeType,
                        size: readResult.size || asset.size,
                        uri: asset.uri,
                        content: readResult.content,
                        data: readResult.data,
                    },
                ]);
            }
        } catch {
            Alert.alert(t('common.error', '错误'), t('chat.pickDocumentError', '选择文件失败'));
        }
    }, [inputContent, t]);

    const handlePlusAction = useCallback(() => {
        Alert.alert(
            t('chat.addAttachment', '添加内容'),
            undefined,
            [
                {
                    text: t('chat.pickImage', '图片'),
                    onPress: () => {
                        pickImage();
                    },
                },
                {
                    text: t('chat.pickDocument', '文件'),
                    onPress: () => {
                        pickDocument();
                    },
                },
                { text: t('common.cancel', '取消'), style: 'cancel' },
            ],
            { cancelable: true },
        );
    }, [pickDocument, pickImage, t]);

    const handleRetryMessage = useCallback(async (item: AssistantMessage) => {
        let attachments = item.attachments;
        if (attachments && attachments.length > 0) {
            try {
                attachments = await Promise.all(
                    attachments.map(async (att) => {
                        if (att.data || att.content) {
                            return att;
                        }
                        if (!att.uri) {
                            throw new Error('ATTACHMENT_URI_MISSING');
                        }
                        const isImg = att.type === 'image';
                        const res = await fsService.readAttachment(att.uri, 750 * 1024, isImg ? 'image/jpeg' : att.mimeType, att.name);
                        return {
                            ...att,
                            mimeType: isImg ? 'image/jpeg' : (att.mimeType || 'application/octet-stream'),
                            content: res.content,
                            data: res.data,
                        };
                    }),
                );
            } catch {
                Alert.alert(t('common.error', '错误'), t('chat.retryAttachmentFailed', '附件原文件已失效，无法重新发送'));
                return;
            }
        }
        // 关键修复：重发前先从本地状态中移除该条失败消息，避免重发后列表中残留重复的失败气泡与红感叹号
        useAssistantStore.getState().removeMessage(item.id);
        const targetOffset = getInvertedChatScrollTarget(contentInsetsRef.current.top);
        flatListRef.current?.scrollToOffset({ offset: targetOffset, animated: true });
        AssistantClient.getInstance().sendMessage(item.content, attachments);
    }, [t]);

    const handleSend = () => {
        const text = inputContent.trim();
        if (!text) return;
        setInputContent('');
        const targetOffset = getInvertedChatScrollTarget(contentInsetsRef.current.top);
        flatListRef.current?.scrollToOffset({ offset: targetOffset, animated: true });
        AssistantClient.getInstance().sendMessage(text);
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
                await setServerConfig(parsed.url, parsed.token);
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

    // 1. 未配置连接时的引导界面
    if (!serverUrl) {
        return (
            <View style={styles.centerContainer}>
                <View style={styles.guideCard}>
                    <View style={styles.iconWrapper}>
                        <Icon name="smart-toy" size={44} color={theme.colors.primary} />
                    </View>
                    <Text style={styles.guideTitle}>{t('assistant.notConnectedTitle', '尚未连接绿天助理服务')}</Text>
                    <Text style={styles.guideDesc}>
                        {t('assistant.notConnectedDesc', '助理服务运行在您的电脑或 VPS 上，提供常驻后台任务、记忆系统与长连接对话。')}
                    </Text>

                    <TouchableOpacity
                        style={styles.primaryBtn}
                        onPress={() => navigation.navigate('AssistantConfig')}
                        activeOpacity={0.8}
                    >
                        <Icon name="settings" size={20} color="#fff" />
                        <Text style={styles.primaryBtnText}>{t('assistant.goToConfig', '前往配置服务')}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.secondaryBtn}
                        onPress={handlePasteQuickConnect}
                        activeOpacity={0.8}
                    >
                        <Icon name="content-paste" size={18} color={theme.colors.primary} />
                        <Text style={styles.secondaryBtnText}>{t('assistant.pasteConfig', '一键粘贴完整配置链接')}</Text>
                    </TouchableOpacity>
                </View>
            </View>
        );
    }

    // 2. 正常聊天界面
    // 聊天消息列表与输入区分别使用库提供的聊天滚动视图和键盘粘附视图
    return (
        <View style={styles.chatContainer}>
            {/* 服务端升级中温和提示横幅；升级期间隐藏普通未连接条，消除断网误解 */}
            {isServerUpgrading ? (
                <View style={styles.upgradingBanner}>
                    <Text style={styles.upgradingBannerText}>
                        {t('assistant.serverUpgradingBanner', '⚡ 服务端正在升级新版本，稍候数秒自动恢复')}
                    </Text>
                </View>
            ) : connectionState !== 'connected' ? (
                <View style={styles.statusBar}>
                    <View
                        style={[
                            styles.statusDot,
                            connectionState === 'connecting' || connectionState === 'reconnecting'
                                ? styles.dotConnecting
                                : styles.dotDisconnected,
                        ]}
                    />
                    <Text style={styles.statusText}>
                        {connectionState === 'connecting' || connectionState === 'reconnecting'
                            ? t('assistant.statusConnecting', '正在连接...')
                            : connectionError || t('assistant.statusDisconnected', '服务未连接')}
                    </Text>

                    <TouchableOpacity
                        style={styles.reconnectBtn}
                        onPress={() => AssistantClient.getInstance().connect()}
                    >
                        <Text style={styles.reconnectBtnText}>{t('browser.retry', '重试')}</Text>
                    </TouchableOpacity>
                </View>
            ) : null}

            {/* 消息流列表：倒序模型 (inverted)，最新消息处于视口物理原点 0，冷启动无需滚动即在最新 */}
            <FlatList
                ref={flatListRef}
                data={displayMessages}
                inverted={true}
                keyExtractor={(item) => item.id}
                contentContainerStyle={styles.messageList}
                keyboardShouldPersistTaps="handled"
                onScroll={handleScroll}
                scrollEventThrottle={16}
                onEndReached={handleLoadEarlier}
                onEndReachedThreshold={0.3}
                initialNumToRender={15}
                maxToRenderPerBatch={15}
                windowSize={11}
                renderScrollComponent={renderChatScrollComponent}
                ListFooterComponent={renderListFooter}
                renderItem={({ item }) => {
                    const isUser = item.role === 'user';
                    const hasTools = Boolean(item.toolCalls && item.toolCalls.length > 0);
                    return (
                        <View
                            style={[
                                styles.messageRow,
                                isUser ? styles.userRow : styles.assistantRow,
                            ]}
                        >
                            <View
                                style={[
                                    styles.bubble,
                                    isUser
                                        ? styles.userBubble
                                        : [
                                              styles.assistantBubble,
                                              hasTools ? styles.assistantBubbleWithTools : null,
                                          ],
                                ]}
                            >
                                {item.attachments && item.attachments.map((att, idx) => {
                                    const imageUri = att.type === 'image'
                                        ? (att.data ? `data:${att.mimeType || 'image/jpeg'};base64,${att.data}` : att.uri)
                                        : undefined;
                                    return imageUri ? (
                                        <Image
                                            key={idx}
                                            source={{ uri: imageUri }}
                                            style={styles.attachmentImage}
                                            resizeMode="cover"
                                        />
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
                                                color={isUser ? '#fff' : theme.colors.primary}
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
                                        <Text style={styles.userText} selectable={true}>
                                            {item.content}
                                        </Text>
                                        {item.status === 'error' && item.errorMessage && (
                                            <Text style={styles.userErrorText}>
                                                {translateErrorMessage(item.errorMessage)}
                                            </Text>
                                        )}
                                    </View>
                                ) : (
                                    <View style={styles.assistantContentContainer}>
                                        {/* 工具活动状态：DSH 规范可折叠卡片 */}
                                        {hasTools && (
                                            <ToolCallsCard
                                                toolCalls={item.toolCalls!}
                                                isProcessing={item.status === 'processing'}
                                            />
                                        )}

                                        {/* 思考中打字机动画 */}
                                        {item.status === 'processing' && !item.content && (
                                            <View style={styles.thinkingRow}>
                                                <ActivityIndicator
                                                    size="small"
                                                    color={theme.colors.primary}
                                                />
                                                <Text style={styles.thinkingText}>
                                                    {t('assistant.thinkingText', '绿天正在思考中...')}
                                                </Text>
                                            </View>
                                        )}

                                        {/* Markdown 内容（支持划词选词复制） */}
                                        {!!item.content && (
                                            <Markdown style={markdownStyles} rules={markdownRules}>
                                                {item.content}
                                            </Markdown>
                                        )}

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
                                <View style={styles.msgFooter}>
                                    {isUser && item.status === 'queued' && (
                                        <TouchableOpacity
                                            style={styles.queuedBadge}
                                            onPress={() => handleCancelQueued(item)}
                                            activeOpacity={0.7}
                                        >
                                            <Icon name="schedule" size={12} color="#4B5563" style={styles.queuedIcon} />
                                            <Text style={styles.queuedText}>{t('assistant.statusQueued', '排队中')}</Text>
                                        </TouchableOpacity>
                                    )}
                                    <Text
                                        style={[
                                            styles.timeText,
                                            isUser ? styles.userTime : styles.assistantTime,
                                        ]}
                                    >
                                        {new Date(item.timestamp).toLocaleTimeString([], {
                                            hour: '2-digit',
                                            minute: '2-digit',
                                        })}
                                    </Text>
                                    {isUser && item.status === 'sending' && (
                                        <ActivityIndicator size={10} color={theme.colors.primaryDark} style={styles.statusMargin} />
                                    )}
                                    {isUser && item.status === 'error' && (
                                        <TouchableOpacity
                                            onPress={() => {
                                                handleRetryMessage(item);
                                            }}
                                        >
                                            <Icon
                                                name="error-outline"
                                                size={14}
                                                color={theme.colors.dangerStrong}
                                                style={styles.statusMargin}
                                            />
                                        </TouchableOpacity>
                                    )}
                                </View>
                            </View>
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
                        <Icon name="arrow-downward" size={18} color="#2563EB" />
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
                        <Text style={styles.approvalTitle}>{t('assistant.approvalRequired', '需要人工审批')}</Text>
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

            {/* 停止执行悬浮条 */}
            {(taskState === 'processing' || taskState === 'awaiting_approval') && (
                <View style={styles.stopBar}>
                    <Text style={styles.stopBarText}>
                        {queuedCount > 0
                            ? t('assistant.taskRunningWithQueue', '助理正在执行任务 · {{count}}条消息排队中', { count: queuedCount })
                            : t('assistant.taskRunning', '助理正在执行任务...')}
                    </Text>
                    <TouchableOpacity style={styles.stopBtn} onPress={handleStop}>
                        <Icon name="stop" size={16} color="#fff" />
                        <Text style={styles.stopBtnText}>{t('assistant.stop', '停止执行')}</Text>
                    </TouchableOpacity>
                </View>
            )}

            {/* 底部输入区 */}
            <View style={styles.inputArea}>
                <View style={styles.inputCapsule}>
                    <TouchableOpacity
                        style={styles.plusBtn}
                        onPress={handlePlusAction}
                        activeOpacity={0.7}
                        accessibilityRole="button"
                        accessibilityLabel={t('chat.addAttachment', '添加内容')}
                    >
                        <Icon name="add" size={24} color="#4B5563" />
                    </TouchableOpacity>
                    <TextInput
                        ref={chatInputRef}
                        autoFocus={false}
                        style={styles.chatInput}
                        placeholder={t('assistant.inputPlaceholder', '消息')}
                        placeholderTextColor="#9CA3AF"
                        value={inputContent}
                        onChangeText={setInputContent}
                        multiline
                        maxLength={2000}
                        onLayout={handleInputLayout}
                    />
                    {inputContent.trim() ? (
                        <TouchableOpacity
                            style={styles.sendBtnActive}
                            onPress={handleSend}
                            activeOpacity={0.8}
                        >
                            <Icon name="arrow-upward" size={18} color="#fff" />
                        </TouchableOpacity>
                    ) : null}
                </View>
            </View>
            </KeyboardStickyView>
        </View>
    );
};

const markdownStyles = {
    body: {
        color: '#111827',
        fontSize: 15,
        lineHeight: 22,
    },
    heading1: {
        color: '#111827',
        fontSize: 18,
        fontWeight: '700' as const,
        marginTop: 10,
        marginBottom: 6,
    },
    heading2: {
        color: '#111827',
        fontSize: 16,
        fontWeight: '700' as const,
        marginTop: 8,
        marginBottom: 4,
    },
    heading3: {
        color: '#111827',
        fontSize: 15,
        fontWeight: '700' as const,
        marginTop: 6,
        marginBottom: 4,
    },
    paragraph: {
        marginTop: 2,
        marginBottom: 4,
    },
    list_item: {
        marginVertical: 2,
    },
    bullet_list: {
        marginVertical: 4,
    },
    ordered_list: {
        marginVertical: 4,
    },
    code_inline: {
        color: '#111827',
        backgroundColor: '#E5E7EB',
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 2,
        fontSize: 13,
        fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    },
    fence: {
        backgroundColor: '#E5E7EB',
        borderRadius: 8,
        padding: 10,
        fontSize: 13,
        fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
        color: '#111827',
        marginVertical: 6,
        borderWidth: 0,
    },
    code_block: {
        backgroundColor: '#E5E7EB',
        borderRadius: 8,
        padding: 10,
        fontSize: 13,
        fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
        color: '#111827',
        marginVertical: 6,
        borderWidth: 0,
    },
    hr: {
        backgroundColor: '#E5E7EB',
        height: 1,
        marginVertical: 8,
    },
    strong: {
        fontWeight: '700' as const,
        color: '#111827',
    },
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
        fontSize: 18,
        fontWeight: 'bold',
        color: theme.colors.text,
        marginBottom: 8,
        textAlign: 'center',
    },
    guideDesc: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        lineHeight: 22,
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
        color: '#fff',
        fontSize: 15,
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
        fontSize: 14,
        fontWeight: '600',
        marginLeft: 6,
    },
    chatContainer: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    keyboardSticky: {
        backgroundColor: theme.colors.background,
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
        fontSize: 13,
        color: theme.colors.warnText,
        fontWeight: '500',
    },
    statusBar: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.warnBgStrong,
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.warnBorder,
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        marginRight: 8,
    },
    dotConnecting: {
        backgroundColor: theme.colors.warnText,
    },
    dotDisconnected: {
        backgroundColor: theme.colors.textSecondary,
    },
    statusText: {
        fontSize: 12,
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
        fontSize: 12,
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
        fontSize: 12,
        color: '#9CA3AF',
    },
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
    userBubble: {
        backgroundColor: '#D9EAFD',
        maxWidth: '85%',
    },
    assistantBubble: {
        backgroundColor: '#F0F2F5',
        maxWidth: '92%',
        minWidth: 48,
    },
    assistantBubbleWithTools: {
        width: '92%',
    },
    assistantContentContainer: {
        width: '100%',
    },
    userText: {
        color: '#111827',
        fontSize: 15,
        lineHeight: 23,
    },
    toolCardContainer: {
        width: '100%',
        backgroundColor: '#E5E7EB',
        borderRadius: 10,
        marginBottom: 8,
        overflow: 'hidden',
    },
    toolCardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    toolCardHeaderLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        marginRight: 6,
    },
    toolStatusIcon: {
        marginRight: 8,
    },
    toolCardHeaderTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: '#374151',
        flex: 1,
    },
    toolCardBody: {
        paddingHorizontal: 8,
        paddingBottom: 8,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: '#D1D5DB',
    },
    toolItemRow: {
        marginTop: 6,
    },
    toolItemHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 3,
    },
    toolItemStatusRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    toolMiniIcon: {
        marginRight: 4,
    },
    toolItemName: {
        fontSize: 11,
        color: '#6B7280',
        fontWeight: '600',
        textTransform: 'uppercase',
    },
    toolCommandBox: {
        backgroundColor: '#F3F4F6',
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderWidth: 1,
        borderColor: '#E5E7EB',
    },
    terminalBox: {
        backgroundColor: '#1E293B',
        borderColor: '#0F172A',
    },
    toolCommandText: {
        fontSize: 12,
        color: '#1F2937',
        fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
        lineHeight: 18,
    },
    terminalText: {
        color: '#34D399',
    },
    toolOutputBox: {
        backgroundColor: 'rgba(0, 0, 0, 0.04)',
        borderRadius: 4,
        padding: 6,
        marginTop: 4,
    },
    toolOutputText: {
        fontSize: 11,
        color: '#4B5563',
        fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
        lineHeight: 16,
    },
    thinkingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 6,
    },
    thinkingText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginLeft: 8,
    },
    errorText: {
        fontSize: 12,
        color: theme.colors.dangerText,
        marginTop: 6,
    },
    truncatedText: {
        fontSize: 12,
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
        fontSize: 11,
    },
    statusMargin: {
        marginLeft: 4,
    },
    userTime: {
        color: 'rgba(17, 24, 39, 0.5)',
    },
    assistantTime: {
        color: '#9CA3AF',
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
        fontSize: 14,
        fontWeight: 'bold',
        color: theme.colors.warnText,
        marginLeft: 6,
    },
    approvalPrompt: {
        fontSize: 13,
        color: theme.colors.text,
        lineHeight: 18,
        marginBottom: 4,
    },
    approvalSub: {
        fontSize: 12,
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
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    approveBtn: {
        backgroundColor: theme.colors.successText,
    },
    approveBtnText: {
        fontSize: 13,
        color: '#fff',
        fontWeight: 'bold',
    },
    stopBar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: theme.colors.warnBg,
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: theme.colors.warnBorder,
    },
    stopBarText: {
        fontSize: 13,
        color: theme.colors.warnText,
    },
    stopBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.dangerStrong,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 5,
    },
    stopBtnText: {
        color: '#fff',
        fontSize: 12,
        fontWeight: 'bold',
        marginLeft: 4,
    },
    inputArea: {
        paddingHorizontal: 14,
        paddingVertical: 8,
        backgroundColor: theme.colors.surface,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: '#E5E7EB',
    },
    inputCapsule: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#F0F2F5',
        borderRadius: 24,
        paddingHorizontal: 8,
        paddingVertical: Platform.OS === 'ios' ? 6 : 2,
        minHeight: 46,
    },
    plusBtn: {
        width: 32,
        height: 32,
        borderRadius: 16,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 4,
    },
    attachmentImage: {
        width: 200,
        height: 140,
        borderRadius: 10,
        marginBottom: 6,
        backgroundColor: '#E5E7EB',
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
        backgroundColor: '#E5E7EB',
    },
    attachmentFileIcon: {
        marginRight: 6,
    },
    attachmentFileName: {
        fontSize: 13,
        fontWeight: '500',
        flexShrink: 1,
    },
    attachmentFileNameUser: {
        color: '#fff',
    },
    attachmentFileNameAssistant: {
        color: '#111827',
    },
    chatInput: {
        flex: 1,
        maxHeight: 120,
        minHeight: 36,
        paddingHorizontal: 4,
        paddingVertical: 6,
        fontSize: 15,
        color: '#111827',
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
    queuedBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#E5E7EB',
        borderRadius: 10,
        paddingHorizontal: 6,
        paddingVertical: 1,
        marginRight: 6,
    },
    queuedIcon: {
        marginRight: 3,
    },
    queuedText: {
        fontSize: 11,
        color: '#4B5563',
        fontWeight: '500',
    },
    userErrorText: {
        fontSize: 12,
        color: theme.colors.dangerStrong,
        marginTop: 4,
    },
});
