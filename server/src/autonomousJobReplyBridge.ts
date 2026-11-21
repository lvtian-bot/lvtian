import type { Readable } from 'node:stream';

export interface AutonomousJobReply { engineSessionId: string; turn: number; text: string }
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_OWNERS = 4096;
const MAX_PENDING = 1024;
const ID_LIMIT = 256;

function validId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= ID_LIMIT && !value.includes('\0');
}

/** The private engine pipe identifies the owner of otherwise unlabelled ACP updates. */
export class AutonomousJobReplyBridge {
    private readonly owners = new Map<string, boolean>();
    private readonly pending: { key?: string; apply: () => void }[] = [];
    private readonly drainers = new Set<() => void>();
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
            this.flush();
            if (this.owners.size > MAX_OWNERS) this.owners.delete(this.owners.keys().next().value!);
        } else if (kind === 'reply' && typeof turn === 'number' && Number.isSafeInteger(turn) && turn > 0
            && typeof text === 'string' && text.trim() && Buffer.byteLength(text) <= MAX_FRAME_BYTES) {
            try { this.publish({ engineSessionId, turn, text }); }
            catch { console.error('[AutonomousJobReply] Failed to persist an engine reply'); }
        } else { this.fail(); }
    }

    route(engineSessionId: string, id: string | undefined, apply: () => void): void {
        if (this.broken) return;
        if (this.pending.length >= MAX_PENDING) { this.fail(); return; }
        this.pending.push({ key: id ? this.key(engineSessionId, id) : undefined, apply });
        this.flush();
    }

    async drain(): Promise<void> {
        if (this.broken) throw new Error('ACP reply ownership stream unavailable');
        if (!this.pending.length) return;
        await new Promise<void>((resolve, reject) => {
            const done = () => {
                clearTimeout(timer);
                if (this.broken) reject(new Error('ACP reply ownership stream unavailable'));
                else resolve();
            };
            // Both pipes are local and the prompt has already settled; a missing owner is a protocol failure.
            const timer = setTimeout(() => this.fail(), 3_000);
            this.drainers.add(done);
        });
    }

    private flush(): void {
        while (this.pending.length) {
            const { key, apply } = this.pending[0];
            if (key && !this.owners.has(key)) break;
            this.pending.shift();
            if (!key || this.owners.get(key) === false) apply();
        }
        if (!this.pending.length) this.notifyDrainers();
    }

    private fail(): void {
        this.broken = true;
        this.pending.length = 0;
        this.owners.clear();
        this.notifyDrainers();
    }

    private notifyDrainers(): void {
        for (const done of this.drainers) done();
        this.drainers.clear();
    }

    private key(sessionId: string, id: string): string { return `${sessionId}\0${id}`; }
}
