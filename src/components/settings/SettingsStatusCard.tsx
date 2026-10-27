import React, { type ComponentProps } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { theme } from '../../utils/theme';
import { useSettingsFont } from './useSettingsFont';

interface SettingsStatusCardProps {
    /** 传入则显示圆底图标，否则显示状态圆点 */
    icon?: ComponentProps<typeof MaterialCommunityIcons>['name'];
    tone: 'success' | 'muted';
    title: string;
    subtitle?: string;
    badge?: string;
    onPress?: () => void;
}

export const SettingsStatusCard: React.FC<SettingsStatusCardProps> = ({
    icon,
    tone,
    title,
    subtitle,
    badge,
    onPress,
}) => {
    const font = useSettingsFont();
    const body = (
        <>
            {icon ? (
                <View style={styles.iconWrap}>
                    <MaterialCommunityIcons
                        name={icon}
                        size={20}
                        color={theme.colors.primaryDark}
                    />
                </View>
            ) : (
                <View style={[styles.dot, tone === 'muted' && styles.dotMuted]} />
            )}
            <View style={styles.main}>
                <Text style={[styles.title, { fontSize: font.chatBody }]}>{title}</Text>
                {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
            </View>
            {badge ? (
                <View style={[styles.badge, tone === 'muted' ? styles.badgeMuted : styles.badgeOk]}>
                    <Text
                        style={[
                            styles.badgeText,
                            tone === 'muted' ? styles.badgeTextMuted : styles.badgeTextOk,
                        ]}
                    >
                        {badge}
                    </Text>
                </View>
            ) : null}
        </>
    );

    if (!onPress) {
        return <View style={styles.card}>{body}</View>;
    }

    return (
        <Pressable
            style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
            android_ripple={{ color: '#F0F3F7' }}
            onPress={onPress}
        >
            {body}
        </Pressable>
    );
};

const styles = StyleSheet.create({
    card: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        padding: 14,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.03,
        shadowRadius: 4,
        elevation: 0.5,
    },
    cardPressed: {
        backgroundColor: '#F7F9FC',
    },
    dot: {
        width: 9,
        height: 9,
        borderRadius: 5,
        backgroundColor: theme.colors.success,
    },
    dotMuted: {
        backgroundColor: '#C4CBD6',
    },
    iconWrap: {
        width: 38,
        height: 38,
        borderRadius: 12,
        backgroundColor: theme.colors.primaryLight,
        alignItems: 'center',
        justifyContent: 'center',
    },
    main: {
        flex: 1,
        gap: 2,
    },
    title: {
        fontWeight: '600',
        color: theme.colors.text,
    },
    subtitle: {
        fontSize: 13,
        color: '#8A94A6',
    },
    badge: {
        paddingHorizontal: 9,
        paddingVertical: 3,
        borderRadius: 999,
    },
    badgeOk: {
        backgroundColor: theme.colors.successBg,
    },
    badgeMuted: {
        backgroundColor: '#F0F1F3',
    },
    badgeText: {
        fontSize: 12,
        fontWeight: '600',
    },
    badgeTextOk: {
        color: theme.colors.successText,
    },
    badgeTextMuted: {
        color: '#8A94A6',
    },
});
