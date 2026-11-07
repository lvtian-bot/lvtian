import { serverFileService } from '../src/services/ServerFileService';
import { downloadToFile, DownloadTimeoutError } from '../src/services/NativeDownloadService';

jest.mock('../src/services/NativeDownloadService', () => ({
  downloadToFile: jest.fn(),
  DownloadTimeoutError: class extends Error {},
}));
jest.mock('../src/store/useAssistantStore', () => ({
  useAssistantStore: { getState: () => ({ serverUrl: 'wss://example.test', serverToken: 'token', credentialsStatus: 'ready' }) },
}));

describe('系统文件下载错误', () => {
  afterEach(() => jest.restoreAllMocks());

  it('下载失败时使用通用错误，避免将权限错误误判为令牌错误', async () => {
    jest.mocked(downloadToFile).mockRejectedValueOnce(new Error('HTTP 403'));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(serverFileService.downloadFile('/file', 'file:///cache/file')).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
  });

  it('无进展超时保留专门的超时错误', async () => {
    jest.mocked(downloadToFile).mockRejectedValueOnce(new DownloadTimeoutError());
    await expect(serverFileService.downloadFile('/file', 'file:///cache/file')).rejects.toMatchObject({ code: 'DOWNLOAD_TIMEOUT', status: 408 });
  });
});
