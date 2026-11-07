import { WebDavProvider } from '../src/services/WebDavProvider';
import { downloadToFile, DownloadTimeoutError } from '../src/services/NativeDownloadService';

jest.mock('../src/services/NativeDownloadService', () => ({
  downloadToFile: jest.fn(),
  DownloadTimeoutError: class extends Error {},
}));

describe('WebDAV 下载', () => {
  const provider = new WebDavProvider({ server: 'https://example.test/dav', username: 'user', password: 'pass' });
  afterEach(() => jest.restoreAllMocks());

  it('下载时保留认证、目标路径和远端文件元数据', async () => {
    jest.mocked(downloadToFile).mockResolvedValueOnce('file:///cache/image.png');
    jest.spyOn(provider, 'headFile').mockResolvedValueOnce({ etag: 'etag', lastModified: 'date' });
    await expect(provider.downloadFile('folder/图片.png', 'file:///cache/image.png'))
      .resolves.toEqual({ etag: 'etag', lastModified: 'date' });
    expect(downloadToFile).toHaveBeenCalledWith(
      'https://example.test/dav/folder/%E5%9B%BE%E7%89%87.png',
      'file:///cache/image.png',
      { Authorization: 'Basic dXNlcjpwYXNz' },
      { timeoutMs: 30000, timeoutMode: 'total' },
    );
  });

  it('超时保留既有错误代码', async () => {
    jest.mocked(downloadToFile).mockRejectedValueOnce(new DownloadTimeoutError());
    await expect(provider.downloadFile('file.md', 'file:///cache/file.md')).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
