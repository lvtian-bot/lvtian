import { Context } from '@deepseek-ai/cordis';
import * as registry from '@deepseek-ai/dsh-typert-registry/client';
import { installConnection, type ClientTransportHooks, type ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client';
import * as gateway from '@deepseek-ai/dsh-api-gateway/client';
import sessionContribution from '@deepseek-ai/dsh-api-session-controller/remote';
import scheduleContribution from '@deepseek-ai/dsh-schedule/remote';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import WebSocket from 'ws';

type Schedule = Context['remote']['schedule'];
type Session = Pick<Context['remote']['session'], 'create' | 'prompt' | 'projections' | 'page'> & Partial<Pick<Context['remote']['session'], 'control'>>;
export interface NativeTaskRemote {
  readonly schedule: Schedule;
  readonly session: Session;
  dispose(): Promise<void>;
}
export interface NativeTaskClientDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly createWebSocket?: (url: string, cookie: string) => ConnectionWebSocket;
  /** Factory owns partial-initialization cleanup if it rejects. No RPC framing belongs here. */
  readonly factory?: (transport: ClientTransportHooks, signal: AbortSignal) => Promise<NativeTaskRemote>;
}
export interface NativeTaskClientOptions {
  readonly origin: string;
  readonly bootToken: string;
  readonly timeoutMs?: number;
}
export type NativeTaskClientErrorCode = 'invalid_endpoint' | 'invalid_token' | 'authentication_failed' | 'connection_failed' | 'timeout' | 'disposed' | 'remote_failed' | 'dispose_failed';
export class NativeTaskClientError extends Error {
  constructor(
    readonly code: NativeTaskClientErrorCode,
    readonly operation: string,
    readonly outcomeUnknown = false,
  ) {
    super(`Native task client: ${code} (${operation})`);
    this.name = 'NativeTaskClientError';
  }
}

function checkedOrigin(input: string): string {
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol)
      || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || (input !== url.origin && input !== `${url.origin}/`)) throw new Error();
    return url.origin;
  } catch { throw new NativeTaskClientError('invalid_endpoint', 'connect'); }
}

async function officialFactory(transport: ClientTransportHooks, signal: AbortSignal): Promise<NativeTaskRemote> {
  const ctx = new Context();
  try {
    registry.apply(ctx);
    installConnection(ctx, { interactions: 'none', transport });
    gateway.apply(ctx);
    await ctx.remote.$mount(sessionContribution);
    await ctx.remote.$mount(scheduleContribution);
    signal.throwIfAborted();
    return { schedule: ctx.remote.schedule, session: ctx.remote.session, dispose: async () => { await ctx.fiber.dispose(); } };
  } catch {
    try { await ctx.fiber.dispose(); } catch { /* Never expose transport errors or credentials. */ }
    throw new NativeTaskClientError('connection_failed', 'connect');
  }
}

/** Trusted server-to-loopback adapter, not an end-user authorization boundary or scheduler.
 * A lost/expired connection must be replaced via connect with the current host token.
 * No mutating call is retried: reconcile native facts when outcomeUnknown is true.
 */
export class NativeTaskClient {
  #remote?: NativeTaskRemote;
  #controller = new AbortController();
  #sockets = new Set<ConnectionWebSocket>();
  #cookie = '';
  #disposePromise?: Promise<void>;
  #failure?: NativeTaskClientErrorCode;
  private constructor(private readonly timeoutMs: number) {}

  static async connect(options: NativeTaskClientOptions, dependencies: NativeTaskClientDependencies = {}): Promise<NativeTaskClient> {
    const origin = checkedOrigin(options.origin);
    if (!/^[a-zA-Z0-9_-]+$/.test(options.bootToken)) throw new NativeTaskClientError('invalid_token', 'connect');
    const timeoutMs = options.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new NativeTaskClientError('invalid_endpoint', 'connect');
    const client = new NativeTaskClient(timeoutMs);
    const fetcher = dependencies.fetch ?? globalThis.fetch;
    try {
      await client.#bounded('connect', false, async signal => {
        const connectUrl = new URL('/connect', origin);
        connectUrl.searchParams.set('token', options.bootToken);
        connectUrl.searchParams.set('interactions', 'none');
        const response = await fetcher(connectUrl, { redirect: 'manual', signal });
        const cookie = response.headers.get('set-cookie')?.split(';')[0];
        if (response.status !== 302 || !cookie || !/^[!#$%&'*+.^_`|~\w-]+=[a-zA-Z0-9_.-]+$/.test(cookie)) {
          throw new NativeTaskClientError('authentication_failed', 'connect');
        }
        client.#cookie = cookie;
        const transport: ClientTransportHooks = {
          streamBaseUrl: origin,
          fetch: async (input, init) => {
            const target = new URL(input, origin);
            if (target.origin !== origin || target.username || target.password) throw new NativeTaskClientError('connection_failed', 'transport');
            client.#assertUsable('transport');
            const headers = new Headers(init?.headers);
            headers.set('Cookie', client.#cookie);
            const requestSignal = AbortSignal.any([client.#controller.signal, AbortSignal.timeout(timeoutMs), ...(init?.signal ? [init.signal] : [])]);
            try {
              const result = await fetcher(target, { ...init, headers, redirect: 'manual', signal: requestSignal });
              if (result.status === 401 || result.status === 403) {
                client.#invalidate('authentication_failed');
                throw new NativeTaskClientError('authentication_failed', 'transport');
              }
              if (result.status >= 300 && result.status < 400) throw new NativeTaskClientError('connection_failed', 'transport');
              return result;
            } catch {
              client.#invalidate(client.#failure ?? 'connection_failed');
              throw new NativeTaskClientError(client.#failure ?? 'connection_failed', 'transport');
            }
          },
          createWebSocket: address => {
            client.#assertUsable('transport');
            const target = new URL(address);
            const expected = new URL(origin);
            expected.protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:';
            if (target.origin !== expected.origin || target.username || target.password) throw new NativeTaskClientError('connection_failed', 'transport');
            const socket = dependencies.createWebSocket?.(address, client.#cookie)
              ?? new WebSocket(address, { headers: { Cookie: client.#cookie } });
            client.#sockets.add(socket);
            socket.addEventListener('close', () => { client.#sockets.delete(socket); client.#invalidate('connection_failed'); });
            return socket;
          },
        };
        const remote = await (dependencies.factory ?? officialFactory)(transport, signal);
        // A timed-out factory can still finish; do not leak its context.
        if (signal.aborted) { await remote.dispose(); signal.throwIfAborted(); }
        client.#remote = remote;
        const ready = await remote.schedule.catalog();
        if (!ready.ok) throw new NativeTaskClientError('connection_failed', 'connect');
      });
      return client;
    } catch (error) {
      try { await client.dispose(); } catch { /* Preserve the safe connection error. */ }
      throw error instanceof NativeTaskClientError ? error : new NativeTaskClientError('connection_failed', 'connect');
    }
  }

  #assertUsable(operation: string): void {
    if (this.#controller.signal.aborted) throw new NativeTaskClientError(this.#failure ?? 'disposed', operation);
  }
  #invalidate(code: NativeTaskClientErrorCode): void {
    if (this.#controller.signal.aborted) return;
    this.#failure = code;
    this.#cookie = '';
    this.#controller.abort();
    for (const socket of this.#sockets) { try { socket.close(); } catch { /* Best-effort physical close. */ } }
    this.#sockets.clear();
  }
  async #bounded<T>(operation: string, write: boolean, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#assertUsable(operation);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.#controller.signal]);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        run(signal),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new NativeTaskClientError(timedOut ? 'timeout' : this.#failure ?? 'disposed', operation, write));
          if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } catch (error) {
      if (timedOut) { this.#invalidate('timeout'); throw new NativeTaskClientError('timeout', operation, write); }
      if (this.#failure) throw new NativeTaskClientError(this.#failure, operation, write);
      if (error instanceof NativeTaskClientError) throw new NativeTaskClientError(error.code, operation, write);
      this.#invalidate('connection_failed');
      throw new NativeTaskClientError('connection_failed', operation, write);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }
  async #call<T>(operation: string, write: boolean, run: (remote: NativeTaskRemote, signal: AbortSignal) => Promise<RemoteResult<T>>): Promise<T> {
    return this.#bounded(operation, write, async signal => {
      if (!this.#remote) throw new NativeTaskClientError('connection_failed', operation);
      const result = await run(this.#remote, signal);
      if (!result.ok) throw new NativeTaskClientError('remote_failed', operation, write);
      return result.value;
    });
  }

  catalog() { return this.#call('catalog', false, remote => remote.schedule.catalog()); }
  list(request: Parameters<Schedule['list']>[0]) { return this.#call('list', false, remote => remote.schedule.list(request)); }
  history(request: Parameters<Schedule['history']>[0]) { return this.#call('history', false, remote => remote.schedule.history(request)); }
  create(request: Parameters<Schedule['create']>[0]) { return this.#call('create', true, (remote, signal) => remote.schedule.create(request, signal)); }
  edit(request: Parameters<Schedule['edit']>[0]) { return this.#call('edit', true, (remote, signal) => remote.schedule.edit(request, signal)); }
  createSession(request: Parameters<Session['create']>[0]) { return this.#call('createSession', true, remote => remote.session.create(request)); }
  prompt(request: Parameters<Session['prompt']>[0]) { return this.#call('prompt', true, (remote, signal) => remote.session.prompt(request, signal)); }
  projections(request: Parameters<Session['projections']>[0]) { return this.#call('projections', false, (remote, signal) => remote.session.projections(request, signal)); }
  page(request: Parameters<Session['page']>[0]) { return this.#call('page', false, (remote, signal) => remote.session.page(request, signal)); }

  /** Official host-wide projection stream. Read-only; cold history remains authoritative. */
  async watchChanges(onChange: () => void, signal: AbortSignal): Promise<void> {
    this.#assertUsable('control');
    if (!this.#remote?.session.control) throw new NativeTaskClientError('remote_failed', 'control');
    const combined = AbortSignal.any([signal, this.#controller.signal]);
    for await (const _frame of this.#remote.session.control(combined)) {
      if (combined.aborted) break;
      onChange();
    }
  }

  dispose(): Promise<void> {
    if (!this.#disposePromise) {
      this.#invalidate('disposed');
      const remote = this.#remote;
      this.#remote = undefined;
      this.#disposePromise = (async () => {
        try { await remote?.dispose(); }
        catch { throw new NativeTaskClientError('dispose_failed', 'dispose'); }
      })();
    }
    return this.#disposePromise;
  }
}
