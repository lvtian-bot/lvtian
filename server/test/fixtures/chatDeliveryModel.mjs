import { LlmAdapter } from '@deepseek-ai/dsh-llm';

export const inject = ['llm'];
export function apply(ctx) {
    class LocalChat extends LlmAdapter {
        async resolveModel(provider, model) { return { provider, id: model, name: model }; }
        async *stream(request) {
            const text = request.messages.filter(m => m.role === 'user' && m.source.kind === 'user')
                .flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text)).join('/');
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield { type: 'text-delta', index: 0, text };
            yield { type: 'block-end', index: 0, block: { type: 'text', text } };
            yield { type: 'finish', reason: { kind: 'stop' } };
        }
    }
    ctx.llm.registerAdapter(['local-chat'], new LocalChat());
}
