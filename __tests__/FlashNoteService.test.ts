import { fsService } from '../src/services/FileSystemService';
import { flashNoteService } from '../src/services/FlashNoteService';

jest.mock('../src/services/FileSystemService', () => ({
    fsService: {
        exists: jest.fn().mockResolvedValue(true),
        readFile: jest.fn(),
        writeFile: jest.fn().mockResolvedValue(undefined),
    },
}));

jest.mock('../src/services/SyncService', () => ({
    syncService: { uploadFile: jest.fn().mockResolvedValue(true) },
}));

it('编辑归档闪念时保留笔记之间的边界、Markdown 缩进和其余条目', async () => {
    const path = 'history/nov.md';
    const previous = '导言\n\n# 2026/11/25 09:00\n原文\n## 旧小节\n旧内容\n\n## 2026-11-26 09:00:00\n下一条\n';
    const next = '    缩进代码\n\n## 新小节\n- [x] 已办';
    jest.mocked(fsService.readFile).mockResolvedValue(previous);

    await flashNoteService.updateNote('2026/11/25 09:00', next, path);

    const output = jest.mocked(fsService.writeFile).mock.lastCall?.[1];
    expect(fsService.readFile).toHaveBeenCalledWith(path);
    expect(fsService.writeFile).toHaveBeenCalledWith(
        path,
        '导言\n\n# 2026/11/25 09:00\n' + next + '\n\n## 2026-11-26 09:00:00\n下一条\n',
    );
    const notes = flashNoteService.parseNotes(output ?? '', path);
    expect(notes).toHaveLength(2);
    expect(notes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: '2026/11/25 09:00', content: next }),
        expect.objectContaining({ id: '2026-11-26 09:00:00', content: '下一条' }),
    ]));
});
