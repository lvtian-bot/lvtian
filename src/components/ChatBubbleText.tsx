import React, { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View, useWindowDimensions, type StyleProp, type TextStyle } from 'react-native';
import { theme } from '../utils/theme';
import { auxFontSizes } from '../utils/fontSize';

interface ChatBubbleTextProps {
    text: string;
    time: string;
    textStyle: StyleProp<TextStyle>;
    /** Preserve the renderer's inline Text tree for a terminal Markdown paragraph. */
    children?: ReactNode;
    fullWidth?: boolean;
    clockTestID?: string;
}

interface LineBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Reset the layout regime for typography/window changes, not each streamed token. */
export function ChatBubbleText(props: ChatBubbleTextProps) {
    const { width, fontScale } = useWindowDimensions();
    const identity = JSON.stringify([StyleSheet.flatten(props.textStyle), props.fullWidth, width, fontScale]);
    return <MeasuredBubbleText key={identity} {...props} />;
}

function MeasuredBubbleText({ text, time, textStyle, children, fullWidth = false,
    clockTestID = 'inline-bubble-time' }: ChatBubbleTextProps) {
    const [multiline, setMultiline] = useState(false);
    const [width, setWidth] = useState(0);
    const [body, setBody] = useState<{ text: string; width: number; lines: LineBounds[] }>();
    const [clockMeasurement, setClock] = useState<{ time: string; width: number; height: number }>();
    const clock = clockMeasurement?.time === time ? clockMeasurement : undefined;
    // A real native row gives a new short message its final geometry immediately:
    // no footer-first frame, hidden text, or estimated character widths.
    const row = !fullWidth && !multiline;
    const committed = useRef({ width, time, row, text });
    useLayoutEffect(() => { committed.current = { width, time, row, text }; }, [width, time, row, text]);
    const last = body?.width === width && body.text === text ? body.lines.at(-1) : undefined;
    const inline = !row && !!(last && clock && last.height >= clock.height
        && last.x >= 0 && last.x + last.width + 8 + clock.width <= width);

    return (
        <View style={[styles.container, fullWidth && styles.fullWidth, row && styles.row]}
            onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
            <Text key={row ? 'row' : `measured-${width}`} style={[textStyle, row && styles.rowBody]} selectable
                onTextLayout={(event) => {
                    if (committed.current.width !== width || committed.current.row !== row || committed.current.text !== text) return;
                    if (row) {
                        if (event.nativeEvent.lines.length > 1) setMultiline(true);
                    } else {
                        setBody({ text, width, lines: event.nativeEvent.lines });
                    }
                }}>
                {children ?? text}
            </Text>
            {time ? <Text key={time} style={[styles.clock, row && styles.rowClock, inline && styles.inlineClock,
                inline && { top: last!.y + last!.height - clock!.height },
            ]} testID={clockTestID} accessible={false} selectable={false}
                onLayout={(event) => {
                    if (committed.current.time !== time) return;
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
    fullWidth: { width: '100%', flexShrink: 0 },
    row: { flexDirection: 'row', alignItems: 'flex-end' },
    rowBody: { flexShrink: 1, minWidth: 0 },
    rowClock: { marginLeft: 8, marginTop: 0, flexShrink: 0 },
    clock: { alignSelf: 'flex-end', marginTop: 2, fontSize: auxFontSizes.badge, color: theme.colors.textSecondary },
    inlineClock: { position: 'absolute', right: 0, marginTop: 0 },
});
