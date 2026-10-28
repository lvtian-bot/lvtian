import React, { useState } from 'react';
import { PixelRatio, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { theme } from '../utils/theme';
import { auxFontSizes } from '../utils/fontSize';

interface ChatBubbleTextProps {
    text: string;
    time: string;
    textStyle: StyleProp<TextStyle>;
}

interface LineBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Keep the clock outside selectable content. Only share the last line when
 * native measurements prove there is room; otherwise use a normal footer.
 */
export function ChatBubbleText({ text, time, textStyle }: ChatBubbleTextProps) {
    const [width, setWidth] = useState(0);
    const [body, setBody] = useState<{ text: string; lines: LineBounds[] }>();
    const [clock, setClock] = useState<{ time: string; width: number; height: number }>();
    const lines = body?.text === text ? body.lines : [];
    const last = lines.at(-1);
    const measuredClock = clock?.time === time ? clock : undefined;
    const gap = 8;
    // Grow short bubbles to include the clock, but never exceed the parent's
    // width constraint. Multiline text keeps the full available line width.
    const scale = PixelRatio.get();
    const singleLineWidth = lines.length === 1 && last && measuredClock
        ? Math.ceil((last.width + gap + measuredClock.width) * scale) / scale : undefined;
    const inline = !!(last && measuredClock && last.height >= measuredClock.height
        && last.x + last.width + gap + measuredClock.width <= width);

    return (
        <View style={[styles.container, singleLineWidth !== undefined && { width: singleLineWidth }]}
            onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
            <Text style={textStyle} selectable
                onTextLayout={(event) => setBody({ text, lines: event.nativeEvent.lines })}>
                {text}
            </Text>
            {time ? <Text key={time} style={[styles.clock, inline && styles.inlineClock,
                inline && { top: last!.y + last!.height - measuredClock!.height },
            ]} testID="inline-bubble-time" accessible={false} selectable={false}
                onLayout={(event) => {
                    const { width: clockWidth, height } = event.nativeEvent.layout;
                    setClock((previous) => previous?.time === time && previous.width === clockWidth && previous.height === height
                        ? previous : { time, width: clockWidth, height });
                }}
                accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none">{time}</Text> : null}
        </View>
    );
}

const styles = StyleSheet.create({
    container: { maxWidth: '100%', minWidth: 0 },
    clock: { alignSelf: 'flex-end', marginTop: 2, fontSize: auxFontSizes.badge, color: theme.colors.textSecondary },
    inlineClock: { position: 'absolute', right: 0, marginTop: 0 },
});
