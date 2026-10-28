import AsyncStorage from '@react-native-async-storage/async-storage';

const CONNECTION_BACKUP_KEY = 'lvtian-connection-url-v1';

const validUrl = (value: unknown): value is string => typeof value === 'string'
    && /^(https?|wss?):\/\/\S+$/i.test(value.trim());

/**
 * 连接地址单独留一份小记录。
 * 聊天记录与 serverUrl 共用同一条持久化记录，记录损坏或读写失败时，
 * 这里仍能恢复服务器地址，避免热更新后被要求重新输入配置。
 */
export async function saveConnectionUrl(url: string): Promise<void> {
    const clean = url.trim();
    if (!validUrl(clean)) return;
    try {
        await AsyncStorage.setItem(CONNECTION_BACKUP_KEY, JSON.stringify({ url: clean }));
    } catch (err) {
        // 备份失败不能影响主配置写入与连接。
        console.warn('[connectionBackup] 保存连接地址失败:', err);
    }
}

export async function loadConnectionUrl(): Promise<string | undefined> {
    try {
        const raw = await AsyncStorage.getItem(CONNECTION_BACKUP_KEY);
        if (!raw) return undefined;
        const parsed: unknown = JSON.parse(raw);
        const url = parsed !== null && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>).url
            : undefined;
        return validUrl(url) ? url.trim() : undefined;
    } catch {
        return undefined;
    }
}
