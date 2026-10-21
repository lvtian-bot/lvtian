import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface MemoryContext {
    soul: string;
    memory: string;
    user: string;
    agents?: string;
}

export class MemoryManager {
    private baseDir: string;
    private memoryDir: string;

    constructor(baseDir?: string) {
        this.baseDir = baseDir || os.homedir();
        this.memoryDir = path.join(this.baseDir, 'memory');
        this.ensureInit();
    }

    public getBaseDir(): string {
        return this.baseDir;
    }

    private ensureInit(): void {
        if (!fs.existsSync(this.memoryDir)) {
            fs.mkdirSync(this.memoryDir, { recursive: true, mode: 0o700 });
        }
        try {
            fs.chmodSync(this.memoryDir, 0o700);
        } catch {
            // ignore
        }

        const soulFile = path.join(this.baseDir, 'SOUL.md');
        if (!fs.existsSync(soulFile)) {
            const defaultSoul = `# 绿天 (Lvtian) - 个人助理准则

你是主人的专属长期个人助理“绿天”。

## 行为哲学
1. **直接务实**：就事论事，言简意赅。完成工作时给出清晰的结果汇报，不复述冗长的过程，不讲空话客套。
2. **忠诚随身**：你常驻在主人的专属机器上，用户目录的 ~/workspace 是你的核心工作台。
3. **安全透明**：所有长期记忆以清晰的 Markdown 形式存放在工作区；遇到敏感、高危或不可逆的操作，主动触发人工审批卡片请求主人确认。
`;
            fs.writeFileSync(soulFile, defaultSoul, { encoding: 'utf8', mode: 0o600 });
        }
        try {
            fs.chmodSync(soulFile, 0o600);
        } catch {
            // ignore
        }

        const memoryFile = path.join(this.baseDir, 'MEMORY.md');
        if (!fs.existsSync(memoryFile)) {
            const defaultMemory = `# 绿天长期记忆

> 本文件记录主人的核心偏好、长期约定和最新关键状态，保持精简。

- 助理初始化日期：${new Date().toISOString().slice(0, 10)}
- 默认工作区：~/workspace/
`;
            fs.writeFileSync(memoryFile, defaultMemory, { encoding: 'utf8', mode: 0o600 });
        }
        try {
            fs.chmodSync(memoryFile, 0o600);
        } catch {
            // ignore
        }

        const userFile = path.join(this.baseDir, 'USER.md');
        if (!fs.existsSync(userFile)) {
            const defaultUser = `# 主人档案

- 称谓：主人
- 主力设备：安卓移动端
`;
            fs.writeFileSync(userFile, defaultUser, { encoding: 'utf8', mode: 0o600 });
        }
        try {
            fs.chmodSync(userFile, 0o600);
        } catch {
            // ignore
        }
    }

    public loadContext(): MemoryContext {
        const soulFile = path.join(this.baseDir, 'SOUL.md');
        const memoryFile = path.join(this.baseDir, 'MEMORY.md');
        const userFile = path.join(this.baseDir, 'USER.md');
        const agentsFile = path.join(this.baseDir, 'AGENTS.md');

        const soul = fs.existsSync(soulFile) ? fs.readFileSync(soulFile, 'utf8') : '';
        const memory = fs.existsSync(memoryFile) ? fs.readFileSync(memoryFile, 'utf8') : '';
        const user = fs.existsSync(userFile) ? fs.readFileSync(userFile, 'utf8') : '';
        const agents = fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, 'utf8') : undefined;

        return { soul, memory, user, agents };
    }

    public appendDailyLog(title: string, content: string): void {
        try {
            const today = new Date().toISOString().slice(0, 10);
            const dailyFile = path.join(this.memoryDir, `${today}.md`);
            const time = new Date().toLocaleTimeString();

            const logEntry = `\n### [${time}] ${title}\n${content}\n`;
            fs.appendFileSync(dailyFile, logEntry, { encoding: 'utf8', mode: 0o600 });
            try {
                fs.chmodSync(dailyFile, 0o600);
            } catch {
                // ignore
            }
        } catch (err) {
            console.warn(`[MemoryManager] 记录流水日志失败 (非致命): ${err}`);
        }
    }
}
