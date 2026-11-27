import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { Alert, TextInput, TouchableOpacity } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView } from 'react-native-webview';
import { EditorScreen } from '../src/screens/EditorScreen';
import { flashNoteService } from '../src/services/FlashNoteService';
import type { RootStackParamList } from '../src/types/navigation';

let mockParams: RootStackParamList['FlashNoteEditor'];
const mockGoBack = jest.fn();
const mockGetMarkdown = jest.fn<Promise<string>, []>();
const mockFocus = jest.fn();
const mockWebMessage = jest.fn();

jest.mock('@react-navigation/native', () => {
    const navigation = { setOptions: jest.fn(), goBack: () => mockGoBack(), dispatch: jest.fn() };
    return {
        useNavigation: () => navigation,
        useRoute: () => ({ name: 'FlashNoteEditor', params: mockParams }),
        usePreventRemove: jest.fn(),
    };
});

jest.mock('react-i18next', () => {
    const t = (key: string) => key;
    return { useTranslation: () => ({ t }) };
});

jest.mock('react-native-enriched-markdown', () => {
    const mockReact = require('react');
    const { TextInput: MockTextInput } = require('react-native');
    return {
        EnrichedMarkdownTextInput: ({ ref, ...props }: {
            ref: React.Ref<unknown>;
            onChangeMarkdown: (markdown: string) => void;
        }) => {
            mockReact.useImperativeHandle(ref, () => ({
                getMarkdown: () => mockGetMarkdown(),
                focus: () => mockFocus(),
            }));
            return <MockTextInput {...props} />;
        },
    };
});

jest.mock('react-native-webview', () => {
    const mockReact = require('react');
    const { View } = require('react-native');
    return {
        WebView: mockReact.forwardRef((props: object, ref: React.Ref<unknown>) => {
            mockReact.useImperativeHandle(ref, () => ({ postMessage: mockWebMessage }));
            return <View {...props} />;
        }),
    };
});

jest.mock('../src/services/FlashNoteService', () => ({
    flashNoteService: { addNote: jest.fn(), updateNote: jest.fn() },
}));

describe('闪念编辑器', () => {
    let renderer: Renderer.ReactTestRenderer;
    const input = () => renderer.root.findByType(TextInput);
    const saveButton = () => renderer.root.findAllByType(TouchableOpacity)[1];
    const tick = async () => { await act(async () => { await jest.advanceTimersByTimeAsync(50); }); };
    const mount = async (params: RootStackParamList['FlashNoteEditor']) => {
        mockParams = params;
        await act(async () => { renderer = Renderer.create(<EditorScreen />); });
    };

    beforeEach(async () => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        await AsyncStorage.clear();
        jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    });

    afterEach(async () => {
        await act(async () => { renderer.unmount(); });
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    it('新建后自动聚焦，拒绝空白，只保存一次最新正文', async () => {
        await mount({ flashNoteId: 'new' });
        expect(input().props.autoFocus).toBe(true);
        expect(saveButton().props.disabled).toBe(true);
        await act(async () => { input().props.onChangeMarkdown('  '); });
        expect(saveButton().props.disabled).toBe(true);
        await act(async () => { input().props.onChangeMarkdown('第一条'); });
        mockGetMarkdown.mockResolvedValue('第一条闪念');
        await act(async () => {
            saveButton().props.onPress();
            saveButton().props.onPress();
        });
        expect(flashNoteService.addNote).toHaveBeenCalledTimes(1);
        expect(flashNoteService.addNote).toHaveBeenCalledWith('第一条闪念');
        expect(mockGoBack).toHaveBeenCalledTimes(1);
    });

    it('系统分享的预填内容聚焦后可以直接保存', async () => {
        const shared = 'https://example.com';
        mockGetMarkdown.mockResolvedValue(shared);
        await mount({ flashNoteId: 'new', fromShare: true, initialContent: shared });
        expect(input().props.editable).toBe(false);
        await tick();
        await tick();
        expect(input().props.defaultValue).toBe(shared);
        expect(input().props.editable).toBe(true);
        expect(mockFocus).toHaveBeenCalledTimes(1);
        expect(saveButton().props.disabled).toBe(false);
        await act(async () => { saveButton().props.onPress(); });
        expect(flashNoteService.addNote).toHaveBeenCalledWith(shared);
    });

    it('原生编辑器不能无损读写时，用原文打开并保存回原文件', async () => {
        const initial = '- [x] 完成\n\n`代码`';
        const edited = initial + '\n\n补充';
        mockGetMarkdown.mockResolvedValue('完成\n\n代码');
        await mount({ flashNoteId: '2026-11-26 09:00:00', noteFilePath: 'history/nov.md', initialContent: initial });
        await tick();
        await tick();
        expect(renderer.root.findAllByType(TextInput)).toHaveLength(0);
        const onMessage = renderer.root.findByType(WebView).props.onMessage;
        const send = (type: string, payload?: string) => onMessage({ nativeEvent: { data: JSON.stringify({ type, payload }) } });
        await act(async () => { send('ON_READY'); });
        expect(JSON.parse(mockWebMessage.mock.calls[0][0])).toMatchObject({
            type: 'INITIAL_LOAD_DATA',
            payload: { content: initial, autoFocus: true, compactSpacing: true },
        });
        await act(async () => { send('ON_CHANGE', edited); });
        await act(async () => { saveButton().props.onPress(); });
        expect(JSON.parse(mockWebMessage.mock.lastCall![0])).toEqual({ type: 'GET_CONTENT' });
        await act(async () => { send('CONTENT_RESULT', edited); });
        expect(flashNoteService.updateNote).toHaveBeenCalledWith('2026-11-26 09:00:00', edited, 'history/nov.md');
    });

    it('恢复旧弹窗草稿，保存后清理草稿键', async () => {
        await AsyncStorage.setItem('flash_note_draft_new', '旧草稿');
        mockGetMarkdown.mockResolvedValue('旧草稿');
        await mount({ flashNoteId: 'new' });
        const restore = jest.mocked(Alert.alert).mock.lastCall?.[2]?.find(choice => choice.text === 'common.restore');
        expect(restore).toBeDefined();
        await act(async () => { restore?.onPress?.(); });
        await tick();
        expect(input().props.defaultValue).toBe('旧草稿');
        await act(async () => { saveButton().props.onPress(); });
        expect(flashNoteService.addNote).toHaveBeenCalledWith('旧草稿');
        expect(await AsyncStorage.getItem('flash_note_draft_new')).toBeNull();
        expect(await AsyncStorage.getItem('editor_draft_flash_new')).toBeNull();
    });
});
