import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import yaml from 'yaml';

/** Register the observer in the managed ACP child only, without changing any user profile. */
export async function prepareAutonomousJobReplyOverlay(dataDir: string): Promise<string> {
    const root = path.join(dataDir, 'autonomous-job-replies');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const content = yaml.stringify([{ insert: [{
        id: 'lvtian-autonomous-job-reply',
        name: fileURLToPath(new URL('./autonomousJobReplyPlugin.js', import.meta.url)),
    }] }]);
    const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const target = path.join(root, `acp-autonomous-job-reply-${digest}.patch.yml`);
    try { await fs.writeFile(target, content, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await fs.readFile(target, 'utf8') !== content) throw new Error('autonomous_job_reply_overlay_conflict');
    }
    return target;
}
