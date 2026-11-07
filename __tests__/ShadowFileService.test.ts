import { shadowFileService } from '../src/services/ShadowFileService';

const mockFiles = new Map<string, string>();
let mockDirectoryExists = false;

jest.mock('expo-file-system', () => ({
  Paths: { document: { uri: 'file:///documents/' } },
  Directory: class {
    get exists() { return mockDirectoryExists; }
    create() { mockDirectoryExists = true; }
  },
  File: class {
    uri: string;
    constructor(mockUri: string) { this.uri = mockUri; }
    get exists() { return mockFiles.has(this.uri); }
    async text() { return mockFiles.get(this.uri); }
    async write(content: string) { mockFiles.set(this.uri, content); }
    delete() { mockFiles.delete(this.uri); }
  },
}));

describe('影子副本兼容原有数据', () => {
  beforeEach(() => { mockFiles.clear(); mockDirectoryExists = false; });

  it('能读取旧版路径上的中文副本，并按原路径更新和删除', async () => {
    const oldPath = 'file:///documents/.shadows/3a922d2e_plan.md';
    mockFiles.set(oldPath, '原始中文');
    expect(await shadowFileService.getShadow('notes/plan.md')).toBe('原始中文');
    await shadowFileService.saveShadow('notes/plan.md', '更新后的内容');
    expect(mockFiles.get(oldPath)).toBe('更新后的内容');
    expect(await shadowFileService.hasShadow('notes/plan.md')).toBe(true);
    await shadowFileService.deleteShadow('notes/plan.md');
    expect(await shadowFileService.getShadow('notes/plan.md')).toBeNull();
  });
});
