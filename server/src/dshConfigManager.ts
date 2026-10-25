import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'yaml';

export type DshPermissionMode = 'workspace-write' | 'danger-full-access';

export const DEFAULT_PERMISSION_MODE: DshPermissionMode = 'workspace-write';

/** DSH 官方标准的沙箱与审批配置补丁 ID */
export const DSH_PATCH_SANDBOX_POLICY_ID = 'sandbox-policy';
export const DSH_PATCH_APPROVAL_ID = 'approval';
/** 历史曾使用的旧非标 ID（用于向下兼容读取与自动平滑清理迁移） */
export const LEGACY_DSH_PATCH_SANDBOX_POLICY_ID = 'sandboxPolicy';

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

        // 优先匹配官方标准 ID 'sandbox-policy'，同时兼容旧版本 'sandboxPolicy'
        const patchEntry = parsed.find(
            (item: unknown) =>
                item &&
                typeof item === 'object' &&
                ((item as { id?: string }).id === DSH_PATCH_SANDBOX_POLICY_ID ||
                 (item as { id?: string }).id === LEGACY_DSH_PATCH_SANDBOX_POLICY_ID)
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
 * 将沙箱权限模式与配套审批策略原子写入 DSH profile 的 cordis.patch.yml 配置文件中。
 * 遵循 DSH 官方标准：
 * - 沙箱模式：id 为 'sandbox-policy'，config.mode 为 'workspace-write' 或 'danger-full-access'
 * - 审批策略：id 为 'approval'，danger-full-access 下联动为 'never'（免审批），workspace-write 下为 'ask'
 * - 自动检测并平滑清理历史旧标识 'sandboxPolicy'
 * 返回 boolean：true 表示配置发生变更并已写入，false 表示现有有效配置已与目标模式一致（无需重新写入与交接）。
 * 若现有配置文件损坏或不可读，立即抛出异常以保护既有配置，绝不进行隐式回退或误判为幂等未变更。
 */
export function setDshPermissionMode(mode: DshPermissionMode, customDir?: string): boolean {
    const filePath = resolveDshProfilePatchPath(customDir);
    const parentDir = path.dirname(filePath);

    if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true, mode: 0o755 });
    }

    let parsed: unknown[] = [];
    const fileExisted = fs.existsSync(filePath);
    if (fileExisted) {
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

    const targetApprovalPolicy = mode === 'danger-full-access' ? 'never' : 'ask';

    // 1. 检查并清理旧非标的 'sandboxPolicy' 项（平滑自动迁移）
    let legacyRemoved = false;
    parsed = parsed.filter((item: unknown) => {
        if (item && typeof item === 'object' && (item as { id?: string }).id === LEGACY_DSH_PATCH_SANDBOX_POLICY_ID) {
            legacyRemoved = true;
            return false;
        }
        return true;
    });

    // 2. 更新或追加官方标准 'sandbox-policy' 项
    const policyIdx = parsed.findIndex(
        (item: unknown) =>
            item &&
            typeof item === 'object' &&
            (item as { id?: string }).id === DSH_PATCH_SANDBOX_POLICY_ID
    );

    let policyChanged = false;
    if (policyIdx >= 0) {
        const existing = parsed[policyIdx] as { id: string; config?: Record<string, unknown> };
        if (existing.config?.mode !== mode) {
            existing.config = {
                ...(existing.config || {}),
                mode,
            };
            policyChanged = true;
        }
    } else {
        parsed.push({
            id: DSH_PATCH_SANDBOX_POLICY_ID,
            config: {
                mode,
            },
        });
        policyChanged = true;
    }

    // 3. 更新或追加官方标准 'approval' 项（联动权限策略）
    const approvalIdx = parsed.findIndex(
        (item: unknown) =>
            item &&
            typeof item === 'object' &&
            (item as { id?: string }).id === DSH_PATCH_APPROVAL_ID
    );

    let approvalChanged = false;
    if (approvalIdx >= 0) {
        const existingApproval = parsed[approvalIdx] as { id: string; config?: Record<string, unknown> };
        if (existingApproval.config?.policy !== targetApprovalPolicy) {
            existingApproval.config = {
                ...(existingApproval.config || {}),
                policy: targetApprovalPolicy,
            };
            approvalChanged = true;
        }
    } else {
        parsed.push({
            id: DSH_PATCH_APPROVAL_ID,
            config: {
                policy: targetApprovalPolicy,
            },
        });
        approvalChanged = true;
    }

    // 4. 若原文件不存在、请求的是默认模式且无任何历史需要迁移，保持原状不落盘空改动
    if (!fileExisted && mode === DEFAULT_PERMISSION_MODE && !legacyRemoved) {
        return false;
    }

    // 5. 判定是否发生真正的内容与状态变动
    if (!policyChanged && !approvalChanged && !legacyRemoved) {
        return false;
    }

    const newYaml = yaml.stringify(parsed);
    const tmpFile = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;

    try {
        fs.writeFileSync(tmpFile, newYaml, { encoding: 'utf8', mode: 0o644 });
        fs.renameSync(tmpFile, filePath);
        return true;
    } catch (err) {
        try {
            if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        } catch {
            // ignore
        }
        throw new Error(`写入 DSH 配置文件失败: ${err instanceof Error ? err.message : String(err)}`);
    }
}
