import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GoogleCalendarConfig } from './googleCalendarConfig.js';

const CLIENT = 'lvtian-calendar';
const FLOW_TTL_MS = 5 * 60_000;
const AUTH_TIMEOUT_MS = 25_000;
const STATE = /^[A-Za-z0-9_-]{43}$/; // GOG v0.48 generates 32 random bytes, unpadded base64url.
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/auth';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/calendar.readonly'];

export type GoogleCalendarStatus = {
    status: 'unavailable' | 'disconnected' | 'authorizing' | 'connected' | 'needs_reauth' | 'verification_unavailable';
    account?: string;
};
export class GoogleCalendarError extends Error {
    constructor(readonly code: 'connector_unavailable' | 'connector_operation_failed') { super(code); }
}

export interface GogInvocation {
    file: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    input?: string;
    capture?: boolean;
}
export type GogRunner = (invocation: GogInvocation) => Promise<{ code: number | null; stdout?: string }>;

/** No shell, global GOG settings, command-line logging, or piped stderr. */
export const runGog: GogRunner = ({ file, args, env, cwd, input, capture }) => new Promise(resolve => {
    const child = spawn(file, args, {
        env, cwd, shell: false, windowsHide: true,
        stdio: [input !== undefined ? 'pipe' : 'ignore', capture ? 'pipe' : 'ignore', 'ignore'],
    });
    const output: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    const kill = () => { failed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(kill, AUTH_TIMEOUT_MS);
    child.on('error', () => { failed = true; });
    child.once('close', code => {
        clearTimeout(timer);
        resolve(failed ? { code: null } : { code, ...(capture ? { stdout: Buffer.concat(output).toString('utf8') } : {}) });
    });
    child.stdout?.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 8_192) kill();
        else output.push(chunk);
    });
    child.stdin?.on('error', () => { failed = true; });
    child.stdin?.end(input);
});

interface Flow { state: string; expires: number; }

function readAuthorizationUrl(raw: string | undefined, config: GoogleCalendarConfig): { url: string; state: string } {
    const parsed: unknown = JSON.parse(raw ?? '');
    if (!parsed || typeof parsed !== 'object') throw new Error();
    const { auth_url, state_reused } = parsed as Record<string, unknown>;
    if (typeof auth_url !== 'string' || state_reused !== false) throw new Error();
    const url = new URL(auth_url);
    if (url.origin + url.pathname !== GOOGLE_AUTH || url.username || url.password || url.hash) throw new Error();
    const params = url.searchParams;
    const redirect = params.get('redirect_uri');
    const state = params.get('state');
    const challenge = params.get('code_challenge');
    const scopes = params.get('scope')?.split(' ');
    if (redirect !== config.redirectUri || !state || !STATE.test(state) || !challenge || !STATE.test(challenge)
        || !scopes || scopes.length !== SCOPES.length || !SCOPES.every(scope => scopes.includes(scope))) throw new Error();
    // Rebuild from a fixed schema: never forward unexpected CLI parameters or embedded diagnostics.
    const safeParams = new URLSearchParams({
        client_id: config.clientId, redirect_uri: redirect, response_type: 'code', access_type: 'offline',
        prompt: 'consent', code_challenge_method: 'S256', code_challenge: challenge, scope: scopes.join(' '), state,
    });
    if (params.size !== safeParams.size) throw new Error();
    for (const [key, value] of safeParams) {
        if (params.getAll(key).length !== 1 || params.get(key) !== value) throw new Error();
    }
    return { url: `${GOOGLE_AUTH}?${safeParams}`, state };
}

export class GoogleCalendarConnector {
    private queue = Promise.resolve();
    private flow?: Flow;
    private expiry?: ReturnType<typeof setTimeout>;
    private exchanging = false;
    private generation = 0;
    private initialized = false;

    constructor(
        private readonly config?: GoogleCalendarConfig,
        private readonly runner: GogRunner = runGog,
        private readonly now = Date.now,
    ) {}

    get redirectUri(): string | undefined { return this.config?.redirectUri; }

    private serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(operation);
        this.queue = result.then(() => {}, () => {});
        return result;
    }

    private home(name: 'pending' | 'active'): string {
        return path.join(this.config!.dir, `gog-${name}`);
    }

    private async remove(name: 'pending' | 'active'): Promise<void> {
        // Only the dedicated, fixed child of the validated runtime directory. rm does not follow symlinks.
        await fs.rm(this.home(name), { recursive: true, force: true });
    }

    private async prepare(): Promise<void> {
        if (this.initialized) return;
        await this.remove('pending'); // No in-memory flow can survive a daemon restart.
        this.initialized = true;
    }

    private clearFlow(): void {
        this.flow = undefined;
        clearTimeout(this.expiry);
    }

    private run(home: string, command: string, args: string[], input?: string, capture?: boolean) {
        const config = this.config!;
        const env = {
            HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg-config'), XDG_DATA_HOME: path.join(home, 'xdg-data'),
            XDG_CACHE_HOME: path.join(home, 'xdg-cache'), XDG_STATE_HOME: path.join(home, 'xdg-state'),
            GOG_KEYRING_BACKEND: 'file', GOG_KEYRING_PASSWORD: config.keyringPassword,
        };
        return this.runner({ file: config.gogPath, cwd: home, env, input, capture, args: [
            `--home=${home}`, `--client=${CLIENT}`, '--no-input', '--readonly', '--gmail-no-send', '--json',
            `--enable-commands-exact=${command}`, ...args,
        ] });
    }

    private remoteArgs(step: 1 | 2): string[] {
        const config = this.config!;
        return ['auth', 'add', config.account, '--remote', `--step=${step}`, '--services=calendar',
            `--redirect-uri=${config.redirectUri}`, '--force-consent'];
    }

    private verify(home: string) {
        return this.run(home, 'calendar.calendars', [`--account=${this.config!.account}`, 'calendar', 'calendars', '--max=1']);
    }

    private configFingerprint(): string {
        const { account, clientId, clientSecret, keyringPassword, redirectUri } = this.config!;
        return createHash('sha256').update(JSON.stringify([account, clientId, clientSecret, keyringPassword, redirectUri])).digest('hex');
    }

    status(): Promise<GoogleCalendarStatus> {
        if (!this.config) return Promise.resolve({ status: 'unavailable' });
        if (this.exchanging) return Promise.resolve({ status: 'authorizing' });
        return this.serialize(async () => {
            try {
                await this.prepare();
                if (this.flow) {
                    if (this.flow.expires > this.now()) return { status: 'authorizing' };
                    this.clearFlow();
                    await this.remove('pending');
                }
                const home = this.home('active');
                const stat = await fs.lstat(home).catch((err: NodeJS.ErrnoException) => {
                    if (err.code === 'ENOENT') return undefined;
                    throw err;
                });
                if (!stat) return { status: 'disconnected' };
                if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) return { status: 'unavailable' };
                const marker = path.join(home, 'lvtian-verified');
                const verified = await fs.lstat(marker).catch(() => undefined);
                if (!verified?.isFile() || verified.size !== 64 || await fs.readFile(marker, 'utf8') !== this.configFingerprint()) {
                    return { status: 'needs_reauth' };
                }
                const result = await this.verify(home).catch(() => ({ code: null }));
                if (result.code === 0) return { status: 'connected', account: this.config!.account };
                // v0.48 exit 4: missing/revoked authorization or insufficient scope. Don't diagnose outages as revocation.
                if (result.code === 4) return { status: 'needs_reauth', account: this.config!.account };
                return { status: 'verification_unavailable', account: this.config!.account };
            } catch {
                return { status: 'unavailable' };
            }
        });
    }

    connect(): Promise<{ authorizationUrl: string }> {
        if (!this.config) return Promise.reject(new GoogleCalendarError('connector_unavailable'));
        this.clearFlow();
        const generation = ++this.generation;
        return this.serialize(async () => {
            const config = this.config!;
            const home = this.home('pending');
            try {
                if (generation !== this.generation) throw new Error();
                await this.prepare();
                await this.remove('pending');
                await fs.mkdir(home, { mode: 0o700 });
                const credential = JSON.stringify({ web: { client_id: config.clientId, client_secret: config.clientSecret } });
                if ((await this.run(home, 'auth.credentials.set', ['auth', 'credentials', 'set', '-'], credential)).code !== 0) throw new Error();
                if (generation !== this.generation) throw new Error();
                const result = await this.run(home, 'auth.add', this.remoteArgs(1), undefined, true);
                if (result.code !== 0 || generation !== this.generation) throw new Error();
                const { state, url } = readAuthorizationUrl(result.stdout, config);
                const flow = { state, expires: this.now() + FLOW_TTL_MS };
                this.flow = flow;
                this.expiry = setTimeout(() => {
                    void this.serialize(async () => {
                        if (this.flow !== flow) return;
                        this.clearFlow();
                        await this.remove('pending');
                    }).catch(() => {});
                }, FLOW_TTL_MS);
                this.expiry.unref();
                return { authorizationUrl: url };
            } catch {
                await this.remove('pending').catch(() => {});
                throw new GoogleCalendarError('connector_operation_failed');
            }
        });
    }

    callback(state: string, code?: string): Promise<boolean> {
        const flow = this.flow;
        if (!this.config || !flow || flow.expires <= this.now() || !STATE.test(state)
            || !timingSafeEqual(Buffer.from(state), Buffer.from(flow.state))) return Promise.resolve(false);
        this.clearFlow(); // Consume synchronously, even on denied consent or exchange failure.
        const generation = this.generation;
        this.exchanging = true;
        return this.serialize(async () => {
            const config = this.config!;
            const home = this.home('pending');
            try {
                if (!code || generation !== this.generation || flow.expires <= this.now()) return false;
                const redirect = `${config.redirectUri}?${new URLSearchParams({ state, code })}`;
                const args = [...this.remoteArgs(2), `--auth-url=${redirect}`];
                if ((await this.run(home, 'auth.add', args)).code !== 0 || generation !== this.generation) return false;
                if ((await this.verify(home)).code !== 0 || generation !== this.generation) return false;
                await fs.writeFile(path.join(home, 'lvtian-verified'), this.configFingerprint(), { mode: 0o600, flag: 'wx' });
                if (generation !== this.generation) return false;
                // Keep an existing connection if a replacement attempt fails before verification.
                await this.remove('active');
                await fs.rename(home, this.home('active'));
                return generation === this.generation;
            } catch {
                return false;
            } finally {
                this.exchanging = false;
                await this.remove('pending').catch(() => {});
            }
        });
    }

    disconnect(): Promise<GoogleCalendarStatus> {
        if (!this.config) return Promise.resolve({ status: 'unavailable' });
        this.clearFlow();
        this.generation++;
        return this.serialize(async () => {
            try {
                await this.remove('pending');
                await this.remove('active');
                return { status: 'disconnected' };
            } catch {
                // Never claim disconnect when credential deletion failed.
                throw new GoogleCalendarError('connector_operation_failed');
            }
        });
    }
}
