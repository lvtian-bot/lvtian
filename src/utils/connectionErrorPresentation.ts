import type { CredentialsErrorCode } from '../services/connectionConfig';

/** Never expose native storage diagnostics or mislabel failed writes as failed reads. */
export function connectionErrorKey(code: CredentialsErrorCode | null): string {
    switch (code) {
        case 'credentials_read_failed': return 'assistant.tokenReadFailed';
        case 'credentials_write_failed':
        case 'credentials_rollback_failed':
        case 'connection_config_write_failed': return 'assistant.saveFailed';
        default: return 'assistant.connectionReadFailed';
    }
}
