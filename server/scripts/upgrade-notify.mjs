#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDir = path.resolve(__dirname, '..');
const pidFile = path.join(serverDir, '.server.pid');

function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function findServerPid() {
    if (fs.existsSync(pidFile)) {
        try {
            const raw = fs.readFileSync(pidFile, 'utf8').trim();
            const pid = parseInt(raw, 10);
            if (Number.isFinite(pid) && isPidAlive(pid)) {
                return pid;
            }
        } catch {}
    }

    // 通过 pgrep 兜底查找运行中的服务端进程
    try {
        const output = execSync('pgrep -f "dist/index.js"', { encoding: 'utf8' }).trim();
        const pids = output.split(/\s+/).map((p) => parseInt(p, 10)).filter((p) => Number.isFinite(p) && p !== process.pid);
        if (pids.length > 0) {
            return pids[0];
        }
    } catch {}

    return null;
}

async function main() {
    console.log('[UpgradeNotify] 正在检测运行中的绿天服务端进程...');
    const pid = findServerPid();

    if (!pid) {
        console.log('[UpgradeNotify] 未检测到正在运行的绿天服务端进程，无需发送升级信号。');
        process.exit(0);
    }

    console.log(`[UpgradeNotify] 发现运行中的服务端进程 (PID: ${pid})，发送 SIGUSR1 优雅升级信号...`);
    try {
        process.kill(pid, 'SIGUSR1');
    } catch (err) {
        console.warn(`[UpgradeNotify] 发送信号失败: ${err.message}`);
        process.exit(0);
    }

    console.log('[UpgradeNotify] 等待老进程优雅避让与停机（最多等待 35 秒）...');
    const startTime = Date.now();
    const timeoutMs = 35000;
    let fallbackTermSent = false;

    while (Date.now() - startTime < timeoutMs) {
        if (!isPidAlive(pid)) {
            console.log(`[UpgradeNotify] 服务端老进程 (PID: ${pid}) 已优雅退出完毕。`);
            try {
                if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
            } catch {}
            process.exit(0);
        }

        // 兼容尚未支持 SIGUSR1 的旧版老进程：如果 6 秒后仍存活，发送 SIGTERM 兜底停机
        if (!fallbackTermSent && Date.now() - startTime >= 6000) {
            console.log(`[UpgradeNotify] 老进程未响应 SIGUSR1 (可能为旧版实例)，发送 SIGTERM 进行停机...`);
            try {
                process.kill(pid, 'SIGTERM');
            } catch {}
            fallbackTermSent = true;
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    console.warn(`[UpgradeNotify] 等待进程 ${pid} 退出超时，可能已被 systemd 重启或需强制回收。`);
    process.exit(0);
}

main().catch((err) => {
    console.error('[UpgradeNotify] 执行异常:', err);
    process.exit(1);
});
