import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'yaml';

/** ACP 工厂策略：标题使用独立官方路由，不改用户 profile 或主聊天模型。 */
export async function prepareSessionTitleOverlay(dataDir: string): Promise<string> {
    const root = path.join(dataDir, 'session-title');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const content = yaml.stringify([{
        id: 'session-title-llm',
        disabled: false,
        config: {
            // Cordis 的 config 补丁整对象替换，必须显式保留上游必需控制。
            targetWords: 5,
            targetCjkCharacters: 10,
            maxOutputTokens: 4096,
            timeoutMs: 60000,
            provider: 'deepseek-official',
            model: 'deepseek-flash',
            // 上游对 JSON 包装后的完整首条计费/校验；兼容长接力，同时保留有界预算。
            maxInputBytes: 64 * 1024,
        },
    }]);
    const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const target = path.join(root, `acp-title-${digest}.patch.yml`);
    try { await fs.writeFile(target, content, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await fs.readFile(target, 'utf8') !== content) throw new Error('session_title_overlay_conflict');
    }
    return target;
}
