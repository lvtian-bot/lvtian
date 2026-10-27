import React, { type ComponentProps, type PropsWithChildren } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { theme } from '../../utils/theme';

export const SettingsGroup: React.FC<PropsWithChildren> = ({ children }) => (
    <View style={styles.group}>{children}</View>
);

export const SettingsGroupLabel: React.FC<PropsWithChildren> = ({ children }) => (
    <Text style={styles.groupLabel}>{children}</Text>
);

interface SettingsRowProps {
    icon: ComponentProps<typeof MaterialCommunityIcons>['name'];
    title: string;
    subtitle?: string;
    /** 行右侧当前值，超长自动省略 */
    value?: string;
    onPress?: () => void;
    /** 组内最后一行，隐藏底部分隔线 */
    last?: boolean;
}

export const SettingsRow: React.FC<SettingsRowProps> = ({
    icon,
    title,
    subtitle,
    value,
    onPress,
    last,
}) => {
    const body = (
        <>
            <View style={styles.rowIcon}>
                <MaterialCommunityIcons name={icon} size={15} color={theme.colors.primaryDark} />
            </View>
            <View style={styles.rowMain}>
                <Text style={styles.rowTitle}>{title}</Text>
                {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
            </View>
            {value ? (
                <Text style={styles.rowValue} numberOfLines={1}>
                    {value}
                </Text>
            ) : null}
            {onPress ? (
                <MaterialCommunityIcons
                    name="chevron-right"
                    size={16}
                    color="#C4CBD6"
                    style={styles.rowChevron}
                />
            ) : null}
        </>
    );

    if (!onPress) {
        return <View style={[styles.row, last && styles.rowLast]}>{body}</View>;
    }

    return (
        <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed, last && styles.rowLast]}
            android_ripple={{ color: '#F0F3F7' }}
            onPress={onPress}
        >
            {body}
        </Pressable>
    );
};

const styles = StyleSheet.create({
    group: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        overflow: 'hidden',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.03,
        shadowRadius: 4,
        elevation: 0.5,
    },
    groupLabel: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.primaryDark,
        letterSpacing: 0.3,
        marginBottom: 6,
        marginTop: 4,
        marginHorizontal: 2,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
        paddingHorizontal: 15,
        paddingVertical: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: '#F0F1F3',
        minHeight: 54,
    },
    rowLast: {
        borderBottomWidth: 0,
    },
    rowPressed: {
        backgroundColor: '#F7F9FC',
    },
    rowIcon: {
        width: 30,
        height: 30,
        borderRadius: 9,
        backgroundColor: theme.colors.primaryLight,
        alignItems: 'center',
        justifyContent: 'center',
    },
    rowMain: {
        flex: 1,
        gap: 1,
    },
    rowTitle: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
    },
    rowSubtitle: {
        fontSize: 11,
        color: '#9AA3B2',
    },
    rowValue: {
        fontSize: 12,
        color: '#8A94A6',
        maxWidth: '40%',
    },
    rowChevron: {
        flexShrink: 0,
    },
});
