import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Animated, View } from 'react-native';
import { ImageViewerModal } from '../src/components/ImageViewerModal';
import '../src/i18n';

interface Point { id: number; x: number; y: number }
interface TouchRecord {
    touchActive: boolean;
    currentPageX: number;
    currentPageY: number;
    previousPageX: number;
    previousPageY: number;
    currentTimeStamp: number;
}

// Drive the rendered View's real PanResponder handlers, including RN's cumulative
// centroid dx/dy calculation. Do not mock PanResponder or supply gestureState.
class ResponderTouches {
    private bank: TouchRecord[] = [];
    private points: Point[] = [];
    private timestamp = 1;

    constructor(private readonly view: () => ReactTestRenderer.ReactTestInstance) {}

    private event() {
        return {
            nativeEvent: {
                touches: this.points.map(({ id, x, y }) => ({ identifier: id, pageX: x, pageY: y })),
            },
            touchHistory: {
                touchBank: this.bank,
                numberActiveTouches: this.points.length,
                indexOfSingleActiveTouch: this.points[0]?.id ?? -1,
                mostRecentTimeStamp: this.timestamp,
            },
        };
    }

    start(...points: Point[]) {
        const wasEmpty = this.points.length === 0;
        this.timestamp += 10;
        for (const { id, x, y } of points) {
            this.bank[id] = {
                touchActive: true, currentPageX: x, currentPageY: y,
                previousPageX: x, previousPageY: y, currentTimeStamp: this.timestamp,
            };
        }
        this.points.push(...points);
        const event = this.event();
        act(() => {
            if (wasEmpty) {
                this.view().props.onStartShouldSetResponderCapture(event);
                expect(this.view().props.onStartShouldSetResponder(event)).toBe(true);
                this.view().props.onResponderGrant(event);
            }
            this.view().props.onResponderStart(event);
        });
    }

    move(...points: Point[]) {
        this.timestamp += 10;
        for (const { id, x, y } of points) {
            const record = this.bank[id];
            record.previousPageX = record.currentPageX;
            record.previousPageY = record.currentPageY;
            record.currentPageX = x;
            record.currentPageY = y;
            record.currentTimeStamp = this.timestamp;
            this.points = this.points.map((point) => point.id === id ? { id, x, y } : point);
        }
        act(() => this.view().props.onResponderMove(this.event()));
    }

    end(...ids: number[]) {
        this.timestamp += 10;
        for (const id of ids) this.bank[id].touchActive = false;
        this.points = this.points.filter(({ id }) => !ids.includes(id));
        act(() => {
            this.view().props.onResponderEnd(this.event());
            if (this.points.length === 0) this.view().props.onResponderRelease(this.event());
        });
    }

    terminate() {
        act(() => this.view().props.onResponderTerminate(this.event()));
        this.points = [];
        this.bank = [];
    }

    tap() {
        this.start({ id: 0, x: 100, y: 100 });
        this.end(0);
    }
}

describe('ImageViewerModal responder gestures', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    let touches: ResponderTouches;
    let onClose: jest.Mock;
    const advance = (ms: number) => act(() => jest.advanceTimersByTime(ms));
    const transform = () => {
        const entries = renderer.root.findByType(Animated.Image).props.style[1].transform;
        const value = (index: number, key: string): number => entries[index][key].__getValue();
        return { x: value(0, 'translateX'), y: value(1, 'translateY'), scale: value(2, 'scale') };
    };
    const zoom = () => {
        touches.tap();
        advance(100);
        touches.tap();
        expect(transform().scale).toBe(2.5);
    };

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-06-01T12:00:00Z'));
        // Make spring endpoints deterministic, while retaining real Animated.Values
        // and listeners used by the component's gesture calculations.
        jest.spyOn(Animated, 'spring').mockImplementation((value, config) => ({
            start: (callback) => {
                if (!(value instanceof Animated.Value) || typeof config.toValue !== 'number') {
                    throw new Error('Expected numeric spring target and Animated.Value');
                }
                value.setValue(config.toValue);
                callback?.({ finished: true });
            },
            stop: jest.fn(),
            reset: jest.fn(),
        }));
        onClose = jest.fn();
        act(() => {
            renderer = ReactTestRenderer.create(
                <ImageViewerModal visible imageUri="file:///photo.jpg" onClose={onClose} />
            );
        });
        touches = new ResponderTouches(() => renderer.root.findAllByType(View)
            .find((node) => typeof node.props.onResponderGrant === 'function')!);
    });

    afterEach(() => {
        act(() => renderer.unmount());
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    it('rebases single→multi→single drag without reusing pinch displacement on either axis', () => {
        zoom();
        touches.start({ id: 0, x: 100, y: 100 });
        touches.move({ id: 0, x: 130, y: 120 });
        expect(transform()).toEqual({ x: 30, y: 20, scale: 2.5 });
        touches.start({ id: 1, x: 230, y: 120 });
        touches.move({ id: 0, x: 140, y: 130 }, { id: 1, x: 240, y: 130 });
        touches.move({ id: 0, x: 150, y: 160 }, { id: 1, x: 270, y: 160 });
        expect(transform()).toEqual({ x: 30, y: 20, scale: 3 });
        touches.end(1);
        expect(transform()).toEqual({ x: 30, y: 20, scale: 3 });
        touches.move({ id: 0, x: 157, y: 156 });
        expect(transform()).toEqual({ x: 37, y: 16, scale: 3 });
        touches.move({ id: 0, x: 160, y: 162 });
        expect(transform()).toEqual({ x: 40, y: 22, scale: 3 });
        touches.end(0);
        advance(500);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('rebases every repeated pinch transition, even when the next pinch starts before a single-finger move', () => {
        touches.start({ id: 0, x: 100, y: 100 }, { id: 1, x: 200, y: 100 });
        touches.move({ id: 0, x: 100, y: 100 }, { id: 1, x: 200, y: 100 });
        touches.move({ id: 0, x: 80, y: 120 }, { id: 1, x: 280, y: 120 });
        touches.end(1);
        touches.start({ id: 1, x: 180, y: 120 });
        touches.move({ id: 0, x: 90, y: 130 }, { id: 1, x: 190, y: 130 });
        touches.move({ id: 0, x: 100, y: 140 }, { id: 1, x: 250, y: 140 });
        expect(transform()).toEqual({ x: 0, y: 0, scale: 3 });
        touches.end(0); // Either finger may be the one that remains.
        touches.move({ id: 1, x: 244, y: 151 });
        expect(transform()).toEqual({ x: -6, y: 11, scale: 3 });
        touches.start({ id: 0, x: 144, y: 151 });
        touches.move({ id: 0, x: 144, y: 151 }, { id: 1, x: 244, y: 151 });
        touches.move({ id: 0, x: 164, y: 161 }, { id: 1, x: 264, y: 161 });
        touches.end(1);
        touches.move({ id: 0, x: 168, y: 158 });
        expect(transform()).toEqual({ x: -2, y: 8, scale: 3 });
        touches.end(0);
        // A new responder cycle must not reuse the previous cumulative baseline.
        touches.start({ id: 0, x: 100, y: 100 });
        touches.move({ id: 0, x: 109, y: 113 });
        expect(transform()).toEqual({ x: 7, y: 21, scale: 3 });
    });

    it('waits the full single-tap window before closing exactly once', () => {
        touches.tap();
        advance(279);
        expect(onClose).not.toHaveBeenCalled();
        advance(1);
        expect(onClose).toHaveBeenCalledTimes(1);
        advance(1000);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('uses second touchdown timing, cancelling close even when the second release is after the deadline', () => {
        touches.tap();
        advance(279);
        touches.start({ id: 0, x: 100, y: 100 });
        advance(100);
        expect(onClose).not.toHaveBeenCalled();
        touches.end(0);
        expect(transform().scale).toBe(2.5);
        advance(500);
        expect(onClose).not.toHaveBeenCalled();
        advance(300);
        touches.tap();
        advance(100);
        touches.tap();
        expect(transform()).toEqual({ x: 0, y: 0, scale: 1 });
        advance(500);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('does not close after a symmetric pinch with zero centroid displacement', () => {
        touches.start({ id: 0, x: 100, y: 100 }, { id: 1, x: 200, y: 100 });
        touches.move({ id: 0, x: 100, y: 100 }, { id: 1, x: 200, y: 100 });
        touches.move({ id: 0, x: 50, y: 100 }, { id: 1, x: 250, y: 100 });
        touches.end(0, 1);
        advance(500);
        expect(transform().scale).toBe(2);
        expect(onClose).not.toHaveBeenCalled();
    });

    it.each([
        ['first finger', false, [0], [1]],
        ['second finger', false, [1], [0]],
        ['both fingers', false, [0, 1], []],
        ['simultaneous touchdown', true, [0, 1], []],
    ] as const)('does not close after stationary multitouch releasing %s', (_label, simultaneous, first, remaining) => {
        touches.start({ id: 0, x: 100, y: 100 }, ...(simultaneous ? [{ id: 1, x: 200, y: 100 }] : []));
        if (!simultaneous) touches.start({ id: 1, x: 200, y: 100 });
        touches.end(...first);
        if (remaining.length) touches.end(...remaining);
        advance(500);
        expect(transform()).toEqual({ x: 0, y: 0, scale: 1 });
        expect(onClose).not.toHaveBeenCalled();
        // A later pure single-finger tap still closes normally.
        touches.tap();
        expect(transform().scale).toBe(1);
        advance(280);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])('clears tap history across a symmetric pinch (simultaneous touchdown: %s)', (simultaneous) => {
        touches.tap();
        advance(50);
        touches.start({ id: 0, x: 100, y: 100 }, ...(simultaneous ? [{ id: 1, x: 200, y: 100 }] : []));
        if (!simultaneous) touches.start({ id: 1, x: 200, y: 100 });
        touches.move({ id: 0, x: 100, y: 100 }, { id: 1, x: 200, y: 100 });
        touches.move({ id: 0, x: 75, y: 100 }, { id: 1, x: 225, y: 100 });
        touches.end(1);
        touches.end(0);
        expect(transform().scale).toBe(1.5);
        advance(50);
        touches.tap();
        expect(transform().scale).toBe(1.5);
        advance(500);
        expect(onClose).not.toHaveBeenCalled();
        // A fresh pair of pure single-finger taps still toggles zoom normally.
        touches.tap();
        advance(50);
        touches.tap();
        expect(transform().scale).toBe(1);
        advance(500);
        expect(onClose).not.toHaveBeenCalled();
    });

    it.each([false, true])('cancels pending close and tap history on stationary multitouch (simultaneous touchdown: %s)', (simultaneous) => {
        touches.tap();
        advance(50);
        touches.start({ id: 0, x: 100, y: 100 }, ...(simultaneous ? [{ id: 1, x: 200, y: 100 }] : []));
        if (!simultaneous) touches.start({ id: 1, x: 200, y: 100 });
        touches.end(0, 1);
        advance(50);
        touches.tap();
        expect(transform().scale).toBe(1);
        advance(279);
        expect(onClose).not.toHaveBeenCalled();
        advance(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('clears a pending tap on hide and resets scale, translation and drag baseline on reopen', () => {
        touches.tap();
        act(() => renderer.update(<ImageViewerModal visible={false} imageUri="file:///photo.jpg" onClose={onClose} />));
        advance(500);
        expect(onClose).not.toHaveBeenCalled();
        act(() => renderer.update(<ImageViewerModal visible imageUri="file:///photo.jpg" onClose={onClose} />));
        zoom();
        touches.start({ id: 0, x: 100, y: 100 });
        touches.move({ id: 0, x: 120, y: 130 });
        touches.end(0);
        act(() => renderer.update(<ImageViewerModal visible={false} imageUri="file:///photo.jpg" onClose={onClose} />));
        act(() => renderer.update(<ImageViewerModal visible imageUri="file:///photo.jpg" onClose={onClose} />));
        expect(transform()).toEqual({ x: 0, y: 0, scale: 1 });
        zoom();
        touches.start({ id: 0, x: 100, y: 100 });
        touches.move({ id: 0, x: 108, y: 109 });
        expect(transform()).toEqual({ x: 8, y: 9, scale: 2.5 });
    });

    it('termination clears tap history and pinch state; a subsequent tap is not a double tap', () => {
        touches.tap();
        advance(100);
        touches.start({ id: 0, x: 100, y: 100 });
        touches.terminate();
        touches.tap();
        expect(transform().scale).toBe(1);
        advance(280);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('termination springs an undersized pinch back and the next pinch uses a fresh scale baseline', () => {
        touches.start({ id: 0, x: 100, y: 100 }, { id: 1, x: 200, y: 100 });
        touches.move({ id: 0, x: 100, y: 100 }, { id: 1, x: 200, y: 100 });
        touches.move({ id: 0, x: 100, y: 100 }, { id: 1, x: 150, y: 100 });
        expect(transform().scale).toBe(0.8);
        touches.terminate();
        expect(transform()).toEqual({ x: 0, y: 0, scale: 1 });
        touches.start({ id: 0, x: 100, y: 100 }, { id: 1, x: 200, y: 100 });
        touches.move({ id: 0, x: 100, y: 100 }, { id: 1, x: 200, y: 100 });
        touches.move({ id: 0, x: 100, y: 100 }, { id: 1, x: 300, y: 100 });
        expect(transform().scale).toBe(2);
    });

    it('unmount cancels a pending single-tap close', () => {
        touches.tap();
        act(() => renderer.unmount());
        advance(500);
        expect(onClose).not.toHaveBeenCalled();
    });
});
