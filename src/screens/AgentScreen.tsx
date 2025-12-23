import React, { useRef, useEffect, useState } from 'react';
import { View, Text, TextInput, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialIcons';
import Markdown from 'react-native-markdown-display';
import { useAIStore } from '../store/useAIStore';
import { LLMService } from '../services/LLMService';
import { theme } from '../utils/theme';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';
import { AISidebar } from '../components/AISidebar';

type AgentScreenNavigationProp = NativeStackNavigationProp<RootStackParamList>;

import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const AgentScreen = () => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const navigation = useNavigation<AgentScreenNavigationProp>();
    const flatListRef = useRef<FlatList>(null);
    const [inputText, setInputText] = React.useState('');
    const [sidebarVisible, setSidebarVisible] = useState(false);

    const {
        sessions,
        currentSessionId,
        createSession,
        updateSessionTitle,
        isLoading,
        config,
        addMessage,
        setLoading
    } = useAIStore();

    // Derived state
    const currentSession = sessions.find(s => s.id === currentSessionId);
    const messages = currentSession?.messages || [];

    // Auto-create session if none exists
    useEffect(() => {
        if (!currentSessionId && sessions.length === 0) {
            createSession();
        }
    }, [currentSessionId, sessions.length, createSession]);

    // 检查配置
    useEffect(() => {
        if (!config.apiKey && !isLoading) {
            // 如果没有 API Key，增加一条系统提示
            // 仅当确实没有任何消息时才显示（针对新用户的引导）
            if (messages.length === 0 && sessions.length <= 1) {
                // Logic kept simple to avoid store side-effects during render
            }
        }
    }, [config.apiKey, isLoading, messages.length]);

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
        createSession();
        setInputText('');
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
                        <Markdown style={markdownStyles}>
                            {item.content}
                        </Markdown>
                    )}
                </View>
            </View>
        );
    };

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        >
            <AISidebar visible={sidebarVisible} onClose={() => setSidebarVisible(false)} />

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
                <TouchableOpacity
                    style={[styles.sendButton, !inputText.trim() && styles.sendButtonDisabled]}
                    onPress={handleSend}
                    disabled={!inputText.trim() || isLoading}
                >
                    <Icon name="send" size={24} color={inputText.trim() ? theme.colors.primary : theme.colors.textSecondary} />
                </TouchableOpacity>
            </View>
        </KeyboardAvoidingView>
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
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 4,
        backgroundColor: theme.colors.surface, // White background
        marginTop: 0,
        marginHorizontal: 0, // Full width
        marginBottom: 0, // Touch bottom
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        shadowColor: '#000',
        shadowOffset: {
            width: 0,
            height: -2,
        },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 5,
    },
    input: {
        flex: 1,
        backgroundColor: 'transparent',
        paddingHorizontal: 0, // align with container padding
        paddingVertical: 4,
        minHeight: 56, // Ensure a taller initial height
        borderRadius: 12,
        maxHeight: 120,
        marginRight: 8,
        color: theme.colors.text,
        fontSize: 16,
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

const markdownStyles = {
    body: {
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 24,
    },
    code_inline: {
        backgroundColor: theme.colors.surface, // Surface for code blocks on background
        color: theme.colors.primary,
        borderRadius: 4,
    },
    fence: {
        backgroundColor: theme.colors.surface, // Surface for code blocks on background
        color: theme.colors.text,
        borderColor: theme.colors.border,
        borderWidth: 1,
    }
};
