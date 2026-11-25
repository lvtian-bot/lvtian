import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

interface MigrationState {
    version: 1;
    source: string;
    target: string;
    migrationId: string;
    phase: 'copying' | 'copy-ready';
}

async function exists(target: string): Promise<boolean> {
    try { await fs.lstat(target); return true; }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}

async function readState(stateFile: string): Promise<MigrationState | undefined> {
    try {
        const value = JSON.parse(await fs.readFile(stateFile, 'utf8')) as Partial<MigrationState>;
        if (value.version !== 1 || (value.phase !== 'copying' && value.phase !== 'copy-ready')
            || typeof value.source !== 'string' || typeof value.target !== 'string'
            || typeof value.migrationId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.migrationId)) {
            throw new Error('native_task_data_migration_state_invalid');
        }
        return value as MigrationState;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        if (error instanceof SyntaxError) throw new Error('native_task_data_migration_state_invalid');
        throw error;
    }
}

function markerPath(directory: string, migrationId: string): string {
    return path.join(directory, `.lvtian-native-task-migration-${migrationId}`);
}

async function assertMarker(directory: string, migrationId: string): Promise<void> {
    try {
        if (await fs.readFile(markerPath(directory, migrationId), 'utf8') !== migrationId) {
            throw new Error('native_task_data_migration_marker_invalid');
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('native_task_data_migration_marker_missing');
        throw error;
    }
}

async function writeState(stateFile: string, state: MigrationState): Promise<void> {
    const temporary = `${stateFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await fs.rename(temporary, stateFile);
}

/**
 * Moves one DSH-owned directory without merging two independently writable roots.
 * The host storage lease must be held by the caller for the whole operation.
 */
export async function migrateNativeTaskDirectory(sourcePath: string, targetPath: string, statePath: string): Promise<void> {
    const source = path.resolve(sourcePath);
    const target = path.resolve(targetPath);
    const stateFile = path.resolve(statePath);
    const staging = `${target}.migration`;
    if (source === target || stateFile === source || stateFile === target || staging === source) {
        throw new Error('native_task_data_migration_paths_invalid');
    }

    const state = await readState(stateFile);
    if (state && (state.source !== source || state.target !== target)) {
        throw new Error('native_task_data_migration_state_conflict');
    }

    const sourceExists = await exists(source);
    const targetExists = await exists(target);
    if (sourceExists && targetExists) {
        if (state?.phase !== 'copy-ready') throw new Error('native_task_data_roots_conflict');
        await assertMarker(target, state.migrationId);
        await fs.rm(source, { recursive: true, force: false });
        await fs.unlink(markerPath(target, state.migrationId));
        await fs.unlink(stateFile);
        return;
    }
    if (!sourceExists) {
        if (state?.phase === 'copy-ready' && targetExists) {
            const marker = markerPath(target, state.migrationId);
            if (await exists(marker)) {
                await assertMarker(target, state.migrationId);
                await fs.unlink(marker);
            }
            await fs.unlink(stateFile);
        }
        else if (state) throw new Error('native_task_data_migration_state_conflict');
        if (!state && await exists(staging)) throw new Error('native_task_data_migration_staging_conflict');
        return;
    }

    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    if (state?.phase === 'copy-ready') {
        if (!await exists(staging)) throw new Error('native_task_data_migration_staging_missing');
        await assertMarker(staging, state.migrationId);
        await fs.rename(staging, target);
        await fs.rm(source, { recursive: true, force: false });
        await fs.unlink(markerPath(target, state.migrationId));
        await fs.unlink(stateFile);
        return;
    }
    if (!state && await exists(staging)) throw new Error('native_task_data_migration_staging_conflict');

    try {
        await fs.rename(source, target);
        if (state?.phase === 'copying') {
            await fs.rm(staging, { recursive: true, force: true });
            await fs.unlink(stateFile);
        }
        return;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    }

    if (state?.phase === 'copying') await fs.rm(staging, { recursive: true, force: true });
    const migrationId = state?.migrationId ?? randomUUID();
    await writeState(stateFile, { version: 1, source, target, migrationId, phase: 'copying' });
    await fs.cp(source, staging, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await fs.writeFile(markerPath(staging, migrationId), migrationId, { flag: 'wx', mode: 0o600 });
    await writeState(stateFile, { version: 1, source, target, migrationId, phase: 'copy-ready' });
    await fs.rename(staging, target);
    await fs.rm(source, { recursive: true, force: false });
    await fs.unlink(markerPath(target, migrationId));
    await fs.unlink(stateFile);
}

export interface NativeTaskDataMigrationPaths {
    storageSource: string;
    storageTarget: string;
    storageState: string;
    sessionsSource: string;
    sessionsTarget: string;
    sessionsState: string;
}

export async function migrateNativeTaskData(paths: NativeTaskDataMigrationPaths): Promise<void> {
    await migrateNativeTaskDirectory(paths.storageSource, paths.storageTarget, paths.storageState);
    await migrateNativeTaskDirectory(paths.sessionsSource, paths.sessionsTarget, paths.sessionsState);
}
