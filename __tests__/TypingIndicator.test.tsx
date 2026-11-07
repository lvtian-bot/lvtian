import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Animated, StyleSheet, View } from 'react-native';
import { TypingIndicator } from '../src/components/TypingIndicator';
import { colors } from '../src/utils/theme';

describe('TypingIndicator 等待气泡', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

    afterEach(async () => {
        await ReactTestRenderer.act(async () => renderer?.unmount());
        renderer = undefined;
        jest.restoreAllMocks();
    });

    it('保持正常消息气泡的高度与内边距，三个点居中且不拦截操作', async () => {
        await ReactTestRenderer.act(async () => {
            renderer = ReactTestRenderer.create(<TypingIndicator />);
        });
        const row = renderer!.root.findByProps({ testID: 'chat-typing-indicator' });
        expect(row.props.pointerEvents).toBe('none');
        expect(StyleSheet.flatten(row.props.style)).toMatchObject({
            flexDirection: 'row', justifyContent: 'flex-start',
        });
        const bubble = row.findAllByType(View).find((node) =>
            StyleSheet.flatten(node.props.style)?.backgroundColor === colors.inputBg)!;
        const style = StyleSheet.flatten(bubble.props.style);
        expect(style).toMatchObject({
            minHeight: 48, paddingHorizontal: 16, paddingVertical: 12,
            borderRadius: 20, flexDirection: 'row', alignItems: 'center', gap: 5,
        });
        const dots = bubble.findAllByType(Animated.View);
        expect(dots).toHaveLength(3);
        for (const dot of dots) {
            expect(StyleSheet.flatten(dot.props.style)).toMatchObject({ width: 7, height: 7 });
            expect(StyleSheet.flatten(dot.props.style).opacity).toBeInstanceOf(Animated.Value);
        }
        expect(style.minHeight).toBeGreaterThanOrEqual(23 + 2 * style.paddingVertical);
    });

    it('保留循环三点动画，卸载时停止', async () => {
        const start = jest.fn();
        const stop = jest.fn();
        const loop = jest.spyOn(Animated, 'loop').mockReturnValue({
            start, stop, reset: jest.fn(),
        });
        const timing = jest.spyOn(Animated, 'timing');
        await ReactTestRenderer.act(async () => {
            renderer = ReactTestRenderer.create(<TypingIndicator />);
        });
        expect(loop).toHaveBeenCalledTimes(1);
        expect(start).toHaveBeenCalledTimes(1);
        expect(timing).toHaveBeenCalledTimes(6);
        expect(timing).toHaveBeenCalledWith(expect.any(Animated.Value), {
            toValue: 1, duration: 300, useNativeDriver: true,
        });
        expect(timing).toHaveBeenCalledWith(expect.any(Animated.Value), {
            toValue: 0.25, duration: 300, useNativeDriver: true,
        });
        await ReactTestRenderer.act(async () => renderer?.unmount());
        renderer = undefined;
        expect(stop).toHaveBeenCalledTimes(1);
    });
});
