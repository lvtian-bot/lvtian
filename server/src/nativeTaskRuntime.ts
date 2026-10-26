import path from 'node:path';
import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { NativeTaskHost } from './nativeTaskHost.js';
import { NativeTaskClient } from './nativeTaskClient.js';
import { NativeTaskService } from './nativeTaskService.js';

export interface NativeTaskRuntimeOptions {
    root: string;
    workspace: string;
    modelEnvironment?: Readonly<Record<string, string>>;
}

/** Process/connection supervision only. All time rules and delivery belong to Harness. */
export class NativeTaskRuntime {
    readonly service: NativeTaskService;
    private readonly host: NativeTaskHost;
    private client?: NativeTaskClient;
    private connecting?: Promise<NativeTaskClient>;
    private closed = false;
    private retry?: ReturnType<typeof setTimeout>;
    private retryMs = 500;
    private readonly ownerLease: { close(): void };
    private stopping?: Promise<void>;

    constructor(private readonly options: NativeTaskRuntimeOptions) {
        // The parent owns operation metadata even while its native child recovers.
        // A separate child lease still protects the native JSON from orphan hosts.
        mkdirSync(options.root, { recursive: true, mode: 0o700 });
        const sqlite = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (filename: string) => { exec(sql: string): void; close(): void } };
        const lease = new sqlite.DatabaseSync(path.join(options.root, 'metadata-owner.sqlite'));
        try { lease.exec('BEGIN EXCLUSIVE'); }
        catch { lease.close(); throw new Error('native_task_metadata_locked'); }
        this.ownerLease = lease;
        this.host = new NativeTaskHost({ ...options, onUnexpectedExit: () => this.scheduleRecovery() });
        this.service = new NativeTaskService({
            workspace: options.workspace,
            metadataPath: path.join(options.root, 'operations.json'),
            clientFactory: () => this.getClient(),
        });
    }

    async start(): Promise<void> {
        try { await this.getClient(); }
        catch (error) { this.scheduleRecovery(); throw error; }
    }

    private scheduleRecovery(): void {
        if (this.closed || this.retry) return;
        this.retry = setTimeout(() => {
            this.retry = undefined;
            this.getClient().catch(() => this.scheduleRecovery());
        }, this.retryMs);
        this.retry.unref();
        this.retryMs = Math.min(30000, this.retryMs * 2);
    }

    private async getClient(): Promise<NativeTaskClient> {
        if (this.closed) throw new Error('native_tasks_stopped');
        if (this.connecting) return this.connecting;
        this.connecting = (async () => {
            if (this.client) {
                try { await this.client.catalog(); return this.client; }
                catch { await this.client.dispose().catch(() => undefined); this.client = undefined; }
            }
            const endpoint = await this.host.start();
            const client = await NativeTaskClient.connect({ origin: endpoint.origin, bootToken: endpoint.token });
            if (this.closed) { await client.dispose(); throw new Error('native_tasks_stopped'); }
            this.client = client;
            this.retryMs = 500;
            return client;
        })();
        try { return await this.connecting; }
        finally { this.connecting = undefined; }
    }

    stop(): Promise<void> {
        if (!this.stopping) this.stopping = this.close();
        return this.stopping;
    }

    private async close(): Promise<void> {
        this.closed = true;
        if (this.retry) { clearTimeout(this.retry); this.retry = undefined; }
        try {
            await this.service.close();
            await this.connecting?.catch(() => undefined);
            try { await this.client?.dispose(); }
            finally { this.client = undefined; await this.host.stop(); }
        } finally { this.ownerLease.close(); }
    }

    /** Only a local module path is written; bearer credentials remain in child environment. */
    async prepareAcpOverlay(): Promise<string> {
        if (this.closed) throw new Error('native_tasks_stopped');
        await fs.mkdir(this.options.root, { recursive: true, mode: 0o700 });
        const overlay = path.join(this.options.root, 'acp-task-bridge.patch.yml');
        const content = yaml.stringify([{ insert: [{
            id: 'lvtian-task-tool-bridge',
            name: fileURLToPath(new URL('./nativeTaskToolBridge.js', import.meta.url)),
        }] }]);
        try { await fs.writeFile(overlay, content, { flag: 'wx', mode: 0o600 }); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (await fs.readFile(overlay, 'utf8') !== content) throw new Error('native_task_bridge_overlay_conflict');
        }
        return overlay;
    }
}
