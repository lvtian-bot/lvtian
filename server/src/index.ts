import os from 'node:os';
import { loadOrCreateConfig, ServerConfig } from './config.js';
import { MemoryManager } from './memoryManager.js';
import { SessionManager } from './sessionManager.js';
import { DshRunner } from './dshRunner.js';
import { FileManager } from './fileManager.js';
import { LvtianServer } from './server.js';

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
    const dshRunner = new DshRunner(config.workspace, memoryManager, sessionManager);
    const fileManager = new FileManager(config.workspace);

    const server = new LvtianServer(config, sessionManager, memoryManager, dshRunner, fileManager);
    await server.start();

    const maskedToken = `${config.token.slice(0, 4)}****${config.token.slice(-4)}`;

    console.log(`\n🚀 服务已成功启动并在端口 ${config.port} 监听:`);
    console.log(`   - 本地回环:  http://127.0.0.1:${config.port}`);
    for (const ip of localIps) {
        console.log(`   - 网络访问:  http://${ip}:${config.port}`);
    }
    console.log(`\n🔑 访问令牌:         ${maskedToken} (安全脱敏，查看完整凭据: npm run token 或 node dist/index.js --show-token)`);
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

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error('绿天服务端启动失败:', err);
    process.exit(1);
});
