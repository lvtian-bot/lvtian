import React, { useState, useEffect, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TextInput,
    TouchableOpacity,
    FlatList,
    KeyboardAvoidingView,
    Platform,
    ActivityIndicator,
    Alert,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';
import Icon from '@expo/vector-icons/MaterialIcons';
import Markdown from 'react-native-markdown-display';
import { theme } from '../utils/theme';
import { useAssistantStore } from '../store/useAssistantStore';
import { AssistantClient } from '../services/AssistantClient';
import { AssistantMessage } from '../types/assistantProtocol';
import { RootStackParamList } from '../types/navigation';

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

export const ChatScreen = () => {
    const { t } = useTranslation();
    const navigation = useNavigation<NavigationProp>();
    const flatListRef = useRef<FlatList<AssistantMessage>>(null);

    const {
        serverUrl,
        connectionState,
        connectionError,
        messages,
        taskState,
        pendingApproval,
        setServerConfig,
    } = useAssistantStore();

    const [inputContent, setInputContent] = useState('');
    const lastMessageContent = messages[messages.length - 1]?.content;

    useEffect(() => {
        // 自动连接
        if (serverUrl) {
            AssistantClient.getInstance().connect();
        }
    }, [serverUrl]);

    // 收到新消息自动滚动到底部
    useEffect(() => {
        if (messages.length > 0) {
            setTimeout(() => {
                flatListRef.current?.scrollToEnd({ animated: true });
            }, 100);
        }
    }, [messages.length, lastMessageContent]);

    const handleSend = () => {
        const text = inputContent.trim();
        if (!text) return;
        setInputContent('');
        AssistantClient.getInstance().sendMessage(text);
    };

    const handleStop = () => {
        AssistantClient.getInstance().stopExecution();
    };

    const handleApproval = (approved: boolean) => {
        if (!pendingApproval) return;
        AssistantClient.getInstance().respondApproval(pendingApproval.approvalId, approved);
    };

    const handlePasteQuickConnect = async () => {
        try {
            const text = await Clipboard.getStringAsync();
            if (!text.trim()) {
                Alert.alert(t('common.notice', '提示'), t('assistant.clipboardEmpty', '剪贴板内容为空'));
                return;
            }
            const parsed = AssistantClient.parseConnectionUrl(text);
            if (parsed.url) {
                await setServerConfig(parsed.url, parsed.token);
                AssistantClient.getInstance().connect();
                Alert.alert(t('common.success', '成功'), t('assistant.configApplied', '已成功解析并应用配置'));
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
    return (
        <KeyboardAvoidingView
            style={styles.chatContainer}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        >
            {/* 顶栏连接状态指示条 */}
            <View style={styles.statusBar}>
                <View
                    style={[
                        styles.statusDot,
                        connectionState === 'connected'
                            ? styles.dotConnected
                            : connectionState === 'connecting' || connectionState === 'reconnecting'
                            ? styles.dotConnecting
                            : styles.dotDisconnected,
                    ]}
                />
                <Text style={styles.statusText}>
                    {connectionState === 'connected'
                        ? t('assistant.statusConnected', '已连接服务')
                        : connectionState === 'connecting' || connectionState === 'reconnecting'
                        ? t('assistant.statusConnecting', '正在连接...')
                        : connectionError || t('assistant.statusDisconnected', '服务未连接')}
                </Text>

                {connectionState !== 'connected' && (
                    <TouchableOpacity
                        style={styles.reconnectBtn}
                        onPress={() => AssistantClient.getInstance().connect()}
                    >
                        <Text style={styles.reconnectBtnText}>{t('browser.retry', '重试')}</Text>
                    </TouchableOpacity>
                )}
            </View>

            {/* 消息流列表 */}
            <FlatList
                ref={flatListRef}
                data={messages}
                keyExtractor={(item) => item.id}
                contentContainerStyle={styles.messageList}
                renderItem={({ item }) => {
                    const isUser = item.role === 'user';
                    return (
                        <View
                            style={[
                                styles.messageRow,
                                isUser ? styles.userRow : styles.assistantRow,
                            ]}
                        >
                            {!isUser && (
                                <View style={styles.assistantAvatar}>
                                    <Icon name="smart-toy" size={18} color="#fff" />
                                </View>
                            )}
                            <View
                                style={[
                                    styles.bubble,
                                    isUser ? styles.userBubble : styles.assistantBubble,
                                ]}
                            >
                                {isUser ? (
                                    <Text style={styles.userText}>{item.content}</Text>
                                ) : (
                                    <View>
                                        {/* 工具活动状态 */}
                                        {item.toolCalls && item.toolCalls.length > 0 && (
                                            <View style={styles.toolsContainer}>
                                                {item.toolCalls.map((tool) => (
                                                    <View key={tool.id} style={styles.toolTag}>
                                                        <Icon
                                                            name={
                                                                tool.status === 'running'
                                                                    ? 'sync'
                                                                    : tool.status === 'done'
                                                                    ? 'check-circle'
                                                                    : 'error'
                                                            }
                                                            size={14}
                                                            color={
                                                                tool.status === 'running'
                                                                    ? '#1976d2'
                                                                    : tool.status === 'done'
                                                                    ? '#2e7d32'
                                                                    : '#c62828'
                                                            }
                                                        />
                                                        <Text style={styles.toolText}>
                                                            {tool.summary || tool.name}
                                                        </Text>
                                                    </View>
                                                ))}
                                            </View>
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

                                        {/* Markdown 内容 */}
                                        {!!item.content && (
                                            <Markdown style={markdownStyles}>
                                                {item.content}
                                            </Markdown>
                                        )}

                                        {/* 错误提示 */}
                                        {item.status === 'error' && item.errorMessage && (
                                            <Text style={styles.errorText}>
                                                {item.errorMessage}
                                            </Text>
                                        )}
                                    </View>
                                )}

                                {/* 时间与状态 */}
                                <View style={styles.msgFooter}>
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
                                        <ActivityIndicator size={10} color="#fff" style={styles.statusMargin} />
                                    )}
                                    {isUser && item.status === 'error' && (
                                        <TouchableOpacity
                                            onPress={() =>
                                                AssistantClient.getInstance().sendMessage(item.content)
                                            }
                                        >
                                            <Icon
                                                name="error-outline"
                                                size={14}
                                                color="#ffcdd2"
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

            {/* 人工审批卡片 */}
            {pendingApproval && (
                <View style={styles.approvalCard}>
                    <View style={styles.approvalHeader}>
                        <Icon name="warning" size={20} color="#f57c00" />
                        <Text style={styles.approvalTitle}>{t('assistant.approvalRequired', '需要人工审批')}</Text>
                    </View>
                    <Text style={styles.approvalPrompt}>{pendingApproval.prompt}</Text>
                    {pendingApproval.toolName && (
                        <Text style={styles.approvalSub}>
                            {t('assistant.toolRequested', '请求调用的工具')}: {pendingApproval.toolName}
                        </Text>
                    )}
                    <View style={styles.approvalBtnRow}>
                        <TouchableOpacity
                            style={[styles.approvalBtn, styles.rejectBtn]}
                            onPress={() => handleApproval(false)}
                        >
                            <Text style={styles.rejectBtnText}>{t('assistant.reject', '拒绝')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.approvalBtn, styles.approveBtn]}
                            onPress={() => handleApproval(true)}
                        >
                            <Text style={styles.approveBtnText}>{t('assistant.approve', '同意执行')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            )}

            {/* 停止执行悬浮条 */}
            {(taskState === 'processing' || taskState === 'awaiting_approval') && (
                <View style={styles.stopBar}>
                    <Text style={styles.stopBarText}>{t('assistant.taskRunning', '助理正在执行任务...')}</Text>
                    <TouchableOpacity style={styles.stopBtn} onPress={handleStop}>
                        <Icon name="stop" size={16} color="#fff" />
                        <Text style={styles.stopBtnText}>{t('assistant.stop', '停止执行')}</Text>
                    </TouchableOpacity>
                </View>
            )}

            {/* 底部输入区 */}
            <View style={styles.inputArea}>
                <TextInput
                    style={styles.chatInput}
                    placeholder={t('assistant.inputPlaceholder', '向绿天助理输入想法或指令...')}
                    placeholderTextColor={theme.colors.textSecondary}
                    value={inputContent}
                    onChangeText={setInputContent}
                    multiline
                    maxLength={2000}
                />
                <TouchableOpacity
                    style={[
                        styles.sendBtn,
                        !inputContent.trim() ? styles.sendBtnDisabled : styles.sendBtnActive,
                    ]}
                    onPress={handleSend}
                    disabled={!inputContent.trim()}
                >
                    <Icon name="send" size={20} color="#fff" />
                </TouchableOpacity>
            </View>
        </KeyboardAvoidingView>
    );
};

const markdownStyles = {
    body: {
        color: theme.colors.text,
        fontSize: 15,
        lineHeight: 22,
    },
    code_inline: {
        backgroundColor: '#f0f0f0',
        borderRadius: 4,
        paddingHorizontal: 4,
        fontSize: 13,
    },
    fence: {
        backgroundColor: '#f5f5f5',
        borderRadius: 6,
        padding: 8,
        fontSize: 13,
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
        backgroundColor: '#e8f5e9',
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
        backgroundColor: '#e8f5e9',
        borderRadius: 10,
        paddingVertical: 11,
        width: '100%',
        borderWidth: 1,
        borderColor: '#c8e6c9',
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
    statusBar: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#fafafa',
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: '#ebebeb',
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        marginRight: 8,
    },
    dotConnected: {
        backgroundColor: '#2e7d32',
    },
    dotConnecting: {
        backgroundColor: '#f57c00',
    },
    dotDisconnected: {
        backgroundColor: '#9e9e9e',
    },
    statusText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        flex: 1,
    },
    reconnectBtn: {
        paddingHorizontal: 8,
        paddingVertical: 2,
        backgroundColor: '#eeeeee',
        borderRadius: 4,
    },
    reconnectBtnText: {
        fontSize: 12,
        color: theme.colors.text,
    },
    messageList: {
        padding: 16,
        paddingBottom: 24,
    },
    messageRow: {
        flexDirection: 'row',
        marginBottom: 16,
    },
    userRow: {
        justifyContent: 'flex-end',
    },
    assistantRow: {
        justifyContent: 'flex-start',
    },
    assistantAvatar: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: theme.colors.primary,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 8,
        marginTop: 4,
    },
    bubble: {
        maxWidth: '82%',
        borderRadius: 14,
        paddingHorizontal: 14,
        paddingVertical: 10,
        elevation: 1,
    },
    userBubble: {
        backgroundColor: theme.colors.primary,
        borderBottomRightRadius: 2,
    },
    assistantBubble: {
        backgroundColor: theme.colors.surface,
        borderBottomLeftRadius: 2,
        borderWidth: 1,
        borderColor: '#f0f0f0',
    },
    userText: {
        color: '#fff',
        fontSize: 15,
        lineHeight: 22,
    },
    toolsContainer: {
        marginBottom: 8,
    },
    toolTag: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#f5f5f5',
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 4,
        marginBottom: 4,
    },
    toolText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginLeft: 6,
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
        color: '#c62828',
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
        color: 'rgba(255, 255, 255, 0.7)',
    },
    assistantTime: {
        color: theme.colors.textSecondary,
    },
    approvalCard: {
        backgroundColor: '#fff3e0',
        borderRadius: 12,
        padding: 14,
        marginHorizontal: 16,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: '#ffe0b2',
    },
    approvalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 6,
    },
    approvalTitle: {
        fontSize: 14,
        fontWeight: 'bold',
        color: '#e65100',
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
        backgroundColor: '#eeeeee',
    },
    rejectBtnText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    approveBtn: {
        backgroundColor: '#2e7d32',
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
        backgroundColor: '#fffde7',
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: '#fff9c4',
    },
    stopBarText: {
        fontSize: 13,
        color: '#f57f17',
    },
    stopBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#d32f2f',
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
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: theme.colors.surface,
        borderTopWidth: 1,
        borderTopColor: '#ebebeb',
    },
    chatInput: {
        flex: 1,
        maxHeight: 100,
        backgroundColor: '#f5f5f5',
        borderRadius: 18,
        paddingHorizontal: 14,
        paddingTop: 8,
        paddingBottom: 8,
        fontSize: 15,
        color: theme.colors.text,
        marginRight: 8,
    },
    sendBtn: {
        width: 38,
        height: 38,
        borderRadius: 19,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 1,
    },
    sendBtnActive: {
        backgroundColor: theme.colors.primary,
    },
    sendBtnDisabled: {
        backgroundColor: '#c8e6c9',
    },
});
