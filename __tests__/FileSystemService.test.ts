import { File } from 'expo-file-system';
import { fsService } from '../src/services/FileSystemService';

jest.mock('expo-file-system', () => ({
  Paths: { document: 'file:///documents' },
  Directory: class {
    uri = 'file:///documents/lvtian_docs';
    exists = true;
  },
  File: jest.fn(),
}));

const mockFile = jest.mocked(File);

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
});
