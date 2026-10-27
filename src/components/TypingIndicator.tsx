import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { colors } from '../utils/theme';

/**
 * 列表末尾的“正在工作”指示：三个点循环闪动。
 * 它跟随列表滚动，始终位于最新消息之下，不是悬浮层，也不进入消息数据。
 */
export const TypingIndicator: React.FC<{ testID?: string }> = ({ testID = 'chat-typing-indicator' }) => {
    const dots = useRef([new Animated.Value(0.25), new Animated.Value(0.25), new Animated.Value(0.25)]).current;

    useEffect(() => {
        const loop = Animated.loop(
            Animated.stagger(
                150,
                dots.map((dot) => Animated.sequence([
                    Animated.timing(dot, { toValue: 1, duration: 300, useNativeDriver: true }),
                    Animated.timing(dot, { toValue: 0.25, duration: 300, useNativeDriver: true }),
                ])),
            ),
        );
        loop.start();
        return () => loop.stop();
    }, [dots]);

    return (
        <View style={styles.row} testID={testID} pointerEvents="none">
            <View style={styles.bubble}>
                {dots.map((dot, index) => (
                    <Animated.View key={index} style={[styles.dot, { opacity: dot }]} />
                ))}
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    row: { flexDirection: 'row', justifyContent: 'flex-start', marginVertical: 6 },
    bubble: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.inputBg,
        borderRadius: 16,
        paddingHorizontal: 14,
        paddingVertical: 10,
        gap: 5,
    },
    dot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: colors.textSecondary },
});
