import { syncService } from '../src/services/SyncService';
import { cloudService } from '../src/services/CloudService';
import { fsService } from '../src/services/FileSystemService';
import { useFileMetadataStore } from '../src/store/useFileMetadataStore';

jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn().mockResolvedValue({ isConnected: true }),
}));

describe('SyncService 本地物理文件缺失时的自愈与拉回', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useFileMetadataStore.getState().clearAll();
    jest.spyOn(cloudService, 'isInitialized').mockReturnValue(true);
    jest.spyOn(cloudService, 'isConfigured').mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('checkSyncStatus', () => {
    it('当云端存在、元数据记录已同步，但本地物理文件不存在时，应判定为 cloudNewer 触发拉回', async () => {
      const filePath = 'flash_notes.md';
      // 模拟本地元数据记录了与云端一致的哈希（例如之前同步过）
      useFileMetadataStore.getState().setMetadata(filePath, 'etag_123', 'etag_123', '2026-10-25T12:00:00Z');

      // 云端返回相同的 ETag
      jest.spyOn(cloudService, 'headFile').mockResolvedValue({
        etag: 'etag_123',
        lastModified: '2026-10-25T12:00:00Z',
      });

      // 本地物理文件不存在
      jest.spyOn(fsService, 'exists').mockResolvedValue(false);

      const result = await syncService.checkSyncStatus(filePath);

      expect(result.status).toBe('conflict');
      expect(result.conflictType).toBe('cloudNewer');
    });

    it('当云端存在、元数据记录已同步，且本地物理文件存在时，应判定为 synced', async () => {
      const filePath = 'flash_notes.md';
      useFileMetadataStore.getState().setMetadata(filePath, 'etag_123', 'etag_123', '2026-10-25T12:00:00Z');

      jest.spyOn(cloudService, 'headFile').mockResolvedValue({
        etag: 'etag_123',
        lastModified: '2026-10-25T12:00:00Z',
      });

      jest.spyOn(fsService, 'exists').mockResolvedValue(true);

      const result = await syncService.checkSyncStatus(filePath);

      expect(result.status).toBe('synced');
      expect(result.conflictType).toBeNull();
    });
  });

  describe('syncBatchFiles', () => {
    it('当云端有文件、元数据记录一致，但本地物理缺失时，应强制下载拉回而不跳过', async () => {
      const filePath = 'flash_notes.md';
      useFileMetadataStore.getState().setMetadata(filePath, 'etag_123', 'etag_123', '2026-10-25T12:00:00Z');

      // 本地物理文件不存在
      jest.spyOn(fsService, 'exists').mockResolvedValue(false);

      const downloadSpy = jest.spyOn(syncService, 'performDownload').mockResolvedValue(true);

      const cloudFiles = [
        {
          key: filePath,
          etag: 'etag_123',
          lastModified: '2026-10-25T12:00:00Z',
          size: 100,
          isDirectory: false,
        },
      ];

      const results = await syncService.syncBatchFiles(cloudFiles);

      // 应调用下载拉回文件
      expect(downloadSpy).toHaveBeenCalledWith(filePath, expect.any(Object));
      expect(results.synced).toBe(1);
      expect(results.conflicts).toBe(0);
      expect(results.errors).toBe(0);
    });

    it('当云端有文件、元数据记录一致，且本地物理文件完好存在时，应正常跳过下载', async () => {
      const filePath = 'flash_notes.md';
      useFileMetadataStore.getState().setMetadata(filePath, 'etag_123', 'etag_123', '2026-10-25T12:00:00Z');

      // 本地物理文件存在
      jest.spyOn(fsService, 'exists').mockResolvedValue(true);

      const downloadSpy = jest.spyOn(syncService, 'performDownload').mockResolvedValue(true);

      const cloudFiles = [
        {
          key: filePath,
          etag: 'etag_123',
          lastModified: '2026-10-25T12:00:00Z',
          size: 100,
          isDirectory: false,
        },
      ];

      const results = await syncService.syncBatchFiles(cloudFiles);

      // 不应调用下载
      expect(downloadSpy).not.toHaveBeenCalled();
      expect(results.synced).toBe(0);
      expect(results.conflicts).toBe(0);
      expect(results.errors).toBe(0);
    });
  });
});
