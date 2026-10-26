import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Alert, TextInput, TouchableOpacity, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { ChatScreen } from '../src/screens/ChatScreen';
import { AssistantClient } from '../src/services/AssistantClient';
import { fsService } from '../src/services/FileSystemService';
import { useAssistantStore } from '../src/store/useAssistantStore';
import i18n from '../src/i18n';

jest.mock('@react-navigation/native', () => ({
    ...jest.requireActual('@react-navigation/native'),
    useNavigation: () => ({ navigate: jest.fn() }),
}));

const imageResult = (name = 'photo.jpg', size = 20): ImagePicker.ImagePickerResult => ({
    canceled: false,
    assets: [{ uri: `file:///${name}`, fileName: name, width: 100, height: 100,
        fileSize: size, mimeType: 'image/jpeg', base64: 'aGVsbG8=' }],
});
const fileResult = (): DocumentPicker.DocumentPickerResult => ({
    canceled: false,
    assets: [{ uri: 'file:///notes.txt', name: 'notes.txt', mimeType: 'text/plain', size: 20, lastModified: 0 }],
});

describe('聊天附件待发送', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    let send: jest.SpyInstance;
    const button = (label: string) => renderer.root.findAllByType(TouchableOpacity)
        .find((node) => node.props.accessibilityLabel === label);
    const drafts = () => renderer.root.findAllByType(View)
        .filter((node) => /^draft-attachment-\d+$/.test(node.props.testID || ''));
    const type = async (text: string) => {
        await ReactTestRenderer.act(async () => renderer.root.findByType(TextInput).props.onChangeText(text));
    };
    const choose = async (kind: 'pickImage' | 'pickDocument') => {
        await ReactTestRenderer.act(async () => button(i18n.t('chat.addAttachment'))!.props.onPress());
        await ReactTestRenderer.act(async () => button(i18n.t(`chat.${kind}`))!.props.onPress());
    };
    const pressSend = async () => {
        await ReactTestRenderer.act(async () => button(i18n.t('common.send'))!.props.onPress());
    };
    beforeEach(async () => {
        jest.clearAllMocks();
        jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({ canceled: true, assets: null });
        jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({ canceled: true, assets: null });
        jest.spyOn(AssistantClient.getInstance(), 'connect').mockResolvedValue();
        send = jest.spyOn(AssistantClient.getInstance(), 'sendMessage').mockReturnValue('sent-id');
        jest.spyOn(Alert, 'alert').mockImplementation(() => {});
        jest.spyOn(fsService, 'readAttachment').mockResolvedValue({ content: 'file contents', size: 20 });
        useAssistantStore.setState({ serverUrl: 'http://localhost:8080', connectionState: 'connected',
            messages: [], taskState: 'idle', pendingApprovals: [], isServerUpgrading: false });
        await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(<ChatScreen />); });
    });
    afterEach(async () => {
        await ReactTestRenderer.act(async () => renderer.unmount());
        jest.restoreAllMocks();
    });
    it('选图片不发送，继续输入文字后一次发送图片与文字并清空草稿', async () => {
        jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue(imageResult());
        await choose('pickImage');
        expect(send).not.toHaveBeenCalled();
        expect(drafts()).toHaveLength(1);
        await type('请分析这张图片');
        await pressSend();
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith('请分析这张图片', [expect.objectContaining({
            type: 'image', uri: 'file:///photo.jpg', name: 'photo.jpg', data: 'aGVsbG8=',
        })]);
        expect(drafts()).toHaveLength(0);
        expect(renderer.root.findByType(TextInput).props.value).toBe('');
        expect(button(i18n.t('common.send'))).toBeUndefined();
    });
    it('选择文件保留原输入，点击发送时带上读取好的文件内容', async () => {
        jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue(fileResult());
        await type('整理文件');
        await choose('pickDocument');
        expect(send).not.toHaveBeenCalled();
        expect(renderer.root.findByType(TextInput).props.value).toBe('整理文件');
        expect(drafts()).toHaveLength(1);
        await pressSend();
        expect(send).toHaveBeenCalledWith('整理文件', [expect.objectContaining({
            type: 'file', name: 'notes.txt', content: 'file contents', uri: 'file:///notes.txt',
        })]);
    });
    it('图片和文件可追加到同一条消息，未输入文字也可以主动发送', async () => {
        jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue(imageResult());
        jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue(fileResult());
        await choose('pickImage');
        await choose('pickDocument');
        expect(drafts()).toHaveLength(2);
        expect(send).not.toHaveBeenCalled();
        await pressSend();
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith(expect.any(String), [
            expect.objectContaining({ type: 'image' }), expect.objectContaining({ type: 'file' }),
        ]);
    });
    it('移除待发送附件只影响选中项，不发送也不清空文字', async () => {
        jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue(imageResult());
        jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue(fileResult());
        await choose('pickImage');
        await choose('pickDocument');
        await type('保留文字');
        await ReactTestRenderer.act(async () => button(`${i18n.t('common.delete')} photo.jpg`)!.props.onPress());
        expect(drafts()).toHaveLength(1);
        expect(renderer.root.findByType(TextInput).props.value).toBe('保留文字');
        expect(send).not.toHaveBeenCalled();
        await pressSend();
        expect(send).toHaveBeenCalledWith('保留文字', [expect.objectContaining({ name: 'notes.txt' })]);
    });
    it('任务执行中有附件显示发送，删除最后一个附件后恢复停止按钮', async () => {
        await ReactTestRenderer.act(async () => { useAssistantStore.setState({ taskState: 'processing' }); });
        jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue(imageResult());
        await choose('pickImage');
        expect(button(i18n.t('common.send'))).toBeDefined();
        expect(button(i18n.t('assistant.stop'))).toBeUndefined();
        await ReactTestRenderer.act(async () => button(`${i18n.t('common.delete')} photo.jpg`)!.props.onPress());
        expect(button(i18n.t('common.send'))).toBeUndefined();
        expect(button(i18n.t('assistant.stop'))).toBeDefined();
        expect(send).not.toHaveBeenCalled();
    });
    it('取消选择和读取失败保留已有附件及输入，不发送', async () => {
        jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce(imageResult());
        await choose('pickImage');
        await type('已有文字');
        await choose('pickImage');
        jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue(fileResult());
        jest.mocked(fsService.readAttachment).mockRejectedValueOnce(new Error('cannot read'));
        await choose('pickDocument');
        expect(drafts()).toHaveLength(1);
        expect(renderer.root.findByType(TextInput).props.value).toBe('已有文字');
        expect(Alert.alert).toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });
    it('附件超限时保留已有草稿，不加入超限文件', async () => {
        jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce(imageResult('first.jpg', 2 * 1024 * 1024))
            .mockResolvedValueOnce(imageResult('second.jpg', 12 * 1024 * 1024));
        await choose('pickImage');
        await choose('pickImage');
        expect(drafts()).toHaveLength(1);
        expect(Alert.alert).toHaveBeenCalledWith(i18n.t('common.notice'), i18n.t('chat.attachmentTooLarge'));
        expect(send).not.toHaveBeenCalled();
    });
    it('选择器尚未返回时输入的新文字不会被清空或自动发送', async () => {
        let resolvePicker!: (result: ImagePicker.ImagePickerResult) => void;
        jest.mocked(ImagePicker.launchImageLibraryAsync).mockReturnValueOnce(new Promise((resolve) => { resolvePicker = resolve; }));
        await choose('pickImage');
        await type('选择期间继续输入');
        await ReactTestRenderer.act(async () => resolvePicker(imageResult()));
        expect(renderer.root.findByType(TextInput).props.value).toBe('选择期间继续输入');
        expect(send).not.toHaveBeenCalled();
        await pressSend();
        expect(send).toHaveBeenCalledWith('选择期间继续输入', expect.any(Array));
    });
    it.each(['offline', 'upgrading'] as const)('%s 时点击发送沿用现有持久待发队列，不丢附件和文字', async (state) => {
        jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue(imageResult());
        await choose('pickImage');
        await type('稍后送达');
        send.mockRestore();
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({ connectionState: 'disconnected', isServerUpgrading: state === 'upgrading', pendingSendQueue: [] });
        });
        await pressSend();
        expect(useAssistantStore.getState().pendingSendQueue).toEqual([
            expect.objectContaining({ content: '稍后送达', attachments: [expect.objectContaining({ name: 'photo.jpg', data: 'aGVsbG8=' })] }),
        ]);
        expect(drafts()).toHaveLength(0);
        expect(renderer.root.findByType(TextInput).props.value).toBe('');
    });
    it('发送同步失败保留文字和附件，避免草稿丢失', async () => {
        jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue(imageResult());
        await choose('pickImage');
        await type('不要丢失');
        send.mockImplementationOnce(() => { throw new Error('send failed'); });
        expect(() => button(i18n.t('common.send'))!.props.onPress()).toThrow('send failed');
        expect(drafts()).toHaveLength(1);
        expect(renderer.root.findByType(TextInput).props.value).toBe('不要丢失');
    });
});
