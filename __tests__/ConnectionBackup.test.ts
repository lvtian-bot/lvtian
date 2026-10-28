import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { loadConnectionUrl, saveConnectionUrl } from '../src/services/connectionBackup';
import { recoverConnectionAfterHydrationFailure, useAssistantStore } from '../src/store/useAssistantStore';

jest.mock('expo-secure-store', () => ({
    getItemAsync: jest.fn(),
    setItemAsync: jest.fn(),
    deleteItemAsync: jest.fn(),
}));

const getItem = SecureStore.getItemAsync as jest.Mock;

describe('连接配置独立备份', () => {
    beforeEach(async () => {
        await AsyncStorage.clear();
        jest.clearAllMocks();
        useAssistantStore.setState({ serverUrl: '', serverToken: '' });
    });

    it('保存并恢复服务器地址', async () => {
        await saveConnectionUrl('https://lt.example.com/');
        await expect(loadConnectionUrl()).resolves.toBe('https://lt.example.com/');
    });

    it('忽略非法的备份内容', async () => {
        await AsyncStorage.setItem('lvtian-connection-url-v1', JSON.stringify({ url: 'not-a-url' }));
        await expect(loadConnectionUrl()).resolves.toBeUndefined();
    });

    it('主记录没有地址时用备份恢复', async () => {
        await saveConnectionUrl('https://lt.example.com');
        getItem.mockResolvedValue('token-1');
        const creds = await useAssistantStore.getState().loadSavedCredentials();
        expect(creds.url).toBe('https://lt.example.com');
        expect(useAssistantStore.getState().serverUrl).toBe('https://lt.example.com');
    });

    it('主记录水合失败时仍恢复备份并完成初始化', async () => {
        await saveConnectionUrl('https://lt.example.com');
        getItem.mockResolvedValue('token-1');
        useAssistantStore.setState({ serverUrl: '', serverToken: '', hasHydrated: false });
        await recoverConnectionAfterHydrationFailure();
        expect(useAssistantStore.getState().hasHydrated).toBe(true);
        expect(useAssistantStore.getState().serverUrl).toBe('https://lt.example.com');
    });

    it('安全存储读取失败时保留内存中的令牌', async () => {
        useAssistantStore.setState({ serverToken: 'keep-token' });
        getItem.mockRejectedValue(new Error('keychain unavailable'));
        await useAssistantStore.getState().loadSavedCredentials();
        expect(useAssistantStore.getState().serverToken).toBe('keep-token');
    });
});
