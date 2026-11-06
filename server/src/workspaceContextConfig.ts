import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

/** 独立配置只登记项目插件和工作区路径，不覆盖用户的 ACP profile。 */
export async function prepareWorkspaceContextOverlay(dataDir: string, workspace: string): Promise<string> {
    const root = path.join(dataDir, 'context');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const target = path.join(root, 'acp-context.patch.yml');
    const content = yaml.stringify([{ insert: [{
        id: 'lvtian-workspace-context',
        name: fileURLToPath(new URL('./workspaceContextPlugin.js', import.meta.url)),
        config: { workspace: path.resolve(workspace) },
    }] }]);
    try { await fs.writeFile(target, content, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await fs.readFile(target, 'utf8') !== content) throw new Error('workspace_context_overlay_conflict');
    }
    return target;
}
