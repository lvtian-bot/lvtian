import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, Alert } from 'react-native';
import Icon from '@expo/vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';
import { useAIStore, ChatSession } from '../store/useAIStore';
import { theme } from '../utils/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';

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
        deleteSession,
    } = useAIStore();

    if (!visible) return null;

    const handleSessionPress = (sessionId: string) => {
        switchSession(sessionId);
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

    const renderItem = ({ item }: { item: ChatSession }) => {
        const isActive = item.id === currentSessionId;
        return (
            <TouchableOpacity 
                style={[styles.sessionItem, isActive && styles.activeSessionItem]}
                onPress={() => handleSessionPress(item.id)}
            >
                <Icon 
                    name="chat-bubble-outline" 
                    size={20} 
                    color={isActive ? theme.colors.primary : theme.colors.textSecondary} 
                />
                <Text style={[styles.sessionTitle, isActive && styles.activeSessionTitle]} numberOfLines={1}>
                    {item.title || t('ai.untitled')}
                </Text>
                {isActive && (
                    <TouchableOpacity onPress={() => handleDelete(item.id)} hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
                        <Icon name="delete-outline" size={20} color={theme.colors.error} />
                    </TouchableOpacity>
                )}
            </TouchableOpacity>
        );
    };

    return (
        <View style={styles.overlay}>
            <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
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

                <View style={styles.footer}>
                    <TouchableOpacity 
                        style={styles.footerItem} 
                        onPress={() => {
                            onClose();
                            navigation.navigate('AIConfig');
                        }}
                    >
                        <Icon name="settings" size={20} color={theme.colors.text} />
                        <Text style={styles.footerText}>{t('ai.settingsTitle')}</Text>
                    </TouchableOpacity>
                </View>
            </View>
            <TouchableOpacity style={styles.backdrop} onPress={onClose} activeOpacity={1} />
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
