import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateNativeTaskDirectory } from '../dist/nativeTaskDataMigration.js';

test('migrates a native DSH directory without leaving the old root active', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lvtian-data-migration-'));
  const source = path.join(root, 'private', 'sessions');
  const target = path.join(root, 'workspace', '.lvtian', 'native-tasks', 'sessions');
  const state = path.join(root, 'private', 'sessions-workspace-migration.json');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'one.jsonl'), 'session');
  await migrateNativeTaskDirectory(source, target, state);
  assert.equal(await readFile(path.join(target, 'one.jsonl'), 'utf8'), 'session');
  await assert.rejects(access(source));
  await assert.rejects(access(state));
});

test('refuses to merge independently populated old and workspace roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lvtian-data-conflict-'));
  const source = path.join(root, 'private', 'storages');
  const target = path.join(root, 'workspace', 'storages');
  const state = path.join(root, 'private', 'migration.json');
  await mkdir(source, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(path.join(source, 'schedule.json'), 'old');
  await writeFile(path.join(target, 'schedule.json'), 'new');
  await assert.rejects(migrateNativeTaskDirectory(source, target, state), /native_task_data_roots_conflict/);
  assert.equal(await readFile(path.join(source, 'schedule.json'), 'utf8'), 'old');
  assert.equal(await readFile(path.join(target, 'schedule.json'), 'utf8'), 'new');
});

test('finishes an interrupted cross-device commit without running both roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lvtian-data-recovery-'));
  const source = path.join(root, 'private', 'storages');
  const target = path.join(root, 'workspace', 'storages');
  const state = path.join(root, 'private', 'migration.json');
  await mkdir(source, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(path.join(source, 'schedule.json'), 'same');
  await writeFile(path.join(target, 'schedule.json'), 'same');
  const migrationId = '11111111-1111-4111-8111-111111111111';
  await writeFile(path.join(target, `.lvtian-native-task-migration-${migrationId}`), migrationId);
  await writeFile(state, `${JSON.stringify({ version: 1, source, target, migrationId, phase: 'copy-ready' })}\n`);
  await migrateNativeTaskDirectory(source, target, state);
  assert.equal(await readFile(path.join(target, 'schedule.json'), 'utf8'), 'same');
  await assert.rejects(access(source));
  await assert.rejects(access(state));
});

test('recovers a copying marker if the directory can later move atomically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lvtian-data-copying-'));
  const source = path.join(root, 'private', 'sessions');
  const target = path.join(root, 'workspace', 'sessions');
  const staging = `${target}.migration`;
  const state = path.join(root, 'private', 'migration.json');
  await mkdir(source, { recursive: true });
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(source, 'session.jsonl'), 'complete');
  await writeFile(path.join(staging, 'session.jsonl'), 'partial');
  const migrationId = '22222222-2222-4222-8222-222222222222';
  await writeFile(state, `${JSON.stringify({ version: 1, source, target, migrationId, phase: 'copying' })}\n`);
  await migrateNativeTaskDirectory(source, target, state);
  assert.equal(await readFile(path.join(target, 'session.jsonl'), 'utf8'), 'complete');
  await assert.rejects(access(source));
  await assert.rejects(access(staging));
  await assert.rejects(access(state));
});

test('does not delete the old root when an unrelated target lacks the commit marker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lvtian-data-marker-'));
  const source = path.join(root, 'private', 'storages');
  const target = path.join(root, 'workspace', 'storages');
  const state = path.join(root, 'private', 'migration.json');
  const migrationId = '33333333-3333-4333-8333-333333333333';
  await mkdir(source, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(path.join(source, 'schedule.json'), 'old');
  await writeFile(path.join(target, 'schedule.json'), 'unrelated');
  await writeFile(state, `${JSON.stringify({ version: 1, source, target, migrationId, phase: 'copy-ready' })}\n`);
  await assert.rejects(migrateNativeTaskDirectory(source, target, state), /native_task_data_migration_marker_missing/);
  assert.equal(await readFile(path.join(source, 'schedule.json'), 'utf8'), 'old');
  assert.equal(await readFile(path.join(target, 'schedule.json'), 'utf8'), 'unrelated');
});
