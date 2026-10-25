import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'yaml';

export type DshPermissionMode = 'workspace-write' | 'danger-full-access';

export const DEFAULT_PERMISSION_MODE: DshPermissionMode = 'workspace-write';

/**
 * 定位 DSH ACP profile 的补丁配置文件路径 (~/.dsh/profiles/acp/cordis.patch.yml)
 */
export function resolveDshProfilePatchPath(customDir?: string): string {
    const baseDir = customDir || path.join(os.homedir(), '.dsh', 'profiles', 'acp');
    return path.join(baseDir, 'cordis.patch.yml');
}

/**
 * 读取当前 DSH profile 的沙箱权限模式
 */
export function getDshPermissionMode(customDir?: string): DshPermissionMode {
    const filePath = resolveDshProfilePatchPath(customDir);
    if (!fs.existsSync(filePath)) {
        return DEFAULT_PERMISSION_MODE;
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = yaml.parse(content);
        if (!Array.isArray(parsed)) {
            return DEFAULT_PERMISSION_MODE;
        }

        const patchEntry = parsed.find(
            (item: unknown) =>
                item &&
                typeof item === 'object' &&
                (item as { id?: string }).id === 'sandboxPolicy'
        );

        if (patchEntry && typeof patchEntry === 'object') {
            const config = (patchEntry as { config?: { mode?: string } }).config;
            if (config?.mode === 'danger-full-access' || config?.mode === 'workspace-write') {
                return config.mode as DshPermissionMode;
            }
        }
    } catch (err) {
        console.warn(`[DshConfig] 读取 cordis.patch.yml 失败，回退默认模式: ${err}`);
    }

    return DEFAULT_PERMISSION_MODE;
}

/**
 * 将沙箱权限模式原子写入 DSH profile 的 cordis.patch.yml 配置文件中
 */
export function setDshPermissionMode(mode: DshPermissionMode, customDir?: string): void {
    const filePath = resolveDshProfilePatchPath(customDir);
    const parentDir = path.dirname(filePath);

    if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true, mode: 0o755 });
    }

    let parsed: unknown[] = [];
    if (fs.existsSync(filePath)) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const data = yaml.parse(content);
            if (Array.isArray(data)) {
                parsed = data;
            } else {
                throw new Error('DSH 配置文件格式非法（根结构非数组）');
            }
        } catch (err) {
            throw new Error(`读取或解析现有 DSH 配置文件失败，中止更新以保护既有配置: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    const patchIdx = parsed.findIndex(
        (item: unknown) =>
            item &&
            typeof item === 'object' &&
            (item as { id?: string }).id === 'sandboxPolicy'
    );

    if (patchIdx >= 0) {
        const existing = parsed[patchIdx] as { id: string; config?: Record<string, unknown> };
        existing.config = {
            ...(existing.config || {}),
            mode,
        };
    } else {
        parsed.push({
            id: 'sandboxPolicy',
            config: {
                mode,
            },
        });
    }

    const newYaml = yaml.stringify(parsed);
    const tmpFile = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;

    try {
        fs.writeFileSync(tmpFile, newYaml, { encoding: 'utf8', mode: 0o644 });
        fs.renameSync(tmpFile, filePath);
    } catch (err) {
        try {
            if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        } catch {
            // ignore
        }
        throw new Error(`写入 DSH 配置文件失败: ${err instanceof Error ? err.message : String(err)}`);
    }
}
