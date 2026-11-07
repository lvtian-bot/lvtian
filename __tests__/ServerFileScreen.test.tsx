import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { ActivityIndicator, FlatList, Text, TouchableOpacity } from 'react-native';
import { NavigationContext } from '@react-navigation/native';
import { ServerFileScreen } from '../src/screens/ServerFileScreen';
import { serverFileService } from '../src/services/ServerFileService';
import { useAssistantStore } from '../src/store/useAssistantStore';
import type { FileSystemInfo, ServerDirectoryListing, ServerFileItem } from '../src/types/assistantProtocol';

jest.mock('../src/services/ServerFileService', () => ({
    serverFileService: { getSystemInfo: jest.fn(), listDirectory: jest.fn(), downloadFile: jest.fn() },
}));
jest.mock('../src/components/settings', () => ({
    useSettingsFont: () => ({ chatBody: 16, chatHeading2: 20 }),
}));
jest.mock('react-i18next', () => {
    // Keep t stable: a fresh function on every render would hide the missing identity dependency.
    const t = (key: string) => key;
    return { useTranslation: () => ({ t }) };
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
const info = (homeDir: string): FileSystemInfo => ({ homeDir, workspaceDir: `${homeDir}/workspace`, separator: '/', platform: 'linux' });
const item = (name: string, path: string, isDirectory = false): ServerFileItem => ({ name, path, isDirectory, extension: '.txt', size: 12, mtime: 0 });
const listing = (currentPath: string, name = 'file', parentPath: string | null = null): ServerDirectoryListing => ({
    currentPath, parentPath, items: [item(name, `${currentPath}/${name}`)],
});

describe('ServerFileScreen identity and focus lifecycle', () => {
    let renderer: Renderer.ReactTestRenderer | undefined;
    let focused: boolean;
    let listeners: Record<'focus' | 'blur', Set<() => void>>;
    let navigation: React.ContextType<typeof NavigationContext>;
    const getInfo = jest.mocked(serverFileService.getSystemInfo);
    const list = jest.mocked(serverFileService.listDirectory);
    const texts = () => renderer!.root.findAllByType(Text).map(node => node.props.children);
    const loading = () => renderer!.root.findAllByType(ActivityIndicator).length;
    const mount = async () => {
        await act(async () => {
            renderer = Renderer.create(<NavigationContext.Provider value={navigation}><ServerFileScreen /></NavigationContext.Provider>);
        });
    };
    const focus = async (value: boolean) => {
        await act(async () => {
            focused = value;
            [...listeners[value ? 'focus' : 'blur']].forEach(listener => listener());
        });
    };
    const switchIdentity = async (change: { serverUrl?: string; serverToken?: string }) => {
        await act(async () => { useAssistantStore.setState(change); });
    };
    const press = async (label: string) => {
        const text = renderer!.root.findAllByType(Text).find(node => node.props.children === label)!;
        let parent = text.parent;
        while (parent && parent.type !== TouchableOpacity) parent = parent.parent;
        expect(parent).not.toBeNull();
        await act(async () => { parent!.props.onPress(); });
    };
    const pull = async () => {
        await act(async () => { renderer!.root.findByType(FlatList).props.refreshControl.props.onRefresh(); });
    };

    beforeEach(() => {
        focused = true;
        listeners = { focus: new Set(), blur: new Set() };
        // Use the real useFocusEffect; navigation events and isFocused are its only mocked inputs.
        navigation = {
            isFocused: () => focused,
            addListener: (event: 'focus' | 'blur', listener: () => void) => {
                listeners[event].add(listener);
                return () => { listeners[event].delete(listener); };
            },
            navigate: jest.fn(),
        } as unknown as React.ContextType<typeof NavigationContext>;
        useAssistantStore.setState({ serverUrl: 'http://server-a', serverToken: 'token-a', credentialsStatus: 'ready' });
        getInfo.mockReset().mockResolvedValue(info('/home/a'));
        list.mockReset().mockImplementation(async path => listing(path || '/home/a'));
    });
    afterEach(async () => {
        if (renderer) await act(async () => { renderer!.unmount(); });
        renderer = undefined;
    });

    it('cold atomic credential initialization starts exactly one HOME request', async () => {
        useAssistantStore.setState({ serverUrl: '', serverToken: '', credentialsStatus: 'loading' });
        await mount();
        expect(getInfo).not.toHaveBeenCalled();
        expect(texts()).toContain('assistant.unconfiguredTitle');
        await act(async () => {
            useAssistantStore.setState({ serverUrl: 'http://server-a', serverToken: 'token-a', credentialsStatus: 'ready' });
        });
        expect(getInfo).toHaveBeenCalledTimes(1);
        expect(list.mock.calls).toEqual([['/home/a']]);
        expect(texts()).toContain('/home/a');
        expect(loading()).toBe(0);
        await focus(true); // Duplicate initial focus events do not issue another request.
        expect(getInfo).toHaveBeenCalledTimes(1);
        expect(list).toHaveBeenCalledTimes(1);
    });

    it.each(['token', 'URL'] as const)('%s switch during first system-info request starts the new HOME and ignores stale info/finally', async kind => {
        const oldInfo = deferred<FileSystemInfo>();
        const newInfo = deferred<FileSystemInfo>();
        getInfo.mockReturnValueOnce(oldInfo.promise).mockReturnValueOnce(newInfo.promise);
        await mount();
        expect(loading()).toBe(1);
        await switchIdentity(kind === 'token' ? { serverToken: 'token-b' } : { serverUrl: 'http://server-b' });
        expect(getInfo).toHaveBeenCalledTimes(2);
        await act(async () => { oldInfo.resolve(info('/stale-home')); });
        expect(list).not.toHaveBeenCalled();
        expect(texts()).not.toContain('/stale-home');
        expect(loading()).toBe(1); // Old finally must not clear the new request's loading state.
        await act(async () => { newInfo.resolve(info('/home/b')); });
        expect(list.mock.calls).toEqual([['/home/b']]);
        expect(texts()).toContain('/home/b');
        expect(loading()).toBe(0);
    });

    it.each(['resolve', 'reject'] as const)('stale first directory %s cannot overwrite new HOME or finish its loading', async outcome => {
        const oldListing = deferred<ServerDirectoryListing>();
        const newListing = deferred<ServerDirectoryListing>();
        list.mockReturnValueOnce(oldListing.promise).mockReturnValueOnce(newListing.promise);
        await mount();
        getInfo.mockResolvedValueOnce(info('/home/b'));
        await switchIdentity({ serverToken: 'token-b' });
        expect(getInfo).toHaveBeenCalledTimes(2);
        expect(list.mock.calls).toEqual([['/home/a'], ['/home/b']]);
        await act(async () => {
            if (outcome === 'resolve') oldListing.resolve(listing('/stale-dir', 'stale-file'));
            else oldListing.reject(new Error('stale failure'));
        });
        expect(texts()).not.toContain('/stale-dir');
        expect(texts()).not.toContain('stale failure');
        expect(loading()).toBe(1);
        await act(async () => { newListing.resolve(listing('/home/b', 'new-file')); });
        expect(texts()).toContain('new-file');
        expect(texts()).toContain('/home/b');
        expect(loading()).toBe(0);
    });

    it('a loaded subdirectory identity switch clears its path, parent, items and truncation before loading new HOME', async () => {
        list.mockResolvedValueOnce({ currentPath: '/home/a', parentPath: null, items: [item('subdir', '/home/a/subdir', true)] });
        await mount();
        list.mockResolvedValueOnce({ ...listing('/home/a/subdir', 'old-file', '/home/a'), truncated: true });
        await press('subdir');
        expect(texts()).toContain('/home/a/subdir');
        expect(texts()).toContain('browser.directoryTruncated');
        const pending = deferred<FileSystemInfo>();
        getInfo.mockReturnValueOnce(pending.promise);
        await switchIdentity({ serverUrl: 'http://server-b' });
        expect(getInfo).toHaveBeenCalledTimes(2);
        expect(texts()).toContain('/');
        expect(texts()).not.toContain('/home/a/subdir');
        expect(texts()).not.toContain('old-file');
        expect(texts()).not.toContain('browser.directoryTruncated');
        expect(renderer!.root.findAllByType(TouchableOpacity)[0].props.disabled).toBe(true);
        await act(async () => { pending.resolve(info('/home/b')); });
        expect(list).toHaveBeenLastCalledWith('/home/b');
        expect(texts()).toContain('/home/b');
    });

    it('identity change while unfocused clears errors/data but makes no request until refocus', async () => {
        await mount();
        list.mockRejectedValueOnce(new Error('old error'));
        await pull();
        expect(texts()).toContain('old error');
        await focus(false);
        await switchIdentity({ serverToken: 'token-b' });
        expect(getInfo).toHaveBeenCalledTimes(1);
        expect(list).toHaveBeenCalledTimes(2);
        expect(texts()).not.toContain('old error');
        expect(texts()).not.toContain('file');
        expect(texts()).toContain('/');
        expect(loading()).toBe(0);
        getInfo.mockResolvedValueOnce(info('/home/b'));
        await focus(true);
        expect(getInfo).toHaveBeenCalledTimes(2);
        expect(list).toHaveBeenLastCalledWith('/home/b');
        expect(texts()).toContain('/home/b');
    });

    it('unfocused identity invalidation clears both loading and refreshing even when old requests settle later', async () => {
        const initial = deferred<FileSystemInfo>();
        getInfo.mockReturnValueOnce(initial.promise);
        await mount();
        await focus(false);
        await switchIdentity({ serverToken: 'token-b' });
        expect(getInfo).toHaveBeenCalledTimes(1);
        expect(loading()).toBe(0);
        expect(renderer!.root.findByType(FlatList).props.refreshControl.props.refreshing).toBe(false);
        await act(async () => { initial.reject(new Error('stale initial error')); });
        expect(texts()).not.toContain('stale initial error');
        await focus(true);
        const refresh = deferred<ServerDirectoryListing>();
        list.mockReturnValueOnce(refresh.promise);
        await pull();
        expect(renderer!.root.findByType(FlatList).props.refreshControl.props.refreshing).toBe(true);
        await focus(false);
        await switchIdentity({ serverToken: 'token-c' });
        expect(renderer!.root.findByType(FlatList).props.refreshControl.props.refreshing).toBe(false);
        expect(getInfo).toHaveBeenCalledTimes(2);
        await act(async () => { refresh.resolve(listing('/stale-refresh', 'stale-file')); });
        expect(texts()).not.toContain('stale-file');
        expect(texts()).not.toContain('/stale-refresh');
        getInfo.mockResolvedValueOnce(info('/home/c'));
        await focus(true);
        expect(list).toHaveBeenLastCalledWith('/home/c');
    });

    it('regular return refreshes the current subdirectory without reloading system info', async () => {
        list.mockResolvedValueOnce({ currentPath: '/home/a', parentPath: null, items: [item('subdir', '/home/a/subdir', true)] });
        await mount();
        await press('subdir');
        await focus(false);
        expect(list).toHaveBeenCalledTimes(2);
        list.mockResolvedValueOnce(listing('/home/a/subdir', 'externally-added', '/home/a'));
        await focus(true);
        expect(list).toHaveBeenCalledTimes(3);
        expect(list).toHaveBeenLastCalledWith('/home/a/subdir');
        expect(getInfo).toHaveBeenCalledTimes(1);
        expect(texts()).toContain('externally-added');
    });

    it.each(['info', 'listing'] as const)('new identity %s errors finish loading and recover on return', async stage => {
        await mount();
        if (stage === 'info') getInfo.mockRejectedValueOnce(new Error('new identity error'));
        else {
            getInfo.mockResolvedValueOnce(info('/home/b'));
            list.mockRejectedValueOnce(new Error('new identity error'));
        }
        await switchIdentity({ serverToken: 'token-b' });
        expect(texts()).toContain('new identity error');
        expect(loading()).toBe(0);
        expect(texts()).not.toContain('file');
        getInfo.mockResolvedValue(info('/home/b'));
        await focus(false);
        await focus(true);
        expect(texts()).not.toContain('new identity error');
        expect(texts()).toContain('/home/b');
        expect(texts()).toContain('file');
        expect(loading()).toBe(0);
    });
});
