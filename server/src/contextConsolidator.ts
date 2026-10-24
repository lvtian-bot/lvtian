import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from './sessionManager.js';

export interface ContextConsolidatorOptions {
    /** 模型 API 访问密钥，默认成组从 DEEPSEEK_API_KEY 或 OPENAI_API_KEY 获取 */
    apiKey?: string;
    /** 模型接口 Base URL，默认根据提供方匹配 https://api.deepseek.com 或 https://api.openai.com */
    baseUrl?: string;
    /** 模型名称，默认根据提供方匹配 deepseek-chat 或 gpt-4o-mini */
    model?: string;
    /** 外置提示词模板文件绝对路径，默认指向 server/prompts/context_consolidation.md */
    promptPath?: string;
    /** 判定空闲超时门禁（毫秒），默认 3 小时 (10800000ms) */
    idleTimeoutMs?: number;
    /** 判定容量门禁（上下文窗口占比），默认 0.2 (20%) */
    minCapacityRatio?: number;
    /** 测试注入自定义 fetch 实现 */
    fetchFn?: typeof fetch;
}

export interface ResolvedProviderConfig {
    apiKey: string;
    baseUrl: string;
    model: string;
}

export function resolveProviderConfig(
    options: ContextConsolidatorOptions = {}
): ResolvedProviderConfig | null {
    // 1. 如果调用方显式提供了 apiKey
    if (options.apiKey) {
        const isOpenAiHint =
            Boolean(options.model?.toLowerCase().startsWith('gpt')) ||
            Boolean(options.baseUrl && options.baseUrl.includes('openai.com'));
        const defaultBaseUrl = isOpenAiHint ? 'https://api.openai.com' : 'https://api.deepseek.com';
        const defaultModel = isOpenAiHint ? 'gpt-4o-mini' : 'deepseek-chat';
        return {
            apiKey: options.apiKey,
            baseUrl: options.baseUrl ?? defaultBaseUrl,
            model: options.model ?? defaultModel,
        };
    }

    // 2. 优先按 DeepSeek 环境变量成组读取
    if (process.env.DEEPSEEK_API_KEY) {
        return {
            apiKey: process.env.DEEPSEEK_API_KEY,
            baseUrl: options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
            model: options.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
        };
    }

    // 3. 其次按 OpenAI 环境变量成组读取 (严禁跨厂商错位发送凭据)
    if (process.env.OPENAI_API_KEY) {
        return {
            apiKey: process.env.OPENAI_API_KEY,
            baseUrl: options.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
            model: options.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
        };
    }

    return null;
}

const DEFAULT_CONSOLIDATION_PROMPT = `你是一位深谙主人心意的私人机要参谋。
主人与助手刚刚结束了一轮密集的深度交流与任务推进，现已进入数小时的静默休息。
请你为下一轮即将被唤醒的助手，撰写一份高度精炼的【心智接力备忘录】（300~500字）。

你的目标不是流水账记录他们说了什么话，而是提炼出“下一轮接力工作必须知道的心智状态”。

【输出结构】请严格遵循以下结构输出，语言简洁直白、密度极高：

### 1. 核心共识与最终盘面
- [他们最终确立了哪些结论、方案或事实？彻底忽略中间探讨试错，只写最终确定状态]

### 2. 悬置事项与下一步
- [交流暂停时，主人悬而未决的问题是什么？或者下一步明确要继续做的事是什么？]

### 3. 主人新定规矩与态度倾向
- [主人在此轮中纠正了助手什么误区？表现出了什么强烈偏好或做事原则？必须牢记防止下轮再犯]

### 4. 关键实体与最新状态
- [涉及的核心文档/代码/路径/参数及其最新状态]

【反向约束（严格执行）】
- ❌ 严禁流水账时间线：禁止使用“首先……接着……随后……最后……”的时间流水账句式；
- ❌ 严禁空洞外交辞令：禁止出现“双方进行了深入探讨并达成多项共识”这类毫无信息密度的套话；
- ❌ 严禁记录失败的执行噪音：禁止记录调试过程中的报错堆栈、打错的命令、临时的探测步骤；
- ❌ 字数硬约束：控制在 300~500 字以内，讲人话，密度第一。`;

function normalizeChatCompletionsUrl(base: string): string {
    const trimmed = base.trim().replace(/\/+$/, '');
    if (trimmed.endsWith('/chat/completions')) {
        return trimmed;
    }
    if (trimmed.endsWith('/v1')) {
        return `${trimmed}/chat/completions`;
    }
    return `${trimmed}/v1/chat/completions`;
}

/**
 * 后台睡眠期记忆巩固器 (Cognitive Memory Consolidation)：
 * 在 3 小时空闲静默且上下文占用达到 20% 时，由服务端直发大模型 API 自发自解，
 * 异步预提炼《前序对话背景提要》并原子写入 pending_background.txt；
 * 彻底不经过 DSH 引擎，零副作用、零进程恢复开销，为下次交互提供秒级冷启动。
 */
export class ContextConsolidator {
    private sessionManager: SessionManager;
    private options: ContextConsolidatorOptions;
    private inFlight: Set<string> = new Set();
    private cachedPrompt: string | null = null;
    private promptPath: string;

    constructor(sessionManager: SessionManager, options?: ContextConsolidatorOptions) {
        this.sessionManager = sessionManager;
        this.options = options ?? {};
        this.promptPath = this.options.promptPath ?? path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            '../prompts/context_consolidation.md'
        );
    }

    public async loadPromptTemplate(): Promise<string> {
        if (this.cachedPrompt) {
            return this.cachedPrompt;
        }
        try {
            if (fs.existsSync(this.promptPath)) {
                const text = await fs.promises.readFile(this.promptPath, 'utf8');
                this.cachedPrompt = text.trim();
                return this.cachedPrompt;
            }
        } catch (err) {
            console.warn(`[ContextConsolidator] 读取提示词文件失败 (${this.promptPath}): ${err}，回退默认模板`);
        }
        this.cachedPrompt = DEFAULT_CONSOLIDATION_PROMPT;
        return this.cachedPrompt;
    }

    /** 检查会话是否达到双重门禁（时间 3h AND 容量 20%） */
    public isEligible(sessionId: string): boolean {
        const idleMs = this.options.idleTimeoutMs ?? (
            process.env.LVTIAN_SESSION_IDLE_MS
                ? parseInt(process.env.LVTIAN_SESSION_IDLE_MS, 10)
                : 3 * 60 * 60 * 1000
        );
        const ratio = this.options.minCapacityRatio ?? (
            process.env.LVTIAN_SESSION_CAPACITY_RATIO
                ? parseFloat(process.env.LVTIAN_SESSION_CAPACITY_RATIO)
                : 0.2
        );
        return this.sessionManager.isRotationEligible(sessionId, idleMs, ratio);
    }

    /**
     * 周期性扫描全部活跃会话：对命中双重门禁且尚未提炼的会话发起后台异步提炼
     */
    public async scanAllSessions(): Promise<string[]> {
        const sessionIds = this.sessionManager.listSessionIds();
        const consolidated: string[] = [];
        for (const sessionId of sessionIds) {
            if (this.sessionManager.hasPendingBackground(sessionId)) {
                continue;
            }
            if (this.isEligible(sessionId)) {
                const result = await this.consolidate(sessionId);
                if (result) {
                    consolidated.push(sessionId);
                }
            }
        }
        return consolidated;
    }

    /**
     * 对指定会话执行直发模型提炼（自发自解、原子落盘）
     */
    public async consolidate(sessionId: string): Promise<string | null> {
        if (this.inFlight.has(sessionId)) {
            return null;
        }
        this.inFlight.add(sessionId);

        try {
            const dialogue = this.sessionManager.getRecentDialogue(sessionId);
            if (!dialogue || dialogue.trim().length === 0) {
                return null;
            }

            const providerConfig = resolveProviderConfig(this.options);
            if (!providerConfig) {
                console.log(`[ContextConsolidator] 未配置 DEEPSEEK_API_KEY / OPENAI_API_KEY，跳过后台背景提炼`);
                return null;
            }

            // 记录发起提炼前的会话状态指纹，用于识别网络请求期间是否有新交互或已发生轮换
            const startSession = this.sessionManager.getOrCreateSession(sessionId);
            const startLastActiveAt = this.sessionManager.getLastActiveAt(sessionId);
            const startSeq = startSession.currentSeq;
            const startDshSessionId = startSession.dshSessionId;

            const promptTemplate = await this.loadPromptTemplate();
            const endpoint = normalizeChatCompletionsUrl(providerConfig.baseUrl);

            const fetchFn = this.options.fetchFn ?? globalThis.fetch;
            const res = await fetchFn(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${providerConfig.apiKey}`,
                },
                body: JSON.stringify({
                    model: providerConfig.model,
                    messages: [
                        { role: 'system', content: promptTemplate },
                        {
                            role: 'user',
                            content: `以下是近期主人与助手的真实交流记录：\n\n${dialogue}\n\n请严格按要求提炼一份300~500字的心智接力备忘录。`,
                        },
                    ],
                    temperature: 0.3,
                    max_tokens: 1000,
                }),
                signal: AbortSignal.timeout(30000),
            });

            if (!res.ok) {
                const text = await res.text().catch(() => '');
                console.warn(`[ContextConsolidator] 提炼请求失败 (${res.status}): ${text.slice(0, 200)}`);
                return null;
            }

            const data = (await res.json()) as {
                choices?: Array<{ message?: { content?: string } }>;
            };
            const extracted = data.choices?.[0]?.message?.content?.trim();
            if (!extracted) {
                console.warn('[ContextConsolidator] 模型未返回有效提要内容');
                return null;
            }

            // 校验在外部网络请求等待期间，会话是否产生了新交互或被执行了轮换
            const currentLastActiveAt = this.sessionManager.getLastActiveAt(sessionId);
            const currentSession = this.sessionManager.getOrCreateSession(sessionId);
            if (
                currentLastActiveAt !== startLastActiveAt ||
                currentSession.currentSeq !== startSeq ||
                currentSession.dshSessionId !== startDshSessionId
            ) {
                console.log(`[ContextConsolidator] 会话 ${sessionId} 提炼期间已产生新交互或轮换，丢弃过时提炼结果`);
                return null;
            }

            this.sessionManager.setPendingBackground(sessionId, extracted);
            console.log(`[ContextConsolidator] 会话 ${sessionId} 异步背景提炼完成 (${extracted.length} 字符)`);
            return extracted;
        } catch (err: unknown) {
            console.warn(`[ContextConsolidator] 异步提炼异常 (已静默容错): ${err instanceof Error ? err.message : String(err)}`);
            return null;
        } finally {
            this.inFlight.delete(sessionId);
        }
    }
}
