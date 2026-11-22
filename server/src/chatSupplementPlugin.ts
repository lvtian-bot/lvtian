import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { PromptContentPart } from '@deepseek-ai/dsh-attachment';
import type { ChatPromptBlock } from './acpEngineManager.js';

export const inject = ['llm', 'attachments'];

interface Response {
    type: 'supplement';
    requestId: number;
    failed?: boolean;
    message?: { id: string; remaining: number; blocks: ChatPromptBlock[] };
}

/** Pull only inside the foreground ACP turn. DSH waits at these hooks, so an
 * input arriving after the final empty pull belongs to a new, owned ACP prompt. */
export function apply(ctx: Context): (() => void) | void {
    if (!process.send || process.env.LVTIAN_AUTONOMOUS_JOB_REPLY_FD !== '3') return;
    const turns = new WeakMap<Agent, number>();
    let sequence = 0;
    const requests = new Map<number, (response?: Response) => void>();
    const receive = (frame: Response) => {
        if (frame?.type === 'supplement') requests.get(frame.requestId)?.(frame);
    };
    const close = () => { for (const settle of requests.values()) settle(); };
    process.on('message', receive);
    process.on('disconnect', close);

    async function take(agent: Agent, signal: AbortSignal): Promise<{ message: UserMessage; remaining: number } | undefined> {
        signal.throwIfAborted();
        const requestId = ++sequence;
        const result = await new Promise<Response | undefined>((resolve, reject) => {
            const abort = () => settle();
            const settle = (response?: Response) => {
                requests.delete(requestId);
                signal.removeEventListener('abort', abort);
                if (!response || response.failed) reject(new Error('Chat supplement admission interrupted'));
                else resolve(response);
            };
            requests.set(requestId, settle);
            signal.addEventListener('abort', abort, { once: true });
            process.send!({ type: 'take_supplement', requestId, sessionId: agent.session.id },
                error => { if (error) settle(); });
        });
        if (!result?.message) return;
        const parts = result.message.blocks.map((block): PromptContentPart => {
            if (block.type === 'text') return block;
            const mediaType = block.mimeType;
            if (mediaType !== 'image/jpeg' && mediaType !== 'image/png' && mediaType !== 'image/webp' && mediaType !== 'image/gif') {
                throw new Error('Unsupported image format');
            }
            return { type: 'image', mediaType, data: block.data };
        });
        if (parts.some(part => part.type === 'image')) {
            const route = agent.model.current();
            const model = route && await ctx.llm.resolveModelInfo(route.provider, route.model);
            if (model?.inputModalities && !model.inputModalities.includes('image')) throw new Error('Model cannot accept images');
        }
        const content = await ctx.attachments.admitPromptContent(parts);
        signal.throwIfAborted();
        return {
            message: createUserMessage({ content, source: { kind: 'user', rpcId: result.message.id } }),
            remaining: result.message.remaining,
        };
    }

    // Capture the number already waiting at this boundary. Deliver each attachment
    // payload separately, without letting a stream of new arrivals delay the model.
    async function takeBatch(agent: Agent, signal: AbortSignal): Promise<UserMessage[]> {
        const first = await take(agent, signal);
        if (!first) return [];
        const batch = [first.message];
        for (let index = 0; index < first.remaining; index++) {
            const extra = await take(agent, signal);
            if (!extra) break;
            batch.push(extra.message);
        }
        return batch;
    }

    const stopStep = ctx.on('agent/pre-step', async ({ agent, turn, messages, signal }, next) => {
        const decision = await next();
        if (decision.kind !== 'enter' || agent.session.header.parentSession) return decision;
        if (messages.some(m => m.source.kind === 'user' && !('rpcId' in m.source))) turns.set(agent, turn);
        if (turns.get(agent) !== turn) return decision;
        const extra = await takeBatch(agent, signal);
        return extra.length ? { ...decision, messages: [...decision.messages, ...extra] } : decision;
    });
    const stopEnding = ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
        if (turns.get(agent) !== turn) return;
        const extra = await takeBatch(agent, signal);
        for (const message of extra) agent.steer(message);
    });
    return () => {
        stopStep();
        stopEnding();
        close();
        process.off('message', receive);
        process.off('disconnect', close);
    };
}
