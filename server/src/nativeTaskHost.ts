import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface NativeTaskHostEndpoint {
    origin: string;
    /** Process-lifetime credential: never serialize this object or log this value. */
    token: string;
}

export interface NativeTaskHostOptions {
    /** Dedicated persistent root; must not be the main Harness home. */
    root: string;
    workspace: string;
    /** Existing controlled model environment; values are never written to disk. */
    modelEnvironment?: Readonly<Record<string, string>>;
    launcher?: string;
    startupTimeoutMs?: number;
    stopTimeoutMs?: number;
    onUnexpectedExit?: () => void;
}

const managedOverlay = '- id: session-log-deepseek\n  disabled: true\n- id: session-telemetry-otel\n  disabled: true\n';

/** Owns only a native Harness process. It never computes a task's execution time. */
export class NativeTaskHost {
    private child?: ChildProcessWithoutNullStreams;
    private starting?: Promise<NativeTaskHostEndpoint>;
    private stopping?: Promise<void>;
    private endpoint?: NativeTaskHostEndpoint;

    constructor(private readonly options: NativeTaskHostOptions) {}

    async start(): Promise<NativeTaskHostEndpoint> {
        if (this.stopping) await this.stopping;
        if (this.endpoint) return this.endpoint;
        if (this.starting) return this.starting;
        this.starting = this.launch();
        try { return await this.starting; }
        finally { this.starting = undefined; }
    }

    private async launch(): Promise<NativeTaskHostEndpoint> {
        const root = path.resolve(this.options.root);
        const home = path.join(root, 'home');
        const agents = path.join(root, 'agents');
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        await fs.mkdir(agents, { recursive: true, mode: 0o700 });
        try {
            const overlay = path.join(root, 'managed-host.patch.yml');
            try { await fs.writeFile(overlay, managedOverlay, { flag: 'wx', mode: 0o600 }); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                if (await fs.readFile(overlay, 'utf8') !== managedOverlay) throw new Error('native_host_overlay_conflict');
            }
            const launcher = this.options.launcher ?? path.join(path.dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js');
            const runner = fileURLToPath(new URL('./nativeTaskHostRunner.js', import.meta.url));
            const env: NodeJS.ProcessEnv = {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                USERPROFILE: process.env.USERPROFILE,
                SystemRoot: process.env.SystemRoot,
                TEMP: process.env.TEMP,
                TMP: process.env.TMP,
                ...this.options.modelEnvironment,
                DSH_HOME: home,
                DSH_AGENTS_HOME: agents,
            };
            const child = spawn(process.execPath, [runner, path.join(root, 'host-lease.sqlite'), launcher, '--profile', 'web', '--patch', overlay, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
                cwd: this.options.workspace, env, stdio: ['pipe', 'pipe', 'pipe'],
            });
            this.child = child;
            // Keep the pipe open: the runner terminates when this supervisor disappears.
            child.stdin.on('error', () => undefined);
            child.once('exit', () => {
                if (this.child !== child) return;
                this.endpoint = undefined;
                this.child = undefined;
                this.options.onUnexpectedExit?.();
            });
            const endpoint = await new Promise<NativeTaskHostEndpoint>((resolve, reject) => {
                let buffer = '';
                let settled = false;
                const timer = setTimeout(() => reject(new Error('native_host_startup_timeout')), this.options.startupTimeoutMs ?? 30000);
                const settle = (result?: NativeTaskHostEndpoint, error?: Error) => {
                    if (settled) return;
                    settled = true;
                    buffer = '';
                    clearTimeout(timer);
                    if (error) reject(error);
                    else if (result) resolve(result);
                };
                child.once('error', () => settle(undefined, new Error('native_host_spawn_failed')));
                child.once('exit', () => settle(undefined, new Error('native_host_exited')));
                for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => {
                    if (settled) return;
                    // Keep startup credentials in memory only; discard other host diagnostics.
                    buffer = (buffer + chunk.toString('utf8')).slice(-65536);
                    const match = buffer.match(/http:\/\/127\.0\.0\.1:(\d+)\/?\?token=([A-Za-z0-9_-]+)(?=[^A-Za-z0-9_-])/);
                    if (match) settle({ origin: `http://127.0.0.1:${match[1]}`, token: match[2] });
                });
            });
            this.endpoint = endpoint;
            return endpoint;
        } catch (error) {
            await this.terminate();
            throw error;
        }
    }

    async stop(): Promise<void> {
        if (this.stopping) return this.stopping;
        this.stopping = (async () => {
            if (this.starting) await this.starting.catch(() => undefined);
            await this.terminate();
        })();
        try { await this.stopping; }
        finally { this.stopping = undefined; }
    }

    private async terminate(): Promise<void> {
        const child = this.child;
        this.child = undefined;
        this.endpoint = undefined;
        if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
            await new Promise<void>(resolve => {
                const timer = setTimeout(() => child.kill('SIGKILL'), this.options.stopTimeoutMs ?? 10000);
                child.once('exit', () => { clearTimeout(timer); resolve(); });
                child.kill('SIGTERM');
            });
        }
        this.child = undefined;
    }
}
