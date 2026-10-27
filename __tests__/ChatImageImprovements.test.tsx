import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { TouchableOpacity, Image, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { ChatScreen } from '../src/screens/ChatScreen';
import { ImageViewerModal } from '../src/components/ImageViewerModal';
import { AssistantClient } from '../src/services/AssistantClient';
import { useAssistantStore } from '../src/store/useAssistantStore';
import i18n from '../src/i18n';

jest.mock('@react-navigation/native', () => ({
    ...jest.requireActual('@react-navigation/native'),
    useNavigation: () => ({ navigate: jest.fn() }),
}));

describe('ChatScreen 图片增强功能测试', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    const button = (label: string) => renderer.root.findAllByType(TouchableOpacity)
        .find((node) => node.props.accessibilityLabel === label);
    const drafts = () => renderer.root.findAllByType(View)
        .filter((node) => /^draft-attachment-\d+$/.test(node.props.testID || ''));

    beforeEach(async () => {
        jest.clearAllMocks();
        jest.spyOn(AssistantClient.getInstance(), 'connect').mockResolvedValue();
        jest.spyOn(AssistantClient.getInstance(), 'sendMessage').mockReturnValue('msg-1');
        useAssistantStore.setState({
            serverUrl: 'http://localhost:8080',
            connectionState: 'connected',
            messages: [],
            taskState: 'idle',
            pendingApprovals: [],
            isServerUpgrading: false,
        });
        await ReactTestRenderer.act(async () => {
            renderer = ReactTestRenderer.create(<ChatScreen />);
        });
    });

    afterEach(async () => {
        await ReactTestRenderer.act(async () => renderer.unmount());
        jest.restoreAllMocks();
    });

    it('支持一次多选多张图片，全部呈现在输入框内部卡片中', async () => {
        const multiImageResult: ImagePicker.ImagePickerResult = {
            canceled: false,
            assets: [
                { uri: 'file:///photo1.jpg', fileName: 'photo1.jpg', width: 200, height: 200, fileSize: 100 * 1024, mimeType: 'image/jpeg', base64: 'data1' },
                { uri: 'file:///photo2.jpg', fileName: 'photo2.jpg', width: 200, height: 200, fileSize: 150 * 1024, mimeType: 'image/jpeg', base64: 'data2' },
            ],
        };
        jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue(multiImageResult);

        await ReactTestRenderer.act(async () => button(i18n.t('chat.addAttachment'))!.props.onPress());
        await ReactTestRenderer.act(async () => button(i18n.t('chat.pickImage'))!.props.onPress());

        expect(drafts()).toHaveLength(2);
        // 验证多选调用参数允许多选
        expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(
            expect.objectContaining({
                allowsMultipleSelection: true,
                selectionLimit: 9,
            })
        );
    });

    it('待发草稿区域点击缩略图触发大图预览模态框', async () => {
        const singleResult: ImagePicker.ImagePickerResult = {
            canceled: false,
            assets: [
                { uri: 'file:///preview_thumb.jpg', fileName: 'preview_thumb.jpg', width: 200, height: 200, fileSize: 50 * 1024, mimeType: 'image/jpeg', base64: 'thumb_b64' },
            ],
        };
        jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue(singleResult);

        await ReactTestRenderer.act(async () => button(i18n.t('chat.addAttachment'))!.props.onPress());
        await ReactTestRenderer.act(async () => button(i18n.t('chat.pickImage'))!.props.onPress());

        // 查找待发缩略图上的预览按钮
        const previewBtn = button(`${i18n.t('chat.previewImage')} preview_thumb.jpg`);
        expect(previewBtn).toBeDefined();

        // 此时 ImageViewerModal visible 应为 false
        let modal = renderer.root.findByType(ImageViewerModal);
        expect(modal.props.visible).toBe(false);

        // 点击预览按钮
        await ReactTestRenderer.act(async () => previewBtn!.props.onPress());

        // 预览模态框变为打开状态
        modal = renderer.root.findByType(ImageViewerModal);
        expect(modal.props.visible).toBe(true);
        expect(modal.props.imageUri).toBe('file:///preview_thumb.jpg');

        // 关闭模态框
        await ReactTestRenderer.act(async () => modal.props.onClose());
        modal = renderer.root.findByType(ImageViewerModal);
        expect(modal.props.visible).toBe(false);
    });

    it('聊天消息气泡中的图片点击可弹出大图预览', async () => {
        // 向 store 注入一条包含图片附件的用户消息
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({
                messages: [
                    {
                        id: 'msg-with-image',
                        seq: 1,
                        role: 'user',
                        content: '看这张截图',
                        timestamp: Date.now(),
                        status: 'sent',
                        attachments: [
                            {
                                type: 'image',
                                name: 'screenshot.jpg',
                                mimeType: 'image/jpeg',
                                uri: 'file:///screenshot.jpg',
                                data: 'screen_data',
                            },
                        ],
                    },
                ],
            });
        });

        // 找到聊天消息气泡内的图片预览按钮
        const chatImageBtn = button(`${i18n.t('chat.previewImage')} screenshot.jpg`);
        expect(chatImageBtn).toBeDefined();

        let modal = renderer.root.findByType(ImageViewerModal);
        expect(modal.props.visible).toBe(false);

        // 点击气泡内的图片
        await ReactTestRenderer.act(async () => chatImageBtn!.props.onPress());

        // 验证 ImageViewerModal 已打开
        modal = renderer.root.findByType(ImageViewerModal);
        expect(modal.props.visible).toBe(true);
        expect(modal.props.imageUri).toContain('data:image/jpeg;base64,screen_data');
    });
});

describe('ImageViewerModal 组件行为测试', () => {
    it('正确展示图片并在点击关闭时触发回调', async () => {
        const onClose = jest.fn();
        let modalRenderer: ReactTestRenderer.ReactTestRenderer;

        await ReactTestRenderer.act(async () => {
            modalRenderer = ReactTestRenderer.create(
                <ImageViewerModal
                    visible={true}
                    imageUri="file:///test_view.jpg"
                    onClose={onClose}
                />
            );
        });

        // 验证 Image 正常渲染
        const img = modalRenderer!.root.findByType(Image);
        expect(img.props.source).toEqual({ uri: 'file:///test_view.jpg' });

        // 找到关闭按钮并点击
        const closeBtn = modalRenderer!.root.findAllByType(TouchableOpacity)
            .find((n) => n.props.accessibilityLabel === i18n.t('common.close'));
        expect(closeBtn).toBeDefined();

        await ReactTestRenderer.act(async () => {
            closeBtn!.props.onPress();
        });
        expect(onClose).toHaveBeenCalledTimes(1);

        await ReactTestRenderer.act(async () => {
            modalRenderer!.unmount();
        });
    });

    it('visible 为 false 时不渲染任何内容', async () => {
        let modalRenderer: ReactTestRenderer.ReactTestRenderer;
        await ReactTestRenderer.act(async () => {
            modalRenderer = ReactTestRenderer.create(
                <ImageViewerModal
                    visible={false}
                    imageUri="file:///test_view.jpg"
                    onClose={jest.fn()}
                />
            );
        });
        expect(modalRenderer!.toJSON()).toBeNull();
        await ReactTestRenderer.act(async () => {
            modalRenderer!.unmount();
        });
    });
});
