import React, { type ComponentProps } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { theme } from '../../utils/theme';
import { useSettingsFont } from './useSettingsFont';
import { auxFontSizes } from '../../utils/fontSize';

interface SettingsStatusCardProps {
    /** 传入则显示页面图标，否则显示状态圆点 */
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
                <MaterialCommunityIcons name={icon} size={22} color={theme.colors.primaryDark} />
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
            android_ripple={{ color: theme.colors.bgPressed }}
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
        backgroundColor: theme.colors.bgPressed,
    },
    dot: {
        width: 9,
        height: 9,
        borderRadius: 5,
        backgroundColor: theme.colors.success,
    },
    dotMuted: {
        backgroundColor: theme.colors.chevron,
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
        fontSize: auxFontSizes.secondary,
        color: theme.colors.textTertiary,
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
        backgroundColor: theme.colors.hairline,
    },
    badgeText: {
        fontSize: auxFontSizes.caption,
        fontWeight: '600',
    },
    badgeTextOk: {
        color: theme.colors.successText,
    },
    badgeTextMuted: {
        color: theme.colors.textTertiary,
    },
});
