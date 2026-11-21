import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local';
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { apply } from '../../dist/autonomousJobReplyPlugin.js';

function* block(index, value) {
    yield { type: 'block-start', index, blockType: value.type };
    if (value.type === 'tool-call') {
        yield { type: 'tool-call-delta', index, id: value.id, name: value.name, argumentsDelta: value.arguments };
    } else {
        yield { type: value.type === 'text' ? 'text-delta' : 'reasoning-delta', index, text: value.text };
    }
    yield { type: 'block-end', index, block: value };
}

class LocalAdapter extends LlmAdapter {
    steps = [];
    async resolveModel(provider, model) {
        return { provider, id: model, name: model };
    }
    async *stream() {
        const next = this.steps.shift();
        assert.ok(next, 'unexpected model call');
        yield* next();
    }
}

const text = (text) => ({ type: 'text', text });
const stop = { type: 'finish', reason: { kind: 'stop' } };
const ctx = new Context();
for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime,
    NativeToolExecutor, AgentRegistry, LocalJobRegistry, ToolJobs]) await ctx.plugin(plugin);
await ctx.plugin(AgentLoop, { agents: [] });
const dispose = apply(ctx);
try {
    const adapter = new LocalAdapter();
    ctx.llm.registerAdapter(['local-test'], adapter);
    const agent = await ctx.agentLoop.create(SessionId('fixture-main'), { provider: 'local-test', model: 'synthetic' });
    const events = [];
    ctx.on('session/event', (session, event) => { if (session === agent.session) events.push(event); });

    function startOwnedJob() {
        const done = Promise.withResolvers();
        const notice = Promise.withResolvers();
        const jobId = ctx.jobs.start({
            kind: 'bash', label: 'local synthetic job', owner: agent.session.id,
            run(job) {
                job.append('RAW JOB OUTPUT (not a chat reply)');
                return { done: done.promise, cancel: () => done.resolve({ status: 'killed' }) };
            },
        });
        const off = ctx.on('agent/inbox/inserted', ({ agent: owner, message }) => {
            if (owner === agent && message.source.kind === 'tool-jobs') {
                off();
                notice.resolve();
            }
        });
        return async () => {
            done.resolve({ status: 'completed' });
            await notice.promise;
            assert.ok(events.some((event) => event.type === 'job/settled' && event.data.jobId === jobId));
        };
    }

    adapter.steps.push(async function* () {
        yield* block(0, text('PRELIMINARY TEXT'));
        yield* block(1, { type: 'tool-call', id: 'fixture-tool-call', name: 'job_list', arguments: '{}' });
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
    }, async function* () {
        yield* block(0, { type: 'reasoning', text: 'PRIVATE REASONING' });
        yield* block(1, text('已完成，结果如下：\n'));
        yield* block(2, text('第二行。'));
        yield stop;
    });
    await startOwnedJob()();
    await agent.whenIdle();

    // Settle a real job while a normal user turn is inside its first model step.
    // DSH injects it into the next step of the same turn; neither step is autonomous.
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    adapter.steps.push(async function* () {
        started.resolve();
        await release.promise;
        yield* block(0, text('user turn prelim'));
        yield stop;
    }, async function* () {
        yield* block(0, text('user turn final'));
        yield stop;
    });
    const completeMixedJob = startOwnedJob();
    agent.followup(createUserMessage({ content: [text('user prompt')], source: { kind: 'user' } }));
    await started.promise;
    try { await completeMixedJob(); }
    finally { release.resolve(); }
    await agent.whenIdle();
    assert.equal(adapter.steps.length, 0);
    assert.deepEqual(events.filter((event) => event.type === 'turn/end').map((event) => event.data), [
        { turn: 1, reason: { kind: 'completed' } }, { turn: 2, reason: { kind: 'completed' } },
    ]);
    const ids = events.filter((event) => event.type === 'assistant/message').map((event) => event.data.message.id);
    process.stdout.write(JSON.stringify({ ids }));
} finally {
    dispose?.();
    await ctx.fiber.dispose();
}
