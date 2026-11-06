import fs from 'node:fs';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

export const inject = ['llm'];

export function apply(ctx, config) {
    class LocalAdapter extends LlmAdapter {
        async resolveModel(provider, model) {
            return { provider, id: model, name: model, systemPromptUpdate: 'in-history' };
        }
        async *stream(request) {
            fs.appendFileSync(config.captureFile, JSON.stringify(request.messages) + '\n');
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield { type: 'text-delta', index: 0, text: '本地测试完成' };
            yield { type: 'block-end', index: 0, block: { type: 'text', text: '本地测试完成' } };
            yield { type: 'finish', reason: { kind: 'stop' } };
        }
    }
    ctx.llm.registerAdapter(['lvtian-context-test'], new LocalAdapter());
}
