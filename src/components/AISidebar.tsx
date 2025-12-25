import React, { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, Alert, Animated, Dimensions } from 'react-native';
import Icon from '@expo/vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';
import { useAIStore, ChatSession } from '../store/useAIStore';
import { theme } from '../utils/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';

import { RenameDialog } from './RenameDialog';
import { ActionSheetModal, ActionItem } from './ActionSheetModal';

interface AISidebarProps {
    visible: boolean;
    onClose: () => void;
}

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

export const AISidebar: React.FC<AISidebarProps> = ({ visible, onClose }) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const navigation = useNavigation<NavigationProp>();

    const {
        sessions,
        currentSessionId,
        switchSession,
        updateSessionTitle,
        deleteSession,
    } = useAIStore();

    // UI State for Rename
    const [renameDialogVisible, setRenameDialogVisible] = React.useState(false);
    const [sessionToRename, setSessionToRename] = React.useState<{ id: string, name: string } | null>(null);

    // UI State for ActionSheet
    const [actionSheetVisible, setActionSheetVisible] = React.useState(false);
    const [selectedSession, setSelectedSession] = React.useState<ChatSession | null>(null);

    // 动画相关 - 所有Hooks必须在条件渲染之前声明
    // 动画相关 - 所有Hooks必须在条件渲染之前声明
    const screenWidth = React.useRef(Dimensions.get('window').width).current;
    const sidebarWidth = screenWidth * 0.8;
    const translateX = useRef(new Animated.Value(-sidebarWidth)).current;

    useEffect(() => {
        if (visible) {
            // 显示动画
            Animated.timing(translateX, {
                toValue: 0,
                duration: 300,
                useNativeDriver: true,
            }).start();
        } else {
            // 隐藏动画
            Animated.timing(translateX, {
                toValue: -sidebarWidth,
                duration: 300,
                useNativeDriver: true,
            }).start(() => {
                // 动画结束后将位置重置
                translateX.setValue(-sidebarWidth);
            });
        }
    }, [visible]);

    const handleSessionPress = async (sessionId: string) => {
        await switchSession(sessionId);
        onClose();
    };

    const handleDelete = (sessionId: string) => {
        Alert.alert(
            t('common.confirm'),
            t('ai.confirmDelete'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.delete'),
                    style: 'destructive',
                    onPress: () => deleteSession(sessionId)
                }
            ]
        );
    };

    const handleLongPress = (item: ChatSession) => {
        setSelectedSession(item);
        setActionSheetVisible(true);
    };

    const getActionSheetActions = (): ActionItem[] => {
        if (!selectedSession) return [];
        return [
            {
                label: t('common.edit'), // Changed from common.rename to common.edit to ensure text exists
                icon: 'edit',
                onPress: () => {
                    setSessionToRename({ id: selectedSession.id, name: selectedSession.title });
                    setRenameDialogVisible(true);
                },
            },
            {
                label: t('common.delete'),
                icon: 'delete',
                destructive: true,
                onPress: () => handleDelete(selectedSession.id),
            },
        ];
    };

    const handleRenameConfirm = async (newName: string) => {
        if (sessionToRename) {
            updateSessionTitle(sessionToRename.id, newName);
        }
    };

    const renderItem = ({ item }: { item: ChatSession }) => {
        const isActive = item.id === currentSessionId;
        return (
            <TouchableOpacity
                style={[styles.sessionItem, isActive && styles.activeSessionItem]}
                onPress={() => handleSessionPress(item.id)}
                onLongPress={() => handleLongPress(item)}
                delayLongPress={500}
            >
                <Icon
                    name="chat-bubble-outline"
                    size={20}
                    color={isActive ? theme.colors.primary : theme.colors.textSecondary}
                />

                {item.isPlaceholder && (
                    <Icon name="cloud-download" size={16} color={theme.colors.primary} style={{ marginRight: 4 }} />
                )}

                <Text style={[styles.sessionTitle, isActive && styles.activeSessionTitle]} numberOfLines={1}>
                    {item.title || t('ai.untitled')}
                </Text>
            </TouchableOpacity>
        );
    };

    // 始终渲染组件，但通过动画控制可见性
    // 并在不可见时设置pointerEvents='none'防止点击
    return (
        <View
            style={styles.overlay}
            pointerEvents="box-none"
        >
            <Animated.View style={[
                styles.container,
                {
                    paddingTop: insets.top,
                    paddingBottom: insets.bottom,
                    transform: [{ translateX }]
                }
            ]}>
                <View style={styles.header}>
                    <Text style={styles.headerTitle}>{t('ai.history')}</Text>
                    <TouchableOpacity onPress={onClose}>
                        <Icon name="close" size={24} color={theme.colors.text} />
                    </TouchableOpacity>
                </View>



                <FlatList
                    data={sessions}
                    renderItem={renderItem}
                    keyExtractor={item => item.id}
                    contentContainerStyle={styles.listContent}
                    ListEmptyComponent={
                        <View style={styles.emptyContainer}>
                            <Text style={styles.emptyText}>{t('ai.noSessions')}</Text>
                        </View>
                    }
                />

            </Animated.View>


            <RenameDialog
                visible={renameDialogVisible}
                currentName={sessionToRename?.name || ''}
                onConfirm={handleRenameConfirm}
                onCancel={() => {
                    setRenameDialogVisible(false);
                    setSessionToRename(null);
                }}
            />

            <ActionSheetModal
                visible={actionSheetVisible}
                title={selectedSession?.title || t('ai.untitled')}
                actions={getActionSheetActions()}
                onCancel={() => {
                    setActionSheetVisible(false);
                    setSelectedSession(null);
                }}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    overlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1000,
        flexDirection: 'row',
    },
    backdrop: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
    },
    container: {
        width: '80%',
        backgroundColor: theme.colors.surface,
        borderRightWidth: 1,
        borderRightColor: theme.colors.border,
        display: 'flex',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: theme.spacing.m,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: theme.colors.text,
    },
    listContent: {
        padding: theme.spacing.s,
    },
    sessionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: theme.spacing.m,
        borderRadius: 8,
        marginBottom: 4,
    },
    activeSessionItem: {
        backgroundColor: theme.colors.background,
    },
    sessionTitle: {
        flex: 1,
        marginLeft: 12,
        fontSize: 16,
        color: theme.colors.textSecondary,
    },
    activeSessionTitle: {
        color: theme.colors.text,
        fontWeight: '500',
    },
    emptyContainer: {
        padding: theme.spacing.xl,
        alignItems: 'center',
    },
    emptyText: {
        color: theme.colors.textSecondary,
    },
    footer: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        padding: theme.spacing.m,
    },
    footerItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
    },
    footerText: {
        marginLeft: 12,
        fontSize: 16,
        color: theme.colors.text,
    },
});
