import React, { useRef, useEffect, useState } from 'react';
import { View, Text, TextInput, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform, BackHandler, Animated, Dimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialIcons';
import Markdown from 'react-native-markdown-display';
import { markdownThemes } from '../utils/markdownThemes';
import { useAIStore } from '../store/useAIStore';
import { LLMService } from '../services/LLMService';
import { theme } from '../utils/theme';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';
import { AISidebar } from '../components/AISidebar';
import { AIChatStorageService } from '../services/AIChatStorageService';
import { CloudFilePickerModal } from '../components/CloudFilePickerModal';
import { fsService } from '../services/FileSystemService';
import { syncService } from '../services/SyncService';

type AgentScreenNavigationProp = NativeStackNavigationProp<RootStackParamList>;

import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native'; // Ensure imported if not already, checked file content, it is imported.

export const AgentScreen = () => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const navigation = useNavigation<AgentScreenNavigationProp>();
    const flatListRef = useRef<FlatList>(null);
    const [inputText, setInputText] = React.useState('');
    const [sidebarVisible, setSidebarVisible] = useState(false);
    const [filePickerVisible, setFilePickerVisible] = useState(false);
    const [isProcessingFile, setIsProcessingFile] = useState(false);

    useFocusEffect(
        React.useCallback(() => {
            const onBackPress = () => {
                BackHandler.exitApp();
                return true;
            };

            const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);

            return () => subscription.remove();
        }, [])
    );

    const {
        sessions,
        currentSessionId,
        createSession,
        updateSessionTitle,
        isLoading,
        config,
        addMessage,
        setLoading,
        switchSession, // Add switchSession
    } = useAIStore();

    // Derived state
    const currentSession = sessions.find(s => s.id === currentSessionId);
    const messages = currentSession?.messages || [];

    // 代理页默认空对话，不做任何自动同步操作
    // 懒创建：只有用户发送第一条消息时才创建新会话

    useEffect(() => {
        // 3. Sync Current Session specifically (Content)
        if (currentSessionId) {
            console.log('[AgentScreen] Syncing current session', currentSessionId);
            AIChatStorageService.syncCurrentSession(currentSessionId).then(updated => {
                if (updated) {
                    // Force update if needed, though store should handle it
                    console.log('[AgentScreen] Current session updated from cloud');
                }
            });
        }
    }, [currentSessionId]);

    // 检查配置
    useEffect(() => {
        if (!config.apiKey && !isLoading) {
            // 如果没有 API Key，增加一条系统提示
            // 仅当确实没有任何消息时才显示（针对新用户的引导）
            if (messages.length === 0 && sessions.length <= 1) {
                // Logic kept simple to avoid store side-effects during render
            }
        }
    }, [config.apiKey, isLoading, messages.length, sessions.length]);

    const handleSend = async () => {
        if (!inputText.trim()) return;
        if (!config.apiKey) {
            navigation.navigate('AIConfig');
            return;
        }

        const userMessage = inputText.trim();
        const isFirstMessage = messages.length === 0;
        const targetSessionId = currentSessionId || createSession();

        setInputText('');
        addMessage('user', userMessage);
        setLoading(true);

        try {
            // 获取当前消息列表（包括刚添加的用户消息）
            const updatedSession = useAIStore.getState().sessions.find(s => s.id === targetSessionId);
            const currentHistory = updatedSession?.messages || [];

            const responseText = await LLMService.chatCompletion(currentHistory, config);
            addMessage('assistant', responseText);

            // Generate title if it's the first message
            if (isFirstMessage) {
                LLMService.summarizeTitle(userMessage, config).then(title => {
                    updateSessionTitle(targetSessionId, title);
                });
            }
        } catch (error: any) {
            addMessage('assistant', `${t('ai.error')}: ${error.message || 'Failed to fetch response'}`);
        } finally {
            setLoading(false);
        }
    };

    const handleNewChat = () => {
        switchSession(null); // Lazy creation: just clear current session
        setInputText('');
    };

    const handleFileSelect = async (path: string) => {
        setFilePickerVisible(false);
        setIsProcessingFile(true);

        try {
            // 1. Check if file exists locally
            let content = '';
            const exists = await fsService.exists(path);

            if (exists) {
                content = await fsService.readFile(path);
            } else {
                // 2. Download if missing
                const success = await syncService.performDownload(path);
                if (success) {
                    content = await fsService.readFile(path);
                } else {
                    throw new Error(t('browser.error.downloadFailed') || 'Download failed');
                }
            }

            // 3. Append to Input
            const fileName = path.split('/').pop();
            const attachmentText = `\n\n--- File: ${fileName} ---\n\`\`\`markdown\n${content}\n\`\`\`\n\n`;

            setInputText(prev => {
                const newText = prev + attachmentText;
                return newText;
            });

        } catch (error: any) {
            console.error('Failed to attach file:', error);
            // Optionally show alert
            // Alert.alert(t('common.error'), error.message);
        } finally {
            setIsProcessingFile(false);
        }
    };

    const renderItem = ({ item }: { item: any }) => {
        const isUser = item.role === 'user';
        return (
            <View style={[
                styles.messageBubble,
                isUser ? styles.userBubble : styles.aiBubble
            ]}>
                <View style={[
                    styles.messageContent,
                    isUser ? styles.userMessageContent : styles.aiMessageContent
                ]}>
                    {isUser ? (
                        <Text style={styles.userText}>{item.content}</Text>
                    ) : (
                        <Markdown style={markdownThemes.default}>
                            {item.content}
                        </Markdown>
                    )}
                </View>
            </View>
        );
    };

    const slideAnim = useRef(new Animated.Value(0)).current;
    const screenWidth = Dimensions.get('window').width;
    const sidebarWidth = screenWidth * 0.8;

    useEffect(() => {
        Animated.timing(slideAnim, {
            toValue: sidebarVisible ? sidebarWidth : 0,
            duration: 300,
            useNativeDriver: true,
        }).start();
    }, [sidebarVisible]);

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        >
            <AISidebar visible={sidebarVisible} onClose={() => setSidebarVisible(false)} />

            <Animated.View style={[{ flex: 1 }, { transform: [{ translateX: slideAnim }] }]}>
                <View style={[styles.header, { paddingTop: Math.max(insets.top, 20) + (Platform.OS === 'android' ? 10 : 0) }]}>
                    <TouchableOpacity onPress={() => setSidebarVisible(true)} style={styles.headerButton}>
                        <Icon name="menu" size={24} color={theme.colors.text} />
                    </TouchableOpacity>

                    <Text style={styles.headerTitle} numberOfLines={1}>
                        {currentSession?.title || t('ai.title')}
                    </Text>

                    <TouchableOpacity onPress={handleNewChat} style={styles.headerButton}>
                        <Icon name="add" size={24} color={theme.colors.text} />
                    </TouchableOpacity>
                </View>

                <FlatList
                    ref={flatListRef}
                    data={messages}
                    renderItem={renderItem}
                    keyExtractor={item => item.id}
                    contentContainerStyle={styles.listContent}
                    onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
                    onLayout={() => flatListRef.current?.scrollToEnd({ animated: true })}
                    initialNumToRender={15}
                    maxToRenderPerBatch={10}
                    windowSize={5}
                    removeClippedSubviews={Platform.OS === 'android'}
                />

                {isLoading && (
                    <View style={styles.loadingContainer}>
                        <ActivityIndicator size="small" color={theme.colors.primary} />
                        <Text style={styles.loadingText}>{t('ai.thinking')}</Text>
                    </View>
                )}

                <View style={styles.inputContainer}>
                    <TextInput
                        style={styles.input}
                        value={inputText}
                        onChangeText={setInputText}
                        placeholder={config.apiKey ? t('ai.askPlaceholder') : t('ai.configPlaceholder')}
                        placeholderTextColor={theme.colors.textSecondary}
                        multiline
                    />
                    <View style={styles.buttonRow}>
                        <TouchableOpacity
                            style={[styles.attachButton, isProcessingFile && styles.disabledButton]}
                            onPress={() => setFilePickerVisible(true)}
                            disabled={isProcessingFile || isLoading}
                        >
                            {isProcessingFile ? (
                                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                            ) : (
                                <Icon name="attach-file" size={24} color={theme.colors.textSecondary} />
                            )}
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.sendButton, !inputText.trim() && styles.sendButtonDisabled]}
                            onPress={handleSend}
                            disabled={!inputText.trim() || isLoading}
                        >
                            <Icon name="send" size={24} color={inputText.trim() ? theme.colors.primary : theme.colors.textSecondary} />
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Shadow Overlay - Animate Opacity */}
                <Animated.View
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: 'black',
                        zIndex: 10,
                        opacity: slideAnim.interpolate({
                            inputRange: [0, sidebarWidth],
                            outputRange: [0, 0.3], // Fade to 30% opacity
                            extrapolate: 'clamp'
                        }),
                    }}
                    pointerEvents={sidebarVisible ? 'auto' : 'none'}
                >
                    <TouchableOpacity
                        style={{ flex: 1 }}
                        activeOpacity={1}
                        onPress={() => setSidebarVisible(false)}
                    />
                </Animated.View>
            </Animated.View>


            <CloudFilePickerModal
                visible={filePickerVisible}
                onClose={() => setFilePickerVisible(false)}
                onSelectFile={handleFileSelect}
            />
        </KeyboardAvoidingView >
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background, // Light gray background
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: theme.spacing.m,
        // Removed border to blend with background
        backgroundColor: theme.colors.background,
    },
    headerButton: {
        padding: 4,
    },
    headerTitle: {
        flex: 1,
        textAlign: 'center',
        fontSize: 18,
        fontWeight: 'bold',
        color: theme.colors.text,
        marginHorizontal: 16,
    },
    listContent: {
        padding: theme.spacing.m,
    },
    messageBubble: {
        flexDirection: 'row',
        marginBottom: theme.spacing.m,
        maxWidth: '100%',
    },
    userBubble: {
        justifyContent: 'flex-end',
    },
    aiBubble: {
        justifyContent: 'flex-start',
        width: '100%', // Allow full width for AI responses
    },
    messageContent: {
        maxWidth: '85%',
    },
    userMessageContent: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.primary,
    },
    aiMessageContent: {
        maxWidth: '100%', // Allow text to use available space in the bubble container
        padding: 0, // Remove padding to align with edge/text flow
        // Removed background, border, shadow for natural text look
    },
    userText: {
        color: 'white',
        fontSize: 16,
        lineHeight: 24,
    },
    loadingContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: theme.spacing.m,
        justifyContent: 'flex-start', // Align loading with left side
    },
    loadingText: {
        marginLeft: 8,
        color: theme.colors.textSecondary,
    },
    inputContainer: {
        flexDirection: 'column',
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 4,
        backgroundColor: theme.colors.surface, // White background
        marginTop: 0,
        marginHorizontal: 0, // Full width
        marginBottom: 0, // Touch bottom
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        shadowColor: '#000',
        shadowOffset: {
            width: 0,
            height: -2,
        },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 5,
    },
    buttonRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        width: '100%',
        marginTop: 4,
    },
    input: {
        width: '100%',
        backgroundColor: 'transparent',
        paddingHorizontal: 2, // align with container padding
        paddingVertical: 4,
        minHeight: 40,
        borderRadius: 12,
        maxHeight: 120,
        marginRight: 0,
        color: theme.colors.text,
        fontSize: 16,
        textAlignVertical: 'top',
    },

    attachButton: {
        padding: 8,
        marginRight: 4,
        marginLeft: -12,
    },
    disabledButton: {
        opacity: 0.5,
    },
    sendButton: {
        width: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sendButtonDisabled: {
        // No background change needed for icon-only
    },
});

