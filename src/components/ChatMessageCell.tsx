import React, { createContext, useContext, type ComponentProps } from 'react';
import type { FlatListProps } from 'react-native';
import Animated, { Easing, withTiming, type LayoutAnimationFunction } from 'react-native-reanimated';
import type { ChatTimelineMessage } from '../utils/chatTimeline';

export const CHAT_SEND_SLIDE_MS = 250;
const slideTiming = {
    duration: CHAT_SEND_SLIDE_MS,
    easing: Easing.bezier(0.19919472913616398, 0.010644531250000006, 0.27920937042459737, 0.91025390625),
};

export const ChatSendSlideContext = createContext<ReadonlyMap<string, 'measuring' | 'sliding'>>(new Map());

const moveCell: LayoutAnimationFunction = (layout) => {
    'worklet';
    return {
        initialValues: { originY: layout.currentOriginY, height: layout.targetHeight },
        animations: { originY: withTiming(layout.targetOriginY, slideTiming) },
    };
};

const slideInCell: LayoutAnimationFunction = (layout) => {
    'worklet';
    if (layout.currentHeight > 0 || layout.targetHeight <= 0) return moveCell(layout);
    // The list's native axis is inverted. Starting one row earlier puts the
    // fully sized bubble below its destination on screen.
    return {
        initialValues: { originY: layout.targetOriginY - layout.targetHeight, height: layout.targetHeight },
        animations: { originY: withTiming(layout.targetOriginY, slideTiming) },
    };
};

type ChatMessageCellProps = ComponentProps<NonNullable<FlatListProps<ChatTimelineMessage>['CellRendererComponent']>>;

export function ChatMessageCell({ item, children, style, onLayout, onFocusCapture }: ChatMessageCellProps) {
    const slides = useContext(ChatSendSlideContext);
    const layout = slides.size === 0 ? undefined : slides.has(item.id) ? slideInCell : moveCell;
    return <Animated.View collapsable={false} style={style} onLayout={onLayout}
        onFocusCapture={onFocusCapture} layout={layout}>
        {children}
    </Animated.View>;
}
