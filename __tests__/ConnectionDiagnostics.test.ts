import { classifySocketError, readConnectionDiagnostics, recordConnectionEvent } from '../src/services/connectionDiagnostics';
import { fsService } from '../src/services/FileSystemService';

jest.mock('../src/services/FileSystemService', () => ({
    fsService: { appendConnectionLog: jest.fn(), readConnectionLogs: jest.fn() },
}));

const event = {
    time: '2026-11-20T12:25:00.000Z', event: 'timeout', phase: 'sync', connectionId: 1,
    elapsedMs: 20050, phaseElapsedMs: 20000, retryAttempt: 1, network: 'WIFI', appState: 'active',
};

it('keeps native error text out of exported data', () => {
    expect(classifySocketError('Unable to resolve host "private.example"')).toBe('dns');
    expect(classifySocketError('SSLHandshakeException: private certificate')).toBe('tls');
    expect(classifySocketError('unknown private url')).toBe('unknown');
});

it('preserves write order, reports gaps and waits for pending writes before reading', async () => {
    const lines: string[] = [];
    const write = jest.mocked(fsService.appendConnectionLog);
    write.mockRejectedValueOnce(new Error('disk busy')).mockImplementation(async line => { lines.push(line); });
    jest.mocked(fsService.readConnectionLogs).mockImplementation(async () => lines.join('\n'));
    recordConnectionEvent(event);
    await expect(readConnectionDiagnostics()).resolves.toEqual({ content: '', missedWrites: 1 });
    recordConnectionEvent({ ...event, event: 'retry_scheduled' });
    recordConnectionEvent({ ...event, event: 'authenticated' });
    const exported = await readConnectionDiagnostics();
    expect(exported.missedWrites).toBe(0);
    expect(exported.content).not.toContain('private');
    expect(exported.content.split('\n').filter(Boolean).map(line => JSON.parse(line).event))
        .toEqual(['log_write_gap', 'retry_scheduled', 'authenticated']);
});
