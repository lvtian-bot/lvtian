import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { ChatBubbleReveal } from '../src/components/ChatBubbleReveal';
import { ChatBubbleText } from '../src/components/ChatBubbleText';
import { ChatMarkdownBubble } from '../src/components/ChatMarkdownBubble';
import { FONT_SIZE_METRICS } from '../src/utils/fontSize';

// These tests model native callback ordering; they are not Yoga/first-frame tests.
describe('bubble measurement reveal', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    const body = () => renderer.root.findAllByType(Text).find(node => node.props.selectable === true)!;
    const clock = () => renderer.root.findByProps({ testID: 'inline-bubble-time' });
    const row = () => renderer.root.findAllByType(View)[0];
    const host = () => renderer.root.findAllByType(View).find(node => node.props.onLayout)!;
    const lines = (widths: number[]) => widths.map((width, i) => ({ x: 0, y: i * 27, width, height: 27 }));
    const textLayout = async (widths: number[]) => {
        await ReactTestRenderer.act(async () => body().props.onTextLayout({ nativeEvent: { lines: lines(widths) } }));
    };
    const widthLayout = async (width: number) => {
        await ReactTestRenderer.act(async () => host().props.onLayout({ nativeEvent: { layout: { width } } }));
    };
    const clockLayout = async () => {
        await ReactTestRenderer.act(async () => clock().props.onLayout({ nativeEvent: { layout: { width: 30, height: 12 } } }));
    };
    const element = (text = 'first\nlast', streaming = false, fullWidth = false, time = '12:05') => (
        <ChatBubbleReveal style={{ flexDirection: 'row', marginBottom: 12 }} layoutKey="message" streaming={streaming}>
            <View style={{ width: 200, backgroundColor: 'blue' }}>
                <ChatBubbleText text={text} time={time} fullWidth={fullWidth} textStyle={{ fontSize: 18, lineHeight: 27 }} />
            </View>
        </ChatBubbleReveal>
    );
    const hidden = () => {
        expect(StyleSheet.flatten(row().props.style)).toMatchObject({ height: 0, opacity: 0, marginBottom: 0 });
        expect(row().props.pointerEvents).toBe('none');
        expect(row().props.accessibilityElementsHidden).toBe(true);
    };
    const visible = () => {
        expect(StyleSheet.flatten(row().props.style).height).toBeUndefined();
        expect(StyleSheet.flatten(row().props.style).opacity).toBeUndefined();
        expect(row().props.pointerEvents).toBe('auto');
        expect(row().props.accessibilityElementsHidden).toBe(false);
    };
    afterEach(async () => { await ReactTestRenderer.act(async () => renderer?.unmount()); });

    it('reveals the entire static bubble only after wrapped text and clock share a resolved layout', async () => {
        await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(element()); });
        hidden();
        await widthLayout(200);
        await textLayout([162, 80]); // Native row wrapped: not yet the full-width layout.
        hidden();
        expect(StyleSheet.flatten(clock().props.style)).toMatchObject({ position: 'absolute', opacity: 0 });
        await textLayout([200, 80]);
        hidden();
        await clockLayout();
        visible();
        expect(StyleSheet.flatten(clock().props.style)).toMatchObject({ position: 'absolute', top: 42 });
        expect(StyleSheet.flatten(clock().props.style).opacity).toBeUndefined();
    });
    it('reveals a true footer only when the final line has insufficient space', async () => {
        await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(element('long', false, true)); });
        await widthLayout(200);
        await clockLayout();
        hidden();
        await textLayout([200, 190]);
        visible();
        expect(StyleSheet.flatten(clock().props.style).position).toBeUndefined();
        expect(StyleSheet.flatten(clock().props.style).opacity).toBeUndefined();
    });
    it('accepts a short native row without waiting for clock callbacks or guessing text width', async () => {
        await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(element('短消息😀')); });
        hidden();
        await textLayout([70]);
        visible();
        expect(StyleSheet.flatten(host().props.style).flexDirection).toBe('row');
        expect(StyleSheet.flatten(clock().props.style).position).toBeUndefined();
    });
    it('does not gate streamed prose or remount its selectable text on token/time updates', async () => {
        await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(element('first', true, true)); });
        visible();
        await widthLayout(200);
        const selectable = body();
        expect(body().props.children).toBe('first');
        expect(StyleSheet.flatten(clock().props.style)).toMatchObject({ opacity: 0, position: 'absolute' });
        await ReactTestRenderer.act(async () => { renderer.update(element('first\nlast', true, true)); });
        visible();
        expect(body()).toBe(selectable);
        await textLayout([200, 80]);
        await clockLayout();
        // A stream does not flash its clock between tokens, even if callbacks catch up.
        expect(StyleSheet.flatten(clock().props.style).opacity).toBe(0);
        await ReactTestRenderer.act(async () => { renderer.update(element('first\nlast', false, true, '12:06')); });
        visible();
        expect(body()).toBe(selectable);
        expect(StyleSheet.flatten(clock().props.style).opacity).toBe(0);
        await clockLayout();
        expect(StyleSheet.flatten(clock().props.style)).toMatchObject({ position: 'absolute', top: 42 });
    });
    it('keeps a near-width single-line stream in the same full-body regime at completion', async () => {
        await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(element('near width boundary', true)); });
        await widthLayout(200);
        await textLayout([185]);
        await clockLayout();
        const selectable = body();
        expect(StyleSheet.flatten(clock().props.style).opacity).toBe(0);
        await ReactTestRenderer.act(async () => { renderer.update(element('near width boundary', false)); });
        expect(body()).toBe(selectable);
        expect(StyleSheet.flatten(host().props.style).flexDirection).toBeUndefined();
        expect(StyleSheet.flatten(clock().props.style).position).toBeUndefined();
        expect(StyleSheet.flatten(clock().props.style).opacity).toBeUndefined();
        visible();
    });
    it('does not reveal when an old source callback arrives while initial measurement is pending', async () => {
        await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(element('old', false, true)); });
        await widthLayout(200);
        const staleBody = body().props.onTextLayout;
        await ReactTestRenderer.act(async () => { renderer.update(element('new', false, true)); });
        await clockLayout();
        await ReactTestRenderer.act(async () => staleBody({ nativeEvent: { lines: lines([10]) } }));
        hidden();
        await textLayout([80]);
        visible();
        expect(body().props.children).toBe('new');
    });
    it('keeps a resolved footer in normal flow across a time-only acknowledgement update', async () => {
        await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(element('wide', false, true)); });
        await widthLayout(200);
        await textLayout([200, 190]);
        await clockLayout();
        visible();
        expect(StyleSheet.flatten(clock().props.style).position).toBeUndefined();
        const selectable = body();
        await ReactTestRenderer.act(async () => { renderer.update(element('wide', false, true, '12:06')); });
        visible();
        expect(body()).toBe(selectable);
        expect(StyleSheet.flatten(clock().props.style)).toMatchObject({ opacity: 0, marginTop: 2 });
        expect(StyleSheet.flatten(clock().props.style).position).toBeUndefined();
        await clockLayout();
        expect(StyleSheet.flatten(clock().props.style).opacity).toBeUndefined();
        expect(StyleSheet.flatten(clock().props.style).position).toBeUndefined();
    });
    it('fails visibly to a latched footer if native measurement never arrives', async () => {
        jest.useFakeTimers();
        try {
            await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(element()); });
            hidden();
            await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(750); });
            visible();
            expect(StyleSheet.flatten(host().props.style).flexDirection).toBeUndefined();
            expect(StyleSheet.flatten(clock().props.style).position).toBeUndefined();
            expect(StyleSheet.flatten(clock().props.style).opacity).toBeUndefined();
            // Late callbacks must not move the already-visible fallback footer.
            await widthLayout(200);
            await textLayout([200, 80]);
            await clockLayout();
            expect(StyleSheet.flatten(clock().props.style).position).toBeUndefined();
        } finally {
            jest.useRealTimers();
        }
    });
    it('does not add a clock footer to streaming Markdown code/table/heading endings', async () => {
        const render = (text: string, streaming: boolean) => <ChatBubbleReveal style={{}} layoutKey="rich" streaming={streaming}>
            <ChatMarkdownBubble text={text} time="12:05" metrics={FONT_SIZE_METRICS.standard} />
        </ChatBubbleReveal>;
        let initialized = false;
        for (const text of ['# heading', '```js\nconst x = 1;', '| a | b |\n| --- | --- |\n| c | d |']) {
            await ReactTestRenderer.act(async () => {
                if (initialized) renderer.update(render(text, true));
                else renderer = ReactTestRenderer.create(render(text, true));
                initialized = true;
            });
            visible();
            expect(renderer.root.findAllByProps({ testID: 'markdown-bubble-time' })).toHaveLength(0);
            await ReactTestRenderer.act(async () => { renderer.update(render(text, false)); });
            expect(StyleSheet.flatten(renderer.root.findByProps({ testID: 'markdown-bubble-time' }).props.style).position).toBeUndefined();
        }
    });
    it('does not reveal in the cleanup/registration gap when a Markdown terminal node is replaced', async () => {
        const render = (key: string) => <ChatBubbleReveal style={{}} layoutKey="same-row">
            <ChatBubbleText key={key} text={key} time="12:05" textStyle={{ fontSize: 18 }} fullWidth />
        </ChatBubbleReveal>;
        await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(render('old-terminal')); });
        hidden();
        await ReactTestRenderer.act(async () => { renderer.update(render('new-terminal')); });
        hidden();
        await widthLayout(200);
        await textLayout([80]);
        await clockLayout();
        visible();
    });
    it('waits for all static bubbles, while rows without a measured clock reveal immediately', async () => {
        await ReactTestRenderer.act(async () => {
            renderer = ReactTestRenderer.create(<ChatBubbleReveal style={{}} layoutKey="multi">
                <ChatBubbleText text="one" time="12:05" textStyle={{ fontSize: 18 }} />
                <ChatBubbleText text="two" time="12:05" textStyle={{ fontSize: 18 }} />
            </ChatBubbleReveal>);
        });
        const bodies = renderer.root.findAllByType(Text).filter(node => node.props.selectable === true);
        await ReactTestRenderer.act(async () => bodies[0].props.onTextLayout({ nativeEvent: { lines: lines([30]) } }));
        hidden();
        await ReactTestRenderer.act(async () => bodies[1].props.onTextLayout({ nativeEvent: { lines: lines([30]) } }));
        visible();
        await ReactTestRenderer.act(async () => {
            renderer.update(<ChatBubbleReveal style={{}} layoutKey="empty"><Text>attachment/status only</Text></ChatBubbleReveal>);
        });
        visible();
    });
});
