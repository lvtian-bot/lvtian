import { useAssistantStore } from '../store/useAssistantStore';
import { fsService } from './FileSystemService';

// Only export fixed categories. Native error messages can contain URLs and credentials.
export function classifySocketError(message: unknown) {
    if (typeof message !== 'string') return 'unknown';
    if (/unknownhost|unable to resolve host|getaddrinfo|name not resolved/i.test(message)) return 'dns';
    if (/certificate|ssl|tls/i.test(message)) return 'tls';
    if (/timed? ?out/i.test(message)) return 'timeout';
    if (/connection refused|econnrefused/i.test(message)) return 'refused';
    if (/expected http 101|unexpected server response/i.test(message)) return 'upgrade_rejected';
    return 'unknown';
}

export interface ConnectionEventDetails {
    errorCategory?: ReturnType<typeof classifySocketError>;
    closeCode?: number;
    retryDelayMs?: number;
    messageCount?: number;
    payloadChars?: number;
}

interface ConnectionEvent extends ConnectionEventDetails {
    time: string;
    event: string;
    phase: string | null;
    connectionId: number;
    elapsedMs: number;
    phaseElapsedMs: number;
    retryAttempt: number;
    network: string;
    appState: string;
}

// Serialize writes and snapshots without making the socket wait for storage.
let pending: Promise<void> = Promise.resolve();
let missedWrites = 0;

export function recordConnectionEvent(event: ConnectionEvent): void {
    const line = JSON.stringify(event);
    console.info('[AssistantClient:connection]', line);
    pending = pending.then(async () => {
        const rows = missedWrites
            ? JSON.stringify({ time: event.time, event: 'log_write_gap', count: missedWrites }) + '\n' + line
            : line;
        await fsService.appendConnectionLog(rows);
        missedWrites = 0;
    }).catch(() => { missedWrites += 1; });
}

export function exportConnectionDiagnostics(): Promise<string> {
    const state = useAssistantStore.getState();
    const time = new Date().toISOString();
    const snapshot = pending.then(() => fsService.exportConnectionLog(JSON.stringify({
        time, event: 'export', connectionState: state.connectionState, configured: Boolean(state.serverUrl),
        credentialsStatus: state.credentialsStatus, credentialsError: state.credentialsError, missedWrites,
    })));
    pending = snapshot.then(() => {}, () => {});
    return snapshot;
}
