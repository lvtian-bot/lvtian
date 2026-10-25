import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export interface ServerConfig {
    host: string;
    port: number;
    token: string;
    workspace: string;
    dataDir: string;
    assistantName: string;
    dshProfileDir?: string;
}

export function resolveUserPath(p: string): string {
    if (p.startsWith('~/') || p === '~') {
        return path.join(os.homedir(), p.slice(1));
    }
    return path.resolve(p);
}

export function loadOrCreateConfig(overrides?: Partial<ServerConfig>): ServerConfig {
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, '.config', 'lvtian');
    const configFile = path.join(configDir, 'config.json');

    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    try {
        fs.chmodSync(configDir, 0o700);
    } catch {
        // ignore
    }

    let existing: Partial<ServerConfig> = {};
    if (fs.existsSync(configFile)) {
        try {
            const raw = fs.readFileSync(configFile, 'utf8');
            existing = JSON.parse(raw);
        } catch (err) {
            console.warn(`[Config] 读取已有配置文件失败，将使用默认配置: ${err}`);
        }
    }

    const host = overrides?.host || existing.host || '0.0.0.0';
    const port = overrides?.port || existing.port || 3000;
    const token = overrides?.token || existing.token || crypto.randomBytes(16).toString('hex');
    const workspace = resolveUserPath(overrides?.workspace || existing.workspace || '~/workspace');
    const dataDir = resolveUserPath(overrides?.dataDir || existing.dataDir || path.join(configDir, 'data'));
    const assistantName = overrides?.assistantName || existing.assistantName || '绿天';
    const dshProfileDir = overrides?.dshProfileDir || existing.dshProfileDir;

    const mergedConfig: ServerConfig = {
        host,
        port,
        token,
        workspace,
        dataDir,
        assistantName,
        ...(dshProfileDir ? { dshProfileDir } : {}),
    };

    // 确保工作区和数据目录存在
    if (!fs.existsSync(workspace)) {
        fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    }
    try {
        fs.chmodSync(dataDir, 0o700);
    } catch {
        // ignore
    }

    // 回写配置文件，限制仅本用户读写 (0600)，采用 tmp 文件原子重命名方式落盘
    try {
        const tmpFile = `${configFile}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
        fs.writeFileSync(tmpFile, JSON.stringify(mergedConfig, null, 2), { encoding: 'utf8', mode: 0o600 });
        try {
            fs.chmodSync(tmpFile, 0o600);
        } catch {
            // ignore
        }
        fs.renameSync(tmpFile, configFile);
    } catch (err) {
        console.warn(`[Config] 保存配置文件失败: ${err}`);
    }

    return mergedConfig;
}
