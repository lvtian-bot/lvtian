import React, { ComponentProps } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { theme } from '../utils/theme';

interface SettingsRowProps {
    label: string;
    /** 左侧图标（MaterialCommunityIcons 名称），省略则纯文本行 */
    icon?: ComponentProps<typeof MaterialCommunityIcons>['name'];
    iconColor?: string;
    /** 行右侧当前值（如设置项当前取值），灰字展示在箭头前 */
    value?: string;
    onPress?: () => void;
    disabled?: boolean;
    /** 右侧跟随的小型加载指示（如切换请求进行中） */
    busy?: boolean;
}

/**
 * 全 App 统一的设置行组件（Journal 风格列表分组内的标准行）：
 * 左侧图标与标题，右侧当前值与箭头，触摸涟漪与按压高亮。
 * 「我」页导航行与各设置二级页的值行共用本组件，样式不再各页另写。
 */
export const SettingsRow: React.FC<SettingsRowProps> = ({
    label,
    icon,
    iconColor = theme.colors.textSecondary,
    value,
    onPress,
    disabled = false,
    busy = false,
}) => (
    <Pressable
        style={({ pressed }) => [styles.row, pressed && !disabled && styles.rowPressed]}
        android_ripple={disabled ? undefined : { color: '#E5E7EB' }}
        onPress={onPress}
        disabled={disabled || !onPress}
    >
        <View style={styles.left}>
            {icon ? (
                <MaterialCommunityIcons
                    name={icon}
                    size={22}
                    color={iconColor}
                    style={styles.icon}
                />
            ) : null}
            <Text style={[styles.text, disabled && styles.textDisabled]}>{label}</Text>
        </View>
        <View style={styles.right}>
            {busy ? (
                <ActivityIndicator size="small" color={theme.colors.primary} style={styles.spinner} />
            ) : null}
            {value ? (
                <Text style={styles.value} numberOfLines={1}>
                    {value}
                </Text>
            ) : null}
            {onPress ? (
                <MaterialCommunityIcons
                    name="chevron-right"
                    size={20}
                    color={theme.colors.textSecondary}
                />
            ) : null}
        </View>
    </Pressable>
);

export const settingsGroupStyle = StyleSheet.create({
    /** 分组卡片容器：与行组件配套使用，各页面引用保持分组视觉一致 */
    group: {
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.sm,
        shadowColor: '#000',
        shadowOpacity: 0.03,
        shadowOffset: { width: 0, height: 1 },
        shadowRadius: 4,
        elevation: 0.5,
        overflow: 'hidden',
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.border,
        marginLeft: theme.spacing.m + 24 + theme.spacing.m,
    },
});

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: theme.spacing.m,
        paddingVertical: 12,
        minHeight: 52,
    },
    rowPressed: {
        backgroundColor: '#F3F4F6',
    },
    left: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    icon: {
        marginRight: theme.spacing.m,
        width: 24,
        textAlign: 'center',
    },
    text: {
        fontSize: 16,
        color: theme.colors.text,
    },
    textDisabled: {
        color: theme.colors.textSecondary,
    },
    right: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    value: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginRight: 4,
        maxWidth: 160,
    },
    spinner: {
        marginRight: 6,
    },
});
