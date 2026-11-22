import { Platform } from 'react-native';
import { File, Directory } from 'expo-file-system';
import { fsService, UserStorageError } from '../src/services/FileSystemService';

jest.mock('expo-file-system', () => {
  const MockDirectory = jest.fn().mockImplementation((..._args) => ({
    uri: 'file:///documents/lvtian_docs',
    exists: true,
    move: jest.fn(),
    list: jest.fn().mockReturnValue([]),
    delete: jest.fn(),
  })) as jest.Mock & { pickDirectoryAsync: jest.Mock };
  MockDirectory.pickDirectoryAsync = jest.fn();
  return {
    Paths: { document: { uri: 'file:///documents' }, cache: { uri: 'file:///cache' } },
    Directory: MockDirectory,
    File: jest.fn(),
  };
});

const mockFile = jest.mocked(File);
const mockDirectory = jest.mocked(Directory);

describe('本地文件异步写入', () => {
  afterEach(() => jest.restoreAllMocks());

  it('写入完成前不报告保存成功', async () => {
    let finishWrite!: () => void;
    const write = jest.fn(() => new Promise<void>(resolve => { finishWrite = resolve; }));
    mockFile.mockImplementation(() => ({ parentDirectory: { exists: true }, write }) as unknown as File);
    let saved = false;
    const saving = fsService.writeFile('note.md', '正文').then(() => { saved = true; });
    await Promise.resolve();
    expect(write).toHaveBeenCalledWith('正文');
    expect(saved).toBe(false);
    finishWrite();
    await saving;
    expect(saved).toBe(true);
  });

  it('异步写入失败时记录错误并向调用方抛出', async () => {
    const failure = new Error('写入失败');
    const write = jest.fn(() => Promise.reject(failure));
    mockFile.mockImplementation(() => ({ parentDirectory: { exists: true }, write }) as unknown as File);
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(fsService.writeFile('note.md', '正文')).rejects.toBe(failure);
    expect(log).toHaveBeenCalledWith('Error writing file:', failure);
  });

  it('旧沙盒目录存在时能正确触发自动迁移', () => {
    const oldMove = jest.fn();
    const oldList = jest.fn().mockReturnValue([]);
    const oldDelete = jest.fn();

    // 模拟旧目录存在
    mockDirectory.mockImplementation((parent: any, name?: any) => {
      if (name === 'mdnote_docs') {
        return {
          uri: 'file:///documents/mdnote_docs',
          exists: true,
          move: oldMove,
          list: oldList,
          delete: oldDelete,
        } as any;
      }
      return {
        uri: 'file:///documents/lvtian_docs',
        exists: false,
        create: jest.fn(),
      } as any;
    });

    (fsService as any).rootDir = { uri: 'file:///documents/lvtian_docs', exists: false };
    (fsService as any).migrateLegacyStorage();

    expect(oldMove).toHaveBeenCalled();
  });

  it('两端目录均存在且冲突时，递归合并并保留冲突备份，迁空后删除旧目录', () => {
    const subFileMove = jest.fn();
    const mockLegacySubFile = { name: 'sub.md', exists: true, move: subFileMove };
    const subDirDelete = jest.fn();
    const mockLegacySubDir = Object.assign(
      Object.create((Directory as any).prototype || {}),
      {
        name: 'archive',
        exists: true,
        list: jest.fn().mockReturnValueOnce([mockLegacySubFile]).mockReturnValue([]),
        delete: subDirDelete,
      }
    );
    // 模拟继承 instanceof Directory
    Object.setPrototypeOf(mockLegacySubDir, Directory.prototype);

    const oldRootDirDelete = jest.fn();
    const mockOldRootDir = {
      name: 'mdnote_docs',
      exists: true,
      list: jest.fn().mockReturnValueOnce([mockLegacySubDir]).mockReturnValue([]),
      delete: oldRootDirDelete,
    };

    mockDirectory.mockImplementation((parent: any, name?: any) => {
      if (name === 'mdnote_docs') return mockOldRootDir as any;
      if (name === 'archive') {
        return {
          name: 'archive',
          exists: true, // 目标 archive 目录已存在，触发递归合并
          list: jest.fn().mockReturnValue([]),
        } as any;
      }
      return { exists: true, list: jest.fn().mockReturnValue([]) } as any;
    });

    mockFile.mockImplementation(() => ({
      exists: false,
    }) as any);

    (fsService as any).rootDir = { uri: 'file:///documents/lvtian_docs', exists: true };
    (fsService as any).migrateLegacyStorage();

    expect(subFileMove).toHaveBeenCalled();
    expect(subDirDelete).toHaveBeenCalled();
    expect(oldRootDirDelete).toHaveBeenCalled();
  });
});

describe('新版附件读取', () => {
  afterEach(() => jest.restoreAllMocks());

  it('按附件类型读取文本和二进制内容', async () => {
    const text = jest.fn().mockResolvedValue('中文内容');
    const base64 = jest.fn().mockResolvedValue('AAEC');
    mockFile.mockImplementation(() => ({ exists: true, size: 8, text, base64 }) as unknown as File);
    await expect(fsService.readAttachment('content://external/note', 20, 'text/plain', 'note.txt'))
      .resolves.toEqual({ content: '中文内容', data: undefined, size: 8 });
    await expect(fsService.readAttachment('content://external/document', 20, 'application/pdf', 'document.pdf'))
      .resolves.toEqual({ content: undefined, data: 'AAEC', size: 8 });
  });

  it('超过上限时不读取附件', async () => {
    const base64 = jest.fn();
    mockFile.mockImplementation(() => ({ exists: true, size: 21, base64 }) as unknown as File);
    await expect(fsService.readAttachment('file:///large.pdf', 20, 'application/pdf')).rejects.toThrow('ATTACHMENT_TOO_LARGE');
    expect(base64).not.toHaveBeenCalled();
  });

  it('文本读取失败时保留二进制回退', async () => {
    const text = jest.fn().mockRejectedValue(new Error('decode'));
    const base64 = jest.fn().mockResolvedValue('AAEC');
    mockFile.mockImplementation(() => ({ exists: true, size: 3, text, base64 }) as unknown as File);
    await expect(fsService.readAttachment('file:///note.txt', 20, 'text/plain'))
      .resolves.toEqual({ content: undefined, data: 'AAEC', size: 3 });
  });
});


describe('预览缓存信息', () => {
  afterEach(() => jest.restoreAllMocks());

  it('返回毫秒时间，供预览判断七天缓存有效期', () => {
    mockFile.mockImplementation(() => ({ exists: true, modificationTime: 1700000000123 }) as unknown as File);
    expect(fsService.getCacheFileInfo('file:///cache/image')).toEqual({ exists: true, modificationTime: 1700000000123 });
  });
});

it('轮换后仍按时间顺序读取两段连接记录，不再写入缓存导出目录', async () => {
  const files = new Map<string, string>([
    ['connection-events.previous.log', 'old\n'],
    ['connection-events.log', 'recent\n'],
  ]);
  const directory = { create: jest.fn(), list: () => [] };
  mockDirectory.mockImplementation(() => directory as unknown as Directory);
  mockFile.mockImplementation((_root, filename) => {
    const f = {
      name: String(filename), uri: 'file:///documents/' + filename,
      get exists() { return files.has(f.name); },
      get size() { return 128 * 1024; },
      move: (target: File) => {
        const content = files.get(f.name)!;
        files.delete(f.name);
        f.name = target.name;
        files.set(f.name, content);
      },
      delete: () => files.delete(f.name),
      write: async (text: string, options?: { append?: boolean }) => {
        files.set(f.name, (options?.append ? files.get(f.name) ?? '' : '') + text);
      },
      text: async () => files.get(f.name),
    };
    return f as unknown as File;
  });
  await fsService.appendConnectionLog('new');
  const content = await fsService.readConnectionLogs();
  expect(content).toBe('recent\nnew\n');
  expect(directory.create).not.toHaveBeenCalled();
});

describe('saveTextToUserStorage 直接保存本地存储', () => {
  const originalOS = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
    jest.restoreAllMocks();
  });

  it('Android 选择目录后直接创建文件并写入内容', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    const write = jest.fn().mockResolvedValue(undefined);
    const createFile = jest.fn().mockReturnValue({
      uri: 'content://com.android.externalstorage.documents/tree/primary%3ADownload/document/log.txt',
      write,
    });
    const pickDirectoryAsync = jest.mocked(Directory.pickDirectoryAsync);
    pickDirectoryAsync.mockResolvedValue({
      uri: 'content://com.android.externalstorage.documents/tree/primary%3ADownload',
      createFile,
    } as unknown as Directory);

    const result = await fsService.saveTextToUserStorage('lvtian-diagnostics-test.txt', 'hello');
    expect(pickDirectoryAsync).toHaveBeenCalledWith(
      'content://com.android.externalstorage.documents/tree/primary%3ADownload',
    );
    expect(createFile).toHaveBeenCalledWith('lvtian-diagnostics-test.txt', 'text/plain');
    expect(write).toHaveBeenCalledWith('hello');
    expect(result).toEqual({
      status: 'saved',
      uri: 'content://com.android.externalstorage.documents/tree/primary%3ADownload/document/log.txt',
      fileName: 'lvtian-diagnostics-test.txt',
    });
  });

  it('Android 误选侧边栏受限下载目录时抛出 DOWNLOADS_FOLDER_RESTRICTED', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    jest.mocked(Directory.pickDirectoryAsync).mockResolvedValue({
      uri: 'content://com.android.providers.downloads.documents/tree/downloads',
      createFile: jest.fn(),
    } as unknown as Directory);

    await expect(fsService.saveTextToUserStorage('log.txt', 'hello')).rejects.toThrow(UserStorageError);
    await expect(fsService.saveTextToUserStorage('log.txt', 'hello')).rejects.toMatchObject({
      code: 'DOWNLOADS_FOLDER_RESTRICTED',
    });
  });

  it('Android 写入报错 isn\'t writable 时映射为 DOWNLOADS_FOLDER_RESTRICTED，其余映射为 WRITE_FAILED', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    jest.mocked(Directory.pickDirectoryAsync).mockResolvedValueOnce({
      uri: 'content://com.android.externalstorage.documents/tree/primary%3ADownload',
      createFile: () => {
        throw new Error("The selected folder isn't writable");
      },
    } as unknown as Directory);
    await expect(fsService.saveTextToUserStorage('log.txt', 'hello')).rejects.toMatchObject({
      code: 'DOWNLOADS_FOLDER_RESTRICTED',
    });

    jest.mocked(Directory.pickDirectoryAsync).mockResolvedValueOnce({
      uri: 'content://com.android.externalstorage.documents/tree/primary%3ADownload',
      createFile: () => {
        throw new Error('disk full');
      },
    } as unknown as Directory);
    await expect(fsService.saveTextToUserStorage('log.txt', 'hello')).rejects.toMatchObject({
      code: 'WRITE_FAILED',
    });
  });

  it('用户取消目录选择时返回 cancelled，iOS 不传 Android 初始 URI', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    const pickDirectoryAsync = jest.mocked(Directory.pickDirectoryAsync);
    pickDirectoryAsync.mockRejectedValueOnce(new Error('File picking was cancelled by the user'));
    await expect(fsService.saveTextToUserStorage('log.txt', 'hello')).resolves.toEqual({ status: 'cancelled' });
    expect(pickDirectoryAsync).toHaveBeenCalledWith(undefined);

    const write = jest.fn().mockResolvedValue(undefined);
    const createFile = jest.fn().mockReturnValue({ uri: 'file:///ios/Downloads/log.txt', write });
    pickDirectoryAsync.mockResolvedValueOnce({ uri: 'file:///ios/Downloads/', createFile } as unknown as Directory);
    await expect(fsService.saveTextToUserStorage('log.txt', 'ios-data')).resolves.toEqual({
      status: 'saved',
      uri: 'file:///ios/Downloads/log.txt',
      fileName: 'log.txt',
    });
    expect(pickDirectoryAsync).toHaveBeenLastCalledWith(undefined);
  });
});
