import type { Readable } from 'node:stream';

export interface AutonomousJobReply { engineSessionId: string; turn: number; text: string }
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_OWNERS = 4096;
const MAX_PENDING_BYTES = 2 * 1024 * 1024;
const PENDING_ENTRY_BYTES = 256;
const ID_LIMIT = 256;

interface PendingUpdate { key?: string; bytes: number; apply: () => void }
interface PendingSession {
    updates: PendingUpdate[];
    error?: Error;
    settled?: (error?: Error) => void;
}

function validId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= ID_LIMIT && !value.includes('\0');
}

/** The private engine pipe identifies the owner of otherwise unlabelled ACP updates. */
export class AutonomousJobReplyBridge {
    private readonly owners = new Map<string, boolean>();
    private readonly pending = new Map<string, PendingSession>();
    private pendingBytes = 0;
    private broken = false;

    constructor(private readonly publish: (reply: AutonomousJobReply) => void) {}

    attach(stream: Readable): void {
        let line = '';
        let bytes = 0;
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
            const parts = chunk.split('\n');
            for (const [index, part] of parts.entries()) {
                bytes += Buffer.byteLength(part);
                if (bytes > MAX_FRAME_BYTES) { this.fail(); stream.destroy(); return; }
                line += part;
                if (index < parts.length - 1) { this.receive(line); line = ''; bytes = 0; }
            }
        });
        stream.once('error', () => this.fail());
        stream.once('close', () => this.fail());
    }

    receive(line: string): void {
        if (this.broken) return;
        let input: unknown;
        try { input = JSON.parse(line); } catch { this.fail(); return; }
        if (!input || typeof input !== 'object') { this.fail(); return; }
        const { kind, engineSessionId, turn, text, id, autonomous } = input as Record<string, unknown>;
        if (!validId(engineSessionId)) { this.fail(); return; }
        if (kind === 'ownership' && validId(id) && typeof autonomous === 'boolean') {
            const key = this.key(engineSessionId, id);
            this.owners.set(key, autonomous);
            this.flush(engineSessionId);
            if (this.owners.size > MAX_OWNERS) this.owners.delete(this.owners.keys().next().value!);
        } else if (kind === 'reply' && typeof turn === 'number' && Number.isSafeInteger(turn) && turn > 0
            && typeof text === 'string' && text.trim() && Buffer.byteLength(text) <= MAX_FRAME_BYTES) {
            try { this.publish({ engineSessionId, turn, text }); }
            catch { console.error('[AutonomousJobReply] Failed to persist an engine reply'); }
        } else { this.fail(); }
    }

    route(engineSessionId: string, id: string | undefined, apply: () => void, payloadBytes: () => number): void {
        if (this.broken) return;
        const current = this.pending.get(engineSessionId);
        if (current?.error) return;
        const key = id ? this.key(engineSessionId, id) : undefined;
        const owner = key ? this.owners.get(key) : false;
        if (owner === true) return;
        if (!current && owner === false) { apply(); return; }

        // The two pipes may still be delivered out of order. Bound only this race window,
        // by retained payload + per-entry cost, rather than counting the model's chunks.
        const session = current ?? { updates: [] };
        if (!current) this.pending.set(engineSessionId, session);
        const bytes = PENDING_ENTRY_BYTES + payloadBytes();
        if (this.pendingBytes + bytes > MAX_PENDING_BYTES) {
            this.discard(session, new Error('ACP reply ownership queue overflow'));
            return;
        }
        session.updates.push({ key, bytes, apply });
        this.pendingBytes += bytes;
    }

    async drain(engineSessionId: string): Promise<void> {
        if (this.broken) throw new Error('ACP reply ownership stream unavailable');
        const session = this.pending.get(engineSessionId);
        if (!session) return;
        if (session.error) throw session.error;
        await new Promise<void>((resolve, reject) => {
            // After this prompt settled, its ACP updates have arrived and only the local pipe can lag.
            const timer = setTimeout(() => this.discard(session, new Error('ACP reply ownership timed out')), 3_000);
            session.settled = error => {
                clearTimeout(timer);
                if (error) reject(error);
                else resolve();
            };
        });
    }

    /** Release a finished/failed prompt without affecting any other session or future prompt. */
    release(engineSessionId: string): void {
        const session = this.pending.get(engineSessionId);
        if (!session) return;
        this.discard(session, new Error('ACP reply ownership request ended'));
        this.pending.delete(engineSessionId);
    }

    private flush(engineSessionId: string): void {
        const session = this.pending.get(engineSessionId);
        if (!session || session.error) return;
        let ready = 0;
        const forward: (() => void)[] = [];
        for (const { key, bytes, apply } of session.updates) {
            const owner = key ? this.owners.get(key) : false;
            if (owner === undefined) break;
            ready++;
            this.pendingBytes -= bytes;
            if (owner === false) forward.push(apply);
        }
        session.updates.splice(0, ready);
        if (!session.updates.length) {
            this.pending.delete(engineSessionId);
            session.settled?.();
        }
        for (const apply of forward) apply();
    }

    private discard(session: PendingSession, error: Error): void {
        for (const entry of session.updates) this.pendingBytes -= entry.bytes;
        session.updates.length = 0;
        session.error = error;
        session.settled?.(error);
    }

    private fail(): void {
        this.broken = true;
        const error = new Error('ACP reply ownership stream unavailable');
        for (const session of this.pending.values()) this.discard(session, error);
        this.pending.clear();
        this.owners.clear();
    }

    private key(sessionId: string, id: string): string { return `${sessionId}\0${id}`; }
}
