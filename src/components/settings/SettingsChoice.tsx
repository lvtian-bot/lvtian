import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { theme } from '../../utils/theme';
import { useSettingsFont } from './useSettingsFont';
import { settingsFont } from './tokens';

interface SettingsChoiceProps {
    title: string;
    desc?: string;
    badge?: string;
    selected?: boolean;
    danger?: boolean;
    disabled?: boolean;
    onPress: () => void;
}

export const SettingsChoice: React.FC<SettingsChoiceProps> = ({
    title,
    desc,
    badge,
    selected,
    danger,
    disabled,
    onPress,
}) => {
    const font = useSettingsFont();
    const activeTone = danger ? 'danger' : 'primary';
    return (
        <TouchableOpacity
            style={[
                styles.choice,
                selected && (activeTone === 'danger' ? styles.choiceDangerActive : styles.choiceActive),
                disabled && styles.choiceDisabled,
            ]}
            onPress={onPress}
            activeOpacity={0.7}
            disabled={disabled}
        >
            <View style={styles.main}>
                <View style={styles.titleRow}>
                    <Text
                        style={[
                            styles.title,
                            { fontSize: font.chatBody },
                            selected && (activeTone === 'danger' ? styles.titleDangerActive : styles.titleActive),
                        ]}
                    >
                        {title}
                    </Text>
                    {badge ? (
                        <View style={styles.badgeWrap}>
                            <View style={styles.badge}>
                                <Text style={styles.badgeText}>{badge}</Text>
                            </View>
                        </View>
                    ) : null}
                </View>
                {desc ? <Text style={styles.desc}>{desc}</Text> : null}
            </View>
            <View
                style={[
                    styles.radio,
                    selected
                        ? activeTone === 'danger'
                            ? styles.radioDangerActive
                            : styles.radioActive
                        : null,
                ]}
            >
                {selected ? (
                    <View
                        style={[
                            styles.radioInner,
                            activeTone === 'danger' && styles.radioInnerDanger,
                        ]}
                    />
                ) : null}
            </View>
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    choice: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderRadius: 12,
        paddingVertical: 12,
        paddingHorizontal: 10,
    },
    choiceActive: {
        backgroundColor: theme.colors.primaryLight,
    },
    choiceDangerActive: {
        backgroundColor: theme.colors.warnBg,
    },
    choiceDisabled: {
        opacity: 0.45,
    },
    main: {
        flex: 1,
        gap: 3,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
    },
    title: {
        fontWeight: '600',
        color: theme.colors.text,
    },
    titleActive: {
        color: theme.colors.primaryDark,
    },
    titleDangerActive: {
        color: theme.colors.warnText,
    },
    desc: {
        fontSize: settingsFont.secondary,
        color: theme.colors.textTertiary,
        lineHeight: 18,
    },
    badgeWrap: {
        flexShrink: 0,
    },
    badge: {
        backgroundColor: theme.colors.successBg,
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 5,
    },
    badgeText: {
        fontSize: settingsFont.badge,
        fontWeight: '600',
        color: theme.colors.successText,
    },
    radio: {
        width: 18,
        height: 18,
        borderRadius: 9,
        borderWidth: 2,
        borderColor: theme.colors.border,
        alignItems: 'center',
        justifyContent: 'center',
    },
    radioActive: {
        borderColor: theme.colors.primary,
    },
    radioDangerActive: {
        borderColor: theme.colors.warning,
    },
    radioInner: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: theme.colors.primary,
    },
    radioInnerDanger: {
        backgroundColor: theme.colors.warning,
    },
});
