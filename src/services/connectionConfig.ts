import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

export const CONNECTION_CONFIG_KEY = 'lvtian-connection-config-v1';
export const ASSISTANT_CHAT_KEY = 'lvtian-assistant-storage';
const TOKEN_KEY = 'lvtian_assistant_token';

export type CredentialsErrorCode =
    | 'connection_config_read_failed'
    | 'connection_config_invalid'
    | 'connection_legacy_read_failed'
    | 'connection_legacy_invalid'
    | 'connection_config_write_failed'
    | 'credentials_read_failed'
    | 'credentials_write_failed'
    | 'credentials_rollback_failed';

/** Only stable codes escape storage boundaries; native errors can contain secrets. */
export class ConnectionConfigError extends Error {
    constructor(public readonly code: CredentialsErrorCode) {
        super(code);
        this.name = 'ConnectionConfigError';
    }
}

export function credentialsErrorCode(error: unknown): CredentialsErrorCode {
    return error instanceof ConnectionConfigError ? error.code : 'connection_config_read_failed';
}

const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/, '');
const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : null;

async function read(key: string, code: CredentialsErrorCode): Promise<string | null> {
    try {
        return await AsyncStorage.getItem(key);
    } catch {
        throw new ConnectionConfigError(code);
    }
}

function parse(raw: string, code: CredentialsErrorCode): Record<string, unknown> {
    try {
        const parsed = record(JSON.parse(raw) as unknown);
        if (parsed) return parsed;
    } catch {
        // Do not leak parser diagnostics (which may include stored data).
    }
    throw new ConnectionConfigError(code);
}

async function writeUrl(url: string): Promise<void> {
    try {
        await AsyncStorage.setItem(CONNECTION_CONFIG_KEY, JSON.stringify({ url }));
    } catch {
        throw new ConnectionConfigError('connection_config_write_failed');
    }
}

/** Missing and unreadable are deliberately different. Empty URL is an explicit config. */
export async function loadConnectionConfig(): Promise<string> {
    const raw = await read(CONNECTION_CONFIG_KEY, 'connection_config_read_failed');
    if (raw !== null) {
        const config = parse(raw, 'connection_config_invalid');
        if (typeof config.url !== 'string') throw new ConnectionConfigError('connection_config_invalid');
        return normalizeUrl(config.url);
    }

    const legacyRaw = await read(ASSISTANT_CHAT_KEY, 'connection_legacy_read_failed');
    let url = '';
    if (legacyRaw !== null) {
        const legacy = parse(legacyRaw, 'connection_legacy_invalid');
        const state = record(legacy.state);
        if (!state || (state.serverUrl !== undefined && typeof state.serverUrl !== 'string')) {
            throw new ConnectionConfigError('connection_legacy_invalid');
        }
        url = normalizeUrl(typeof state.serverUrl === 'string' ? state.serverUrl : '');
    }
    // Commit the migration before callers may overwrite the old chat record. Retrying
    // after interruption is safe: the dedicated record always wins once committed.
    await writeUrl(url);
    return url;
}

export async function loadConnectionCredentials(): Promise<{ url: string; token: string }> {
    const url = await loadConnectionConfig();
    try {
        const token = await SecureStore.getItemAsync(TOKEN_KEY);
        return { url, token: token ?? '' };
    } catch {
        throw new ConnectionConfigError('credentials_read_failed');
    }
}

export async function saveConnectionCredentials(url: string, token: string): Promise<void> {
    let previousToken: string | null;
    try {
        previousToken = await SecureStore.getItemAsync(TOKEN_KEY);
    } catch {
        throw new ConnectionConfigError('credentials_read_failed');
    }
    const storeToken = async (value: string | null): Promise<void> => {
        if (value) await SecureStore.setItemAsync(TOKEN_KEY, value);
        else await SecureStore.deleteItemAsync(TOKEN_KEY);
    };
    try {
        await storeToken(token);
    } catch {
        throw new ConnectionConfigError('credentials_write_failed');
    }
    try {
        await writeUrl(url);
    } catch (error) {
        try {
            await storeToken(previousToken);
        } catch {
            throw new ConnectionConfigError('credentials_rollback_failed');
        }
        throw error;
    }
}
