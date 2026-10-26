// Internal process entry: hold a crash-safe storage lease in the Harness process itself.
// The SQLite file contains no tasks; only the upstream Schedule service schedules work.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [leaseFile, launcher, ...args] = process.argv.slice(2);
if (!leaseFile || !launcher) throw new Error('native_host_runner_arguments_missing');
const sqlite = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (filename: string) => { exec(sql: string): void; close(): void };
};
const lease = new sqlite.DatabaseSync(leaseFile);
try { lease.exec('BEGIN EXCLUSIVE'); }
catch {
    lease.close();
    process.stderr.write('native_host_storage_locked\n');
    process.exit(73);
}
// An exclusive transaction survives for this process's lifetime. OS cleanup releases
// it even on SIGKILL, including if the supervising server died before the Harness.
process.stdin.once('end', () => process.kill(process.pid, 'SIGTERM'));
process.stdin.resume();
process.argv = [process.execPath, launcher, ...args];
const entry = await import(pathToFileURL(launcher).href) as { runCli?: () => Promise<void> };
// The official launcher gates its executable path on import.meta.main.
if (entry.runCli) await entry.runCli();
