import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';

export const inject = ['llm', 'agents'];

export function apply(ctx) {
    class LocalAdapter extends LlmAdapter {
        async resolveModel(provider, model) { return { provider, id: model, name: model }; }
        async *stream(request) {
            const latest = request.messages.filter(message => message.role === 'user').at(-1);
            const text = latest?.source?.kind === 'tool-jobs' ? '后台结果：已完成' : '普通回复';
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield { type: 'text-delta', index: 0, text };
            yield { type: 'block-end', index: 0, block: { type: 'text', text } };
            yield { type: 'finish', reason: { kind: 'stop' } };
        }
    }
    ctx.llm.registerAdapter(['local-job-smoke'], new LocalAdapter());
    const waiting = new WeakSet();
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
        if (message.source.kind !== 'user' || waiting.has(agent)) return;
        waiting.add(agent);
        setTimeout(() => agent.followup(createUserMessage({
            source: { kind: 'tool-jobs', form: 'notice', summary: 'synthetic job finished' },
            content: [{ type: 'text', text: 'synthetic job finished' }],
        })), 500).unref();
    });
}
