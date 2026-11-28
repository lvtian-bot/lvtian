import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { useChatConnectionPresentation } from '../hooks/useChatConnectionPresentation';
import { type ChatHeaderConnectionMode } from '../utils/chatConnectionPresentation';
import { theme } from '../utils/theme';

const STATUS_TRANSITION_MS = 180;

function getHeaderStatusText(
    mode: Exclude<ChatHeaderConnectionMode, 'title'>,
    t: (key: string, defaultValue: string) => string,
): string {
    switch (mode) {
        case 'waiting_network':
            return t('assistant.headerWaitingNetwork', '等待网络…');
        case 'updating':
            return t('assistant.headerUpdating', '更新中…');
        case 'connecting':
        default:
            return t('assistant.headerConnecting', '连接中…');
    }
}

/**
 * Telegram 风格主聊天顶栏标题：
 * 默认显示页面标题；仅在网络离线或连接超出宽限期时平滑过渡为细小转圈状态指示，不改变顶栏高度。
 */
export const ChatHeaderTitle: React.FC = () => {
    const { t } = useTranslation();
    const { headerMode } = useChatConnectionPresentation();
    const reduceMotion = useReducedMotion();
    const hasMountedRef = useRef(false);
    const prevModeRef = useRef<ChatHeaderConnectionMode>(headerMode);

    const opacity = useSharedValue(1);
    const translateY = useSharedValue(0);

    useEffect(() => {
        if (!hasMountedRef.current) {
            hasMountedRef.current = true;
            prevModeRef.current = headerMode;
            return;
        }
        if (prevModeRef.current === headerMode) return;
        prevModeRef.current = headerMode;

        if (reduceMotion) {
            opacity.value = 1;
            translateY.value = 0;
            return;
        }

        opacity.value = 0.25;
        translateY.value = 3;
        opacity.value = withTiming(1, { duration: STATUS_TRANSITION_MS });
        translateY.value = withTiming(0, { duration: STATUS_TRANSITION_MS });
    }, [headerMode, opacity, translateY, reduceMotion]);

    const animatedStyle = useAnimatedStyle(() => ({
        opacity: opacity.value,
        transform: [{ translateY: translateY.value }],
    }));

    const isStatus = headerMode !== 'title';
    const label = isStatus ? getHeaderStatusText(headerMode, t) : t('tabs.chat');

    return (
        <Animated.View
            style={[styles.container, animatedStyle]}
            accessibilityRole="header"
            accessibilityLiveRegion="polite"
            testID="chat-header-title"
        >
            {isStatus && (
                <View style={styles.spinnerSlot} testID="chat-header-spinner">
                    <ActivityIndicator
                        size={Platform.OS === 'android' ? 15 : 'small'}
                        color={theme.colors.textSecondary}
                        style={Platform.OS === 'ios' ? styles.iosSpinnerScale : undefined}
                    />
                </View>
            )}
            <Text style={styles.titleText} numberOfLines={1} ellipsizeMode="tail">
                {label}
            </Text>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    container: {
        height: 28,
        maxWidth: 220,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
    },
    spinnerSlot: {
        width: 16,
        height: 16,
        marginRight: 6,
        alignItems: 'center',
        justifyContent: 'center',
    },
    iosSpinnerScale: {
        transform: [{ scale: 0.78 }],
    },
    titleText: {
        fontSize: 17,
        fontWeight: '600',
        color: theme.colors.text,
        includeFontPadding: false,
    },
});
