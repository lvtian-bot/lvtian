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
        // 1. Create a patch from Base to Cloud
        // createPatch(fileName, oldStr, newStr, oldHeader, newHeader)
        const patch = Diff.createPatch('file', base, cloud);

        // 2. Apply the patch to Local
        // applyPatch(source, patch) -> string | boolean
        // If successful, returns the new string. If failed, returns false.
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
}

export const mergeUtils = new MergeUtils();
