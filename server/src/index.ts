import os from 'node:os';
import path from 'node:path';
import { NativeTaskRuntime } from './nativeTaskRuntime.js';
import { loadOrCreateConfig, ServerConfig } from './config.js';
import { MemoryManager } from './memoryManager.js';
import { SessionManager } from './sessionManager.js';
import { AcpEngineManager } from './acpEngineManager.js';
import { FileManager } from './fileManager.js';
import { ContextConsolidator } from './contextConsolidator.js';
import { getDshPermissionMode } from './dshConfigManager.js';
import { LvtianServer } from './server.js';
import { prepareWorkspaceContextOverlay } from './workspaceContextConfig.js';
import { prepareSessionTitleOverlay } from './sessionTitleConfig.js';

function parseArgs(): Partial<ServerConfig> {
    const args = process.argv.slice(2);
    const overrides: Partial<ServerConfig> = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--port' && i + 1 < args.length) {
            overrides.port = parseInt(args[++i], 10);
        } else if (arg === '--host' && i + 1 < args.length) {
            overrides.host = args[++i];
        } else if (arg === '--token' && i + 1 < args.length) {
            overrides.token = args[++i];
        } else if (arg === '--workspace' && i + 1 < args.length) {
            overrides.workspace = args[++i];
        } else if (arg === '--native-tasks') {
            overrides.nativeTasksEnabled = true;
        } else if (arg === '--no-native-tasks') {
            overrides.nativeTasksEnabled = false;
        }
    }
    return overrides;
}

function getLocalIpAddresses(): string[] {
    const interfaces = os.networkInterfaces();
    const ips: string[] = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push(iface.address);
            }
        }
    }
    return ips;
}

async function main() {
    const isShowToken = process.argv.includes('--show-token') || process.argv.includes('token');
    const overrides = parseArgs();
    const config = loadOrCreateConfig(overrides);

    const localIps = getLocalIpAddresses();
    const primaryIp = localIps[0] || '127.0.0.1';

    if (isShowToken) {
        console.log('====================================================');
        console.log('🔑 绿天独立服务端访问凭据');
        console.log('====================================================');
        console.log(`Token:      ${config.token}`);
        console.log(`快捷连接:   http://${primaryIp}:${config.port}?token=${config.token}`);
        console.log(`配置文件:   ~/.config/lvtian/config.json`);
        console.log('====================================================');
        process.exit(0);
    }

    console.log('====================================================');
    console.log(`🌿 绿天个人助理独立服务端 (Lvtian Server)`);
    console.log('====================================================');

    const memoryManager = new MemoryManager(config.workspace);
    const sessionManager = new SessionManager(config.dataDir);
    const contextConsolidator = new ContextConsolidator(sessionManager);
    if (config.nativeTasksEnabled && !['0.0.0.0', '::', '127.0.0.1', '::1'].includes(config.host)) {
        throw new Error('Native task bridge requires an existing loopback or wildcard server listener');
    }
    const taskApiHost = config.host === '::1' ? '[::1]' : '127.0.0.1';
    const nativeTasks = config.nativeTasksEnabled ? new NativeTaskRuntime({
        root: path.join(config.dataDir, 'native-tasks'),
        workspace: config.workspace,
        modelEnvironment: {
            ...(process.env.DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } : {}),
            DSH_PERMISSION_MODE: getDshPermissionMode(config.dshProfileDir),
        },
    }) : undefined;
    const taskOverlay = await nativeTasks?.prepareAcpOverlay();
    const contextOverlay = await prepareWorkspaceContextOverlay(config.dataDir, config.workspace);
    const titleOverlay = await prepareSessionTitleOverlay(config.dataDir);
    const acpEngine = new AcpEngineManager(config.workspace, memoryManager, sessionManager, {
        contextConsolidator,
        dshProfileDir: config.dshProfileDir,
        additionalPatches: [contextOverlay, ...(taskOverlay ? [taskOverlay] : []), titleOverlay],
        ...(taskOverlay ? {
            privateEnvironment: {
                LVTIAN_TASK_API_ORIGIN: `http://${taskApiHost}:${config.port}`,
                LVTIAN_TASK_API_TOKEN: config.token,
            },
        } : {}),
    });
    const fileManager = new FileManager(config.workspace);

    const server = new LvtianServer(config, sessionManager, memoryManager, acpEngine, fileManager, contextConsolidator, nativeTasks);
    await server.start();

    const maskedToken = `${config.token.slice(0, 4)}****${config.token.slice(-4)}`;
    const currentMode = getDshPermissionMode(config.dshProfileDir);

    console.log(`\n🚀 服务已成功启动并在端口 ${config.port} 监听:`);
    console.log(`   - 本地回环:  http://127.0.0.1:${config.port}`);
    for (const ip of localIps) {
        console.log(`   - 网络访问:  http://${ip}:${config.port}`);
    }
    console.log(`\n🔑 访问令牌:         ${maskedToken} (安全脱敏，查看完整凭据: npm run token 或 node dist/index.js --show-token)`);
    console.log(`🛡️ 助理权限模式:     ${currentMode === 'danger-full-access' ? '完全权限模式 (danger-full-access)' : '安全工作区模式 (workspace-write)'}`);
    console.log(`📂 工作区目录:       ${config.workspace}`);
    console.log(`🧠 记忆系统目录:     ${memoryManager.getBaseDir()} (SOUL.md, MEMORY.md, USER.md)`);
    console.log(`⚙️ 配置文件路径:     ~/.config/lvtian/config.json (权限 0600)`);
    console.log('====================================================\n');

    let isShuttingDown = false;
    const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        console.log('\n正在停止绿天服务端...');
        await server.stop();
        console.log('绿天服务端已安全停止。');
        process.exit(0);
    };

    const gracefulUpgrade = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        console.log('\n[Server] 收到 SIGUSR1 升级信号，开始执行优雅避让停机...');
        await server.gracefulDrainAndStop({ estimatedSeconds: 5 });
        console.log('[Server] 优雅避让停机完成，服务安全退出。');
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGUSR1', gracefulUpgrade);
}

main().catch((err) => {
    console.error('绿天服务端启动失败:', err);
    process.exit(1);
});
