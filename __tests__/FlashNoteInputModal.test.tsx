import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { StyleSheet, TextInput, TouchableOpacity } from 'react-native';
import { FlashNoteInputModal } from '../src/components/FlashNoteInputModal';
import i18n from '../src/i18n';
import { textInputColors } from '../src/utils/theme';

describe('闪念快速录入', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;

    afterEach(() => {
        act(() => renderer?.unmount());
    });

    it('空白时保持紧凑，随正文增高，并在展开编辑时带上原文', async () => {
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
        const measure = (measuredHeight: number) => input.props.onContentSizeChange({
            nativeEvent: { contentSize: { height: measuredHeight, width: 280 } },
        });

        expect(input.props).toMatchObject(textInputColors);
        expect(save.props.accessibilityLabel).toBe(i18n.t('common.save'));
        expect(save.props.disabled).toBe(true);
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
        expect(height()).toBeLessThan(800);
        expect(height()).toBeGreaterThan(emptyHeight + 24);
        act(() => expand.props.onPress());
        expect(onExpand).toHaveBeenCalledWith(draft);
    });
});
