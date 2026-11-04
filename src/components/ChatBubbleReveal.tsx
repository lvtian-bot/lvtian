import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';

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
export function ChatBubbleReveal({ children, style, streaming = false, layoutKey }: {
    children: ReactNode;
    style: StyleProp<ViewStyle>;
    streaming?: boolean;
    layoutKey: string;
}) {
    const { width, fontScale } = useWindowDimensions();
    return <RevealRow key={JSON.stringify([layoutKey, width, fontScale])} style={style} streaming={streaming}>
        {children}
    </RevealRow>;
}

function RevealRow({ children, style, streaming }: {
    children: ReactNode; style: StyleProp<ViewStyle>; streaming: boolean;
}) {
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
    return <BubbleLayoutContext.Provider value={context}>
        <View style={[style, !visible && styles.measuring]} pointerEvents={visible ? 'auto' : 'none'}
            accessibilityElementsHidden={!visible} importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}>
            {children}
        </View>
    </BubbleLayoutContext.Provider>;
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
});
