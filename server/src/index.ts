import os from 'node:os';
import { loadOrCreateConfig, ServerConfig } from './config.js';
import { MemoryManager } from './memoryManager.js';
import { SessionManager } from './sessionManager.js';
import { DshRunner } from './dshRunner.js';
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
    const overrides = parseArgs();
    const config = loadOrCreateConfig(overrides);

    console.log('====================================================');
    console.log(`🌿 绿天个人助理独立服务端 (Lvtian Server)`);
    console.log('====================================================');

    const memoryManager = new MemoryManager();
    const sessionManager = new SessionManager(config.dataDir);
    const dshRunner = new DshRunner(config.workspace, memoryManager, sessionManager);

    const server = new LvtianServer(config, sessionManager, memoryManager, dshRunner);
    await server.start();

    const localIps = getLocalIpAddresses();
    const primaryIp = localIps[0] || '127.0.0.1';

    console.log(`\n🚀 服务已成功启动并在端口 ${config.port} 监听:`);
    console.log(`   - 本地回环:  http://127.0.0.1:${config.port}`);
    for (const ip of localIps) {
        console.log(`   - 网络访问:  http://${ip}:${config.port}`);
    }
    console.log(`\n🔑 访问令牌 (Token): ${config.token}`);
    console.log(`📂 工作区目录:       ${config.workspace}`);
    console.log(`🧠 记忆系统目录:     ${os.homedir()} (SOUL.md, MEMORY.md, USER.md)`);

    console.log('\n📲 手机端一键连接完整配置:');
    console.log(`   http://${primaryIp}:${config.port}?token=${config.token}`);
    console.log('====================================================\n');

    const shutdown = async () => {
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
