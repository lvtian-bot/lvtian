import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import Icon from '@expo/vector-icons/MaterialIcons';
import { theme } from '../utils/theme';

export const ChatScreen = () => {
    const { t } = useTranslation();

    return (
        <View style={styles.container}>
            <View style={styles.card}>
                <View style={styles.iconWrapper}>
                    <Icon name="smart-toy" size={44} color={theme.colors.primary} />
                </View>
                <Text style={styles.title}>{t('chat.placeholderTitle')}</Text>
                <Text style={styles.description}>{t('chat.placeholderDesc')}</Text>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
        padding: 24,
        justifyContent: 'center',
        alignItems: 'center',
    },
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        padding: 28,
        alignItems: 'center',
        width: '100%',
        maxWidth: 360,
        elevation: 2,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08,
        shadowRadius: 4,
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
    title: {
        fontSize: 18,
        fontWeight: 'bold',
        color: theme.colors.text,
        marginBottom: 12,
        textAlign: 'center',
    },
    description: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        lineHeight: 22,
    },
});
