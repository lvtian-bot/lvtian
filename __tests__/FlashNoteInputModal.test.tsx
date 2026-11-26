import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import {
    DeviceEventEmitter,
    Dimensions,
    KeyboardAvoidingView,
    Platform,
    StyleSheet,
    TextInput,
    TouchableOpacity,
} from 'react-native';
import { FlashNoteInputModal } from '../src/components/FlashNoteInputModal';
import i18n from '../src/i18n';
import { textInputColors } from '../src/utils/theme';

describe('闪念快速录入', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;

    afterEach(() => {
        act(() => renderer?.unmount());
        jest.restoreAllMocks();
    });

    it('空白时留出八行书写空间，随正文增高，并在展开编辑时带上原文', async () => {
        const onExpand = jest.fn();
        await act(async () => {
            renderer = ReactTestRenderer.create(
                <FlashNoteInputModal visible onSave={jest.fn()} onCancel={jest.fn()} onExpand={onExpand} />
            );
        });
        const input = renderer.root.findByType(TextInput);
        const [expand, save] = renderer.root.findAllByType(TouchableOpacity)
            .filter(({ props }) => props.accessibilityRole === 'button');
        const height = () => StyleSheet.flatten(input.props.style).height;
        const emptyHeight = height();
        const lineHeight = Math.ceil(24 * Dimensions.get('window').fontScale);
        const measure = (measuredHeight: number) => input.props.onContentSizeChange({
            nativeEvent: { contentSize: { height: measuredHeight, width: 280 } },
        });

        expect(input.props).toMatchObject(textInputColors);
        expect(save.props.accessibilityLabel).toBe(i18n.t('common.save'));
        expect(save.props.disabled).toBe(true);
        expect(emptyHeight).toBe(lineHeight * 8 + 6);
        act(() => {
            input.props.onChangeText('   ');
            measure(20);
        });
        expect(height()).toBe(emptyHeight);
        expect(save.props.disabled).toBe(true);

        const draft = '第一行\n第二行\n第三行';
        act(() => {
            input.props.onChangeText(draft);
            measure(emptyHeight + 24);
        });
        expect(height()).toBe(emptyHeight + 24);
        expect(save.props.disabled).toBe(false);
        act(() => measure(800));
        expect(height()).toBe(lineHeight * 10 + 6);
        act(() => expand.props.onPress());
        expect(onExpand).toHaveBeenCalledWith(draft);
    });

    it('Android 根据键盘高度抬升面板，并扣除原生窗口已让出的空间', async () => {
        jest.replaceProperty(Platform, 'OS', 'android');
        await act(async () => {
            renderer = ReactTestRenderer.create(
                <FlashNoteInputModal visible onSave={jest.fn()} onCancel={jest.fn()} />
            );
        });
        const container = renderer.root.findByType(KeyboardAvoidingView);
        const layout = (height: number) => container.props.onLayout({
            nativeEvent: { layout: { width: 360, height, x: 0, y: 0 } },
        });
        const show = (height: number) => DeviceEventEmitter.emit('keyboardDidShow', {
            duration: 0,
            easing: 'keyboard',
            endCoordinates: { screenX: 0, screenY: 750 - height, width: 360, height },
        });
        const padding = () => StyleSheet.flatten(container.props.style).paddingBottom;

        act(() => layout(750));
        expect(padding()).toBe(0);
        act(() => show(280));
        expect(padding()).toBe(280);
        act(() => layout(620));
        expect(padding()).toBe(150);
        act(() => layout(470));
        expect(padding()).toBe(0);
        act(() => layout(750));
        expect(padding()).toBe(280);
        act(() => DeviceEventEmitter.emit('keyboardDidHide'));
        expect(padding()).toBe(0);

        act(() => layout(750));
        act(() => layout(470));
        act(() => show(280));
        expect(padding()).toBe(0);
        act(() => DeviceEventEmitter.emit('keyboardDidHide'));
    });
});
