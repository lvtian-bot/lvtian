import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

interface ChatBubbleTextProps {
    text: string;
    time: string;
    textStyle: StyleProp<TextStyle>;
}

/** A same-font inline reservation makes native text wrapping account for the clock.
 * The visible clock occupies that reserved space at the bubble's trailing edge.
 * No character counts, width guesses, or per-stream-chunk measurements are needed.
 */
export function ChatBubbleText({ text, time, textStyle }: ChatBubbleTextProps) {
    return (
        <View style={styles.container}>
            <Text style={textStyle} selectable>
                {text}
                {time ? <Text style={styles.reservation} accessible={false}>{`   ${time}`}</Text> : null}
            </Text>
            {time ? <Text style={styles.clock} testID="inline-bubble-time" accessible={false}
                accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none">{time}</Text> : null}
        </View>
    );
}

const styles = StyleSheet.create({
    container: { maxWidth: '100%', minWidth: 0 },
    reservation: { fontSize: 10, color: 'transparent' },
    clock: {
        position: 'absolute', right: 0, bottom: 0,
        fontSize: 10, color: '#6B7280',
    },
});
