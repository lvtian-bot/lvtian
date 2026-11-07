import { downloadToFile, DownloadTimeoutError } from '../src/services/NativeDownloadService';

const mockFiles = new Map<string, string>();
let mockTask: {
  downloadAsync: jest.Mock;
  cancel: jest.Mock;
  release: jest.Mock;
};
let mockProgress: (() => void) | undefined;
let mockTempUri = '';

jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    constructor(mockPath: string | { uri: string }, mockName?: string) {
      this.uri = typeof mockPath === 'string' ? mockPath : `${mockPath.uri}/${mockName}`;
      if (mockName?.startsWith('.download-')) mockTempUri = this.uri;
    }
    get parentDirectory() {
      return { uri: this.uri.substring(0, this.uri.lastIndexOf('/')), exists: true, create: jest.fn() };
    }
    get exists() { return mockFiles.has(this.uri); }
    delete() { mockFiles.delete(this.uri); }
    async copy(mockDestination: MockFile) {
      const value = mockFiles.get(this.uri);
      if (value === undefined) throw new Error('missing source');
      mockFiles.set(mockDestination.uri, value);
    }
    async move(mockDestination: MockFile) {
      const value = mockFiles.get(this.uri);
      if (value === undefined) throw new Error('missing temporary file');
      mockFiles.set(mockDestination.uri, value);
      mockFiles.delete(this.uri);
      this.uri = mockDestination.uri;
    }
    static createDownloadTask(_url: string, _file: MockFile, mockOptions: { onProgress: () => void }) {
      mockProgress = mockOptions.onProgress;
      return mockTask;
    }
  }
  return { File: MockFile };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('原生下载', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockFiles.clear();
    mockFiles.set('file:///cache/target', 'old');
    mockProgress = undefined;
    mockTempUri = '';
    mockTask = { downloadAsync: jest.fn(), cancel: jest.fn(), release: jest.fn() };
  });
  afterEach(() => jest.useRealTimers());

  it('成功后才替换旧文件', async () => {
    const pending = deferred<{ move: (destination: unknown, options: unknown) => Promise<void> }>();
    mockTask.downloadAsync.mockReturnValue(pending.promise);
    const result = downloadToFile('https://example.test/file', 'file:///cache/target', {}, { timeoutMs: 30000, timeoutMode: 'idle' });
    expect(mockFiles.get('file:///cache/target')).toBe('old');
    mockFiles.set(mockTempUri, 'new');
    pending.resolve({ move: async () => { mockFiles.set('file:///cache/target', mockFiles.get(mockTempUri)!); mockFiles.delete(mockTempUri); } });
    await expect(result).resolves.toBe('file:///cache/target');
    expect(mockFiles.get('file:///cache/target')).toBe('new');
    expect(mockTask.release).toHaveBeenCalled();
  });

  it('替换过程中发生错误时恢复旧文件', async () => {
    const pending = deferred<{ move: (destination: { uri: string }, options: unknown) => Promise<void> }>();
    mockTask.downloadAsync.mockReturnValue(pending.promise);
    const result = downloadToFile('https://example.test/file', 'file:///cache/target', {}, { timeoutMs: 30000, timeoutMode: 'idle' });
    mockFiles.set(mockTempUri, 'new');
    pending.resolve({ move: async (destination) => {
      mockFiles.delete(destination.uri);
      throw new Error('move failed');
    } });
    await expect(result).rejects.toThrow('move failed');
    expect(mockFiles.get('file:///cache/target')).toBe('old');
  });

  it('同一目标的并发下载依次替换，避免回滚覆盖另一次成功结果', async () => {
    const first = deferred<{ move: (destination: { uri: string }, options: unknown) => Promise<void> }>();
    const second = deferred<{ move: (destination: { uri: string }, options: unknown) => Promise<void> }>();
    const gate = deferred<void>();
    let secondStarted = false;
    mockTask.downloadAsync.mockReturnValue(first.promise);
    const firstResult = downloadToFile('https://example.test/a', 'file:///cache/target', {}, { timeoutMs: 30000, timeoutMode: 'idle' });
    mockFiles.set(mockTempUri, 'a');
    mockTask = { downloadAsync: jest.fn().mockReturnValue(second.promise), cancel: jest.fn(), release: jest.fn() };
    const secondResult = downloadToFile('https://example.test/b', 'file:///cache/target', {}, { timeoutMs: 30000, timeoutMode: 'idle' });
    mockFiles.set(mockTempUri, 'b');
    first.resolve({ move: async destination => { await gate.promise; mockFiles.set(destination.uri, 'a'); } });
    second.resolve({ move: async destination => { secondStarted = true; mockFiles.set(destination.uri, 'b'); } });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(secondStarted).toBe(false);
    gate.resolve();
    await Promise.all([firstResult, secondResult]);
    expect(mockFiles.get('file:///cache/target')).toBe('b');
  });

  it('失败后保留旧文件并清理下载残留', async () => {
    const pending = deferred<never>();
    mockTask.downloadAsync.mockReturnValue(pending.promise);
    const result = downloadToFile('https://example.test/file', 'file:///cache/target', {}, { timeoutMs: 30000, timeoutMode: 'idle' });
    mockFiles.set(mockTempUri, 'partial');
    pending.reject(new Error('network'));
    await expect(result).rejects.toThrow('network');
    await Promise.resolve();
    await Promise.resolve();
    expect(mockFiles.get('file:///cache/target')).toBe('old');
    expect(mockFiles.has(mockTempUri)).toBe(false);
  });

  it('无进展超时后取消，等原生下载停止再清理残留', async () => {
    const pending = deferred<never>();
    mockTask.downloadAsync.mockReturnValue(pending.promise);
    const result = downloadToFile('https://example.test/file', 'file:///cache/target', {}, { timeoutMs: 30000, timeoutMode: 'idle' });
    mockFiles.set(mockTempUri, 'partial');
    jest.advanceTimersByTime(20000);
    mockProgress?.();
    jest.advanceTimersByTime(29999);
    expect(mockTask.cancel).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await expect(result).rejects.toBeInstanceOf(DownloadTimeoutError);
    expect(mockTask.cancel).toHaveBeenCalled();
    expect(mockFiles.has(mockTempUri)).toBe(true);
    pending.reject(new Error('cancelled'));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockFiles.has(mockTempUri)).toBe(false);
    expect(mockFiles.get('file:///cache/target')).toBe('old');
  });
});
