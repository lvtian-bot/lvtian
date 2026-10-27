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

        // 优先匹配官方标准 ID 'sandbox-policy'；仅当标准项缺失时，才回退兼容旧版本 'sandboxPolicy'
        let patchEntry = parsed.find(
            (item: unknown) =>
                item &&
                typeof item === 'object' &&
                (item as { id?: string }).id === DSH_PATCH_SANDBOX_POLICY_ID
        );
        if (!patchEntry) {
            patchEntry = parsed.find(
                (item: unknown) =>
                    item &&
                    typeof item === 'object' &&
                    (item as { id?: string }).id === LEGACY_DSH_PATCH_SANDBOX_POLICY_ID
            );
        }

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
 * 预测写入目标权限模式是否会导致配置变更（模式变动、审批策略联动或历史遗留条目清理）
 */
export function willDshPermissionChange(mode: DshPermissionMode, customDir?: string): boolean {
    const filePath = resolveDshProfilePatchPath(customDir);
    if (!fs.existsSync(filePath)) {
        return mode !== DEFAULT_PERMISSION_MODE;
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = yaml.parse(content);
        if (!Array.isArray(parsed)) {
            return true;
        }

        // 检查是否存在旧非标条目待清理
        const hasLegacy = parsed.some(
            (item: unknown) =>
                item &&
                typeof item === 'object' &&
                (item as { id?: string }).id === LEGACY_DSH_PATCH_SANDBOX_POLICY_ID
        );
        if (hasLegacy) return true;

        // 检查 sandbox-policy
        const policyEntry = parsed.find(
            (item: unknown) =>
                item &&
                typeof item === 'object' &&
                (item as { id?: string }).id === DSH_PATCH_SANDBOX_POLICY_ID
        ) as { config?: { mode?: string } } | undefined;
        if (!policyEntry || policyEntry.config?.mode !== mode) {
            return true;
        }

        // 检查 approval
        const targetApprovalPolicy = mode === 'danger-full-access' ? 'never' : 'ask';
        const approvalEntry = parsed.find(
            (item: unknown) =>
                item &&
                typeof item === 'object' &&
                (item as { id?: string }).id === DSH_PATCH_APPROVAL_ID
        ) as { config?: { policy?: string } } | undefined;
        if (!approvalEntry || approvalEntry.config?.policy !== targetApprovalPolicy) {
            return true;
        }

        return false;
    } catch {
        return true;
    }
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

// ----------------------------------------------------------------------
// 助理模型选择：DSH 官方 acp / agent-default-model 补丁的 provider+model 配置。
// acp 决定每个 ACP 新建会话使用的模型；agent-default-model 为所有入口共享的
// 默认模型。两者同步写入保持一致；已存在的 DSH 会话不受影响，须由调用方触发
// 会话交接让新模型在下一个会话生效。
// ----------------------------------------------------------------------

/** DSH 官方标准补丁 ID：ACP 入口的会话模型选择 */
export const DSH_PATCH_ACP_ID = 'acp';
/** DSH 官方标准补丁 ID：新建 Agent 的共享默认模型 */
export const DSH_PATCH_AGENT_DEFAULT_MODEL_ID = 'agent-default-model';

export interface DshModelSelection {
    /** DSH 已注册的 provider 路由（如 deepseek-official / openai-codex） */
    provider: string;
    /** provider 侧的模型 ID（如 deepseek-flash / gpt-6.1-sol） */
    model: string;
}

/** 读取 ACP 补丁条目中的助理模型选择；补丁文件、条目或字段不完整时返回 null */
export function getDshModelSelection(customDir?: string): DshModelSelection | null {
    const filePath = resolveDshProfilePatchPath(customDir);
    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = yaml.parse(content);
        if (!Array.isArray(parsed)) {
            return null;
        }
        const entry = parsed.find(
            (item: unknown) =>
                item &&
                typeof item === 'object' &&
                (item as { id?: string }).id === DSH_PATCH_ACP_ID
        ) as { config?: { provider?: unknown; model?: unknown } } | undefined;
        const provider = entry?.config?.provider;
        const model = entry?.config?.model;
        if (typeof provider === 'string' && provider && typeof model === 'string' && model) {
            return { provider, model };
        }
    } catch (err) {
        console.warn(`[DshConfig] 读取模型选择失败，视为未选择: ${err}`);
    }
    return null;
}

/** 预测写入目标模型选择是否会导致补丁配置变更（含补丁文件或任一标准条目缺失的情形） */
export function willDshModelChange(target: DshModelSelection, customDir?: string): boolean {
    const filePath = resolveDshProfilePatchPath(customDir);
    if (!fs.existsSync(filePath)) {
        return true;
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = yaml.parse(content);
        if (!Array.isArray(parsed)) {
            return true;
        }
        const expectedEntries = [DSH_PATCH_ACP_ID, DSH_PATCH_AGENT_DEFAULT_MODEL_ID];
        for (const id of expectedEntries) {
            const entry = parsed.find(
                (item: unknown) =>
                    item &&
                    typeof item === 'object' &&
                    (item as { id?: string }).id === id
            ) as { config?: Record<string, unknown> } | undefined;
            if (!entry) {
                return true;
            }
            const config = entry.config && typeof entry.config === 'object' && !Array.isArray(entry.config)
                ? entry.config
                : undefined;
            if (config?.provider !== target.provider || config?.model !== target.model) {
                return true;
            }
        }
        return false;
    } catch {
        return true;
    }
}

/**
 * 将目标模型选择原子写入 DSH profile 的 cordis.patch.yml，同步维护官方标准
 * 'acp' 与 'agent-default-model' 两个补丁条目的 provider/model 字段：
 * - 条目已存在时仅合并这两个字段，其余既有配置（如 sessionListPageSize）原样保留；
 * - 自动兼容条目 config 缺失或结构异常的情形（整体重建该条目的 config）；
 * 返回 boolean：true 表示配置发生变更并已写入，false 表示两个条目均已与目标一致（幂等未变更）。
 * 现有配置文件损坏或不可读时立即抛出异常以保护既有配置，绝不进行隐式回退或误判为幂等未变更。
 */
export function setDshModelSelection(target: DshModelSelection, customDir?: string): boolean {
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

    let changed = false;
    for (const id of [DSH_PATCH_ACP_ID, DSH_PATCH_AGENT_DEFAULT_MODEL_ID]) {
        const idx = parsed.findIndex(
            (item: unknown) =>
                item &&
                typeof item === 'object' &&
                (item as { id?: string }).id === id
        );

        if (idx >= 0) {
            const existing = parsed[idx] as { id: string; config?: unknown };
            const config = existing.config && typeof existing.config === 'object' && !Array.isArray(existing.config)
                ? (existing.config as Record<string, unknown>)
                : undefined;
            if (!config) {
                // config 缺失或结构异常：整体重建，避免向非对象展开造成字段丢失或类型污染
                existing.config = { provider: target.provider, model: target.model };
                changed = true;
            } else if (config.provider !== target.provider || config.model !== target.model) {
                existing.config = {
                    ...config,
                    provider: target.provider,
                    model: target.model,
                };
                changed = true;
            }
        } else {
            parsed.push({
                id,
                config: {
                    provider: target.provider,
                    model: target.model,
                },
            });
            changed = true;
        }
    }

    if (!changed) {
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
