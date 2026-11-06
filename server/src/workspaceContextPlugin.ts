import fs from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { buildWorkspaceContext } from './workspaceContext.js';

export const inject = ['systemPrompt'];

export interface WorkspaceContextPluginConfig {
    workspace: string;
}

/** 固定规则与可编辑档案分别进入 DSH 正式接口，不占用用户提问正文。 */
export function apply(ctx: Context, config: WorkspaceContextPluginConfig): void {
    const instructions = fs.readFileSync(new URL('../prompts/openclaw/记忆与上下文指令.md', import.meta.url), 'utf8');
    ctx.systemPrompt.section({
        name: 'lvtian:memory-policy', order: 10300, text: instructions, interpolate: false,
    });
    ctx.systemPrompt.context({
        name: 'lvtian:workspace-files', order: 300, interpolate: false, required: true,
        text: ({ agent }) => {
            // 本插件只挂载在个人聊天 ACP profile。子代理不自动获得个人档案。
            const meta = agent?.session.header;
            if (!meta || meta.parentSession || meta.origin === 'subagent' || (meta.delegationDepth ?? 0) > 0) return '';
            return buildWorkspaceContext(config.workspace);
        },
    });
}
