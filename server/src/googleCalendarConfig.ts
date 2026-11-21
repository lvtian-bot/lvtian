import fs from 'node:fs';
import path from 'node:path';

export const GOOGLE_CALENDAR_CALLBACK = '/oauth/google-calendar/callback';

export interface GoogleCalendarConfig {
    dir: string;
    gogPath: string;
    account: string;
    clientId: string;
    clientSecret: string;
    keyringPassword: string;
    redirectUri: string;
}

function contains(parent: string, child: string): boolean {
    const rel = path.relative(parent, child);
    return !rel || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

/** Runtime-only config. Never merge it with the server's persisted user config or pass it to ACP. */
export function loadGoogleCalendarConfig(dir: string | undefined, fileRoots: string[]): GoogleCalendarConfig | undefined {
    try {
        // POSIX ownership/modes are a requirement of this deployment, not emulated on Windows.
        if (!dir || !path.isAbsolute(dir) || !process.getuid) return;
        const realDir = fs.realpathSync(dir);
        if (path.resolve(dir) !== realDir) return;
        for (const root of fileRoots) {
            const realRoot = fs.realpathSync(root);
            if (contains(realRoot, realDir) || contains(realDir, realRoot)) return;
        }
        const dirStat = fs.lstatSync(realDir);
        if (!dirStat.isDirectory() || dirStat.uid !== process.getuid() || (dirStat.mode & 0o777) !== 0o700) return;
        const file = path.join(realDir, 'runtime.json');
        const fileStat = fs.lstatSync(file);
        if (!fileStat.isFile() || fileStat.nlink !== 1 || fileStat.uid !== process.getuid()
            || (fileStat.mode & 0o777) !== 0o600 || fileStat.size > 16_384) return;
        const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!raw || typeof raw !== 'object') return;
        const { gogPath, account, clientId, clientSecret, keyringPassword, redirectUri } = raw as Record<string, unknown>;
        if (typeof gogPath !== 'string' || !path.isAbsolute(gogPath) || !fs.statSync(gogPath).isFile()) return;
        fs.accessSync(gogPath, fs.constants.X_OK);
        if (typeof account !== 'string' || !/^[a-z\d][a-z\d.!#$%&'*+/=?^_`{|}~-]{0,127}@[a-z\d-]+(?:\.[a-z\d-]+)+$/i.test(account)) return;
        if (typeof clientId !== 'string' || !/^[a-z\d-]+\.apps\.googleusercontent\.com$/i.test(clientId)) return;
        if (typeof clientSecret !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(clientSecret)) return;
        if (typeof keyringPassword !== 'string' || !/^[\x21-\x7e]{32,1024}$/.test(keyringPassword)) return;
        if (typeof redirectUri !== 'string' || redirectUri.length > 512) return;
        const url = new URL(redirectUri);
        if (redirectUri !== url.origin + GOOGLE_CALENDAR_CALLBACK || url.protocol !== 'https:'
            || !/^[a-z\d-]+(?:\.[a-z\d-]+)+$/.test(url.hostname)) return;
        return { dir: realDir, gogPath, account: account.toLowerCase(), clientId, clientSecret, keyringPassword, redirectUri };
    } catch {
        return;
    }
}
