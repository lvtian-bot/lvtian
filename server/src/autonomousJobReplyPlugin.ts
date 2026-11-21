import fs from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-tool-jobs';

const MAX_TEXT_BYTES = 128 * 1024;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_PENDING_BYTES = 1024 * 1024;

interface TurnState {
    readonly turn: number;
    claimedNotice: boolean;
    enteredNotice: boolean;
    mixed: boolean;
    finalText?: string;
}

function isRoot(session: Session): boolean {
    const { parentSession, origin, delegationDepth } = session.header;
    return !parentSession && origin !== 'subagent' && (delegationDepth ?? 0) === 0;
}

/** Main-chat ACP overlay: observe typed DSH events and export only finalized background-job replies. */
export function apply(ctx: Context): void | (() => void) {
    if (process.env.LVTIAN_AUTONOMOUS_JOB_REPLY_FD !== '3') return;
    const output = fs.createWriteStream('', { fd: 3, autoClose: false });
    let disabled = false;
    output.on('error', () => {
        disabled = true;
        ctx.logger.warn('lvtian autonomous job reply pipe failed');
    });
    return applyWithOutput(ctx, output, () => disabled);
}

function applyWithOutput(ctx: Context, output: fs.WriteStream, isDisabled: () => boolean): () => void {

    function send(frame: { kind: 'ownership'; engineSessionId: string; id: string; autonomous: boolean }
        | { kind: 'reply'; engineSessionId: string; turn: number; text: string }): void {
        const line = `${JSON.stringify(frame)}\n`;
        const bytes = Buffer.byteLength(line, 'utf8');
        if (bytes > MAX_FRAME_BYTES || output.writableLength + bytes > MAX_PENDING_BYTES) {
            ctx.logger.warn('lvtian autonomous job reply exceeded pipe limit');
            return;
        }
        output.write(line, 'utf8');
    }

    const turns = new WeakMap<Session, TurnState>();
    const stopClaimed = ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
        const state = turns.get(agent.session);
        if (!state || state.turn !== turn) return;
        if (message.source.kind === 'tool-jobs' && message.source.form === 'notice') state.claimedNotice = true;
        else state.mixed = true;
    });
    // DSH ACP queues committed message/tool updates from this same event. Publish ownership
    // first; transient agent/assistant-stream events have attempt ids, not ACP message ids.
    const stopSession = ctx.on('session/event', (session, event) => {
        if (isDisabled() || !isRoot(session)) return;
        if (event.type === 'turn/start') {
            turns.set(session, { turn: event.data.turn, claimedNotice: false, enteredNotice: false, mixed: false });
            return;
        }
        const state = turns.get(session);
        if (!state) return;
        if (event.type === 'user/message' && event.surfaceOp === 'append') {
            const source: { kind: string; form?: string } = event.data.source;
            if (source.kind === 'tool-jobs' && source.form === 'notice') state.enteredNotice = true;
            else if (source.kind !== 'runtime-context') state.mixed = true;
        } else if (event.type === 'step/start' && event.data.turn === state.turn) {
            // If the final step failed to produce a message, never recycle a preliminary one.
            state.finalText = undefined;
        } else if (event.type === 'tool/call' && event.data.turn === state.turn) {
            const autonomous = state.claimedNotice && state.enteredNotice && !state.mixed;
            send({ kind: 'ownership', engineSessionId: session.id, id: event.data.callId, autonomous });
        } else if (event.type === 'assistant/message' && event.data.turn === state.turn) {
            const autonomous = state.claimedNotice && state.enteredNotice && !state.mixed;
            send({ kind: 'ownership', engineSessionId: session.id, id: event.data.message.id, autonomous });
            state.finalText = undefined;
            if (!autonomous || event.data.interrupted) return;
            const blocks: string[] = [];
            let bytes = 0;
            for (const block of event.data.message.content) {
                if (block.type !== 'text' || block.text.length === 0) continue;
                bytes += Buffer.byteLength(block.text, 'utf8');
                if (bytes > MAX_TEXT_BYTES) return;
                blocks.push(block.text);
            }
            state.finalText = blocks.join('');
        } else if (event.type === 'turn/end' && event.data.turn === state.turn) {
            turns.delete(session);
            const { finalText } = state;
            if (event.data.reason.kind !== 'completed' || state.mixed || !finalText?.trim()) return;
            send({ kind: 'reply', engineSessionId: session.id, turn: state.turn, text: finalText });
        }
    }, { prepend: true });
    return () => {
        stopClaimed();
        stopSession();
        if (!isDisabled()) output.end();
    };
}
