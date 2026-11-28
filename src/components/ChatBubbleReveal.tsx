import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

const SEND_ENTRANCE_DURATION_MS = 160;

interface LayoutRegistry {
    report: (id: symbol, ready: boolean) => void;
    remove: (id: symbol) => void;
}
const BubbleLayoutContext = createContext<{
    registry: LayoutRegistry; streaming: boolean; footerFallback: boolean;
} | null>(null);

/** Measure the real, mounted bubble without exposing its provisional geometry.
 * The row keeps its horizontal constraints but takes no vertical list space until
 * every measured text has a final clock placement. Streaming rows bypass the gate.
 */
export function ChatBubbleReveal({ children, dateSeparator, style, streaming = false, layoutKey, consumeEntrance }: {
    children: ReactNode;
    dateSeparator?: ReactNode;
    style: StyleProp<ViewStyle>;
    streaming?: boolean;
    layoutKey: string;
    consumeEntrance?: () => void;
}) {
    const { width, fontScale } = useWindowDimensions();
    return <RevealRow key={JSON.stringify([layoutKey, width, fontScale])} dateSeparator={dateSeparator}
        style={style} streaming={streaming} consumeEntrance={consumeEntrance}>
        {children}
    </RevealRow>;
}

function RevealRow({ children, dateSeparator, style, streaming, consumeEntrance }: {
    children: ReactNode; dateSeparator?: ReactNode; style: StyleProp<ViewStyle>;
    streaming: boolean; consumeEntrance?: () => void;
}) {
    // Keep the measured subtree mounted when the screen consumes the one-time animation.
    const [animateEntrance] = useState(() => Boolean(consumeEntrance));
    useLayoutEffect(() => consumeEntrance?.(), [consumeEntrance]);
    const [revealed, setRevealed] = useState(streaming);
    const [footerFallback, setFooterFallback] = useState(false);
    const pending = useRef(new Set<symbol>());
    const mounted = useRef(false);
    const registry = useMemo<LayoutRegistry>(() => {
        const flush = () => {
            // Markdown can replace its terminal AST node within one commit.
            // Aggregate after all cleanup/registration effects, not in the gap
            // between removing the old pending node and registering the new one.
            Promise.resolve().then(() => {
                if (mounted.current && pending.current.size === 0) setRevealed(true);
            });
        };
        return {
            report: (id, ready) => {
                if (ready) pending.current.delete(id);
                else pending.current.add(id);
                flush();
            },
            remove: (id) => { pending.current.delete(id); flush(); },
        };
    }, []);
    useLayoutEffect(() => {
        mounted.current = true;
        if (streaming || pending.current.size === 0) setRevealed(true);
        return () => { mounted.current = false; };
    }, [streaming]);
    const visible = revealed || streaming;
    useEffect(() => {
        if (visible) return;
        // A lost/zero-width native callback must never make a message disappear.
        // Latch a normal-flow footer on this row rather than later moving it again.
        const deadline = setTimeout(() => {
            setFooterFallback(true);
            setRevealed(true);
        }, 750);
        return () => clearTimeout(deadline);
    }, [visible]);
    const context = useMemo(() => ({ registry, streaming, footerFallback }), [registry, streaming, footerFallback]);
    const content = <>
        {dateSeparator}
        <View style={[style, !visible && !animateEntrance && styles.measuring]} pointerEvents={visible ? 'auto' : 'none'}
            accessibilityElementsHidden={!visible} importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}>
            {children}
        </View>
    </>;
    return <BubbleLayoutContext.Provider value={context}>
        {animateEntrance ? <OutgoingBubbleEntrance ready={visible}>{content}</OutgoingBubbleEntrance> : content}
    </BubbleLayoutContext.Provider>;
}

function OutgoingBubbleEntrance({ children, ready }: { children: ReactNode; ready: boolean }) {
    const measuredHeight = useRef(0);
    const [measured, setMeasured] = useState(false);
    const contentHeight = useSharedValue(0);
    const progress = useSharedValue(0);

    const handleLayout = ({ nativeEvent: { layout: { height } } }: LayoutChangeEvent) => {
        if (height <= 0 || height === measuredHeight.current) return;
        measuredHeight.current = height;
        contentHeight.value = height;
        setMeasured(true);
    };
    useLayoutEffect(() => {
        if (!ready) return;
        if (measured) {
            progress.value = withTiming(1, { duration: SEND_ENTRANCE_DURATION_MS });
            return;
        }
        const timeout = setTimeout(() => { progress.value = 1; }, SEND_ENTRANCE_DURATION_MS);
        return () => clearTimeout(timeout);
    }, [measured, progress, ready]);

    // Grow the real list space from its bottom edge. The clipped bubble and the
    // older rows move together, even though the bubble has already been measured.
    // Scroll overflow clips this View while letting Yoga measure its child
    // independently of the wrapper's current (initially zero) height.
    const animatedStyle = useAnimatedStyle<ViewStyle>(() => {
        const fraction = progress.value;
        return fraction < 1
            ? { height: contentHeight.value * fraction, overflow: 'scroll' }
            : { height: undefined, overflow: 'visible' };
    });
    return <Animated.View style={[styles.entrance, animatedStyle]}
        accessibilityElementsHidden={!ready} importantForAccessibility={ready ? 'auto' : 'no-hide-descendants'}>
        <View style={styles.entranceContent} onLayout={handleLayout}>{children}</View>
    </Animated.View>;
}

/** No text remount or duplicated selectable measurement tree. */
export function useBubbleLayoutReady(ready: boolean) {
    const registry = useContext(BubbleLayoutContext)?.registry;
    const id = useRef(Symbol('bubble-text')).current;
    useLayoutEffect(() => {
        registry?.report(id, ready);
    }, [registry, id, ready]);
    useLayoutEffect(() => () => registry?.remove(id), [registry, id]);
}

export function useBubbleLayoutPolicy() {
    const context = useContext(BubbleLayoutContext);
    return { streaming: context?.streaming ?? false, footerFallback: context?.footerFallback ?? false };
}

const styles = StyleSheet.create({
    measuring: { height: 0, marginBottom: 0, opacity: 0, overflow: 'hidden', alignItems: 'flex-start' },
    entrance: { justifyContent: 'flex-end' },
    entranceContent: { flexShrink: 0 },
});
