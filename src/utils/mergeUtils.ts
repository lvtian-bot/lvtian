import * as Diff from 'diff';

export interface MergeResult {
    mergedContent: string;
    hasConflict: boolean;
}

class MergeUtils {
    /**
     * Performs a 3-way merge using jsdiff.
     * @param base Content of the common ancestor (Shadow file)
     * @param local Content of the local file
     * @param cloud Content of the cloud file
     * @returns MergeResult
     */
    threeWayMerge(base: string, local: string, cloud: string): MergeResult {
        // 尝试针对闪念笔记的特殊格式进行优化合并
        const merged = this.tryFlashNoteMerge(base, local, cloud);
        if (merged) {
            return merged;
        }

        // Fallback to standard diff merge
        const patch = Diff.createPatch('file', base, cloud);
        const result = Diff.applyPatch(local, patch);

        if (result === false) {
            // Conflict detected (patch failed to apply cleanly)
            // Fallback strategy: Return local content but flag conflict.
            // The caller (FlashNoteService) is responsible for deciding how to save (e.g. save copy).

            return {
                mergedContent: local,
                hasConflict: true
            };
        }

        return {
            mergedContent: result as string,
            hasConflict: false
        };
    }

    /**
     * 针对闪念笔记的特殊格式进行合并
     * 闪念笔记格式: 每个笔记以 ## YYYY-MM-DD HH:mm:ss 开头
     */
    private tryFlashNoteMerge(base: string, local: string, cloud: string): MergeResult | null {
        // 检查是否为闪念笔记格式
        const flashNotePattern = /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/m;
        if (!flashNotePattern.test(base) || !flashNotePattern.test(local) || !flashNotePattern.test(cloud)) {
            return null; // 不是闪念笔记格式，返回null
        }

        try {
            // 将内容分割为笔记块
            const splitNotes = (content: string): string[] => {
                return content.split(/(?=^##\s)/m).filter(block => block.trim());
            };

            const baseNotes = splitNotes(base);
            const localNotes = splitNotes(local);
            const cloudNotes = splitNotes(cloud);

            // 创建一个Map来存储所有不同的笔记块，使用时间戳作为唯一键
            const mergedNotesMap = new Map<string, string>();

            const addNote = (note: string) => {
                const dateMatch = note.match(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
                if (dateMatch) {
                    mergedNotesMap.set(dateMatch[1], note);
                } else {
                    // 没有时间戳的笔记直接使用内容作为键
                    mergedNotesMap.set(note, note);
                }
            };

            // 添加所有基础笔记
            baseNotes.forEach(addNote);

            // 添加所有本地笔记（可能覆盖或补充基础笔记）
            localNotes.forEach(addNote);

            // 添加所有云端笔记（可能覆盖或补充基础/本地笔记）
            cloudNotes.forEach(addNote);

            // 将合并后的笔记块转换为数组
            const mergedNotesArray = Array.from(mergedNotesMap.values());

            // 按时间戳排序
            mergedNotesArray.sort((a, b) => {
                const aDate = a.match(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)?.[1];
                const bDate = b.match(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)?.[1];

                try {
                    if (aDate && bDate) {
                        const dateA = new Date(aDate);
                        const dateB = new Date(bDate);

                        // 确保日期解析成功
                        if (!isNaN(dateA.getTime()) && !isNaN(dateB.getTime())) {
                            return dateA.getTime() - dateB.getTime();
                        }
                    }
                } catch (e) {
                    console.error('[MergeUtils] Date parsing error during sort:', e);
                }

                return 0; // 日期解析失败或格式错误，保持原顺序
            });

            // 合并成字符串
            const mergedContent = mergedNotesArray.join('');

            return {
                mergedContent,
                hasConflict: false
            };
        } catch (e) {
            console.error('[MergeUtils] Failed to merge flash notes:', e);
            console.error('[MergeUtils] Base content:', base);
            console.error('[MergeUtils] Local content:', local);
            console.error('[MergeUtils] Cloud content:', cloud);
            return null; // 合并失败，返回null
        }
    }
}

export const mergeUtils = new MergeUtils();
