import { mkdtemp, mkdir, rm, rename, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { NativeTaskHost } from '../dist/nativeTaskHost.js';
import { NativeTaskClient } from '../dist/nativeTaskClient.js';
import { NativeTaskService } from '../dist/nativeTaskService.js';

test('real DSH host supports task create, optimistic update, restart and delete', async () => {
const root = await mkdtemp(path.join(os.tmpdir(), 'lvtian-dsh-compat-'));
const workspace = path.join(root,'workspace'); await mkdir(workspace);
const host = new NativeTaskHost({root, workspace, modelEnvironment: {HOME:root, XDG_CONFIG_HOME:path.join(root,'config'), XDG_CACHE_HOME:path.join(root,'cache'), XDG_DATA_HOME:path.join(root,'data')}});
let client;
try {
 let endpoint = await host.start(); client = await NativeTaskClient.connect({origin:endpoint.origin,bootToken:endpoint.token});
 const service = new NativeTaskService({workspace,metadataPath:path.join(root,'metadata.json'),clientFactory:async()=>client});
 const input={requestId:'probe-1',title:'probe',prompt:'reply with test result',timing:{kind:'at',at:'2099-01-01T00:00:00Z'}};
 const operation=await service.create(input); assert.equal(operation.status,'ready');
 let [task]=await service.catalog(); assert.equal(task.id,operation.taskId); assert.ok(task.updatedAt);
 const originalTaskId=task.id;
 const edit=await service.update(task.id,{expected:task,title:'changed'}); assert.equal(edit.title,'changed');
 const stale=await service.update(task.id,{expected:task,title:'wrong'}); assert.equal(stale.code,'schedule_conflict');
 const history=await service.history(task.id); assert.deepEqual(history.records,[]);
 await client.dispose(); client=undefined; await host.stop();
 const workspaceData=path.join(workspace,'.lvtian','native-tasks');
 await mkdir(path.join(root,'home'),{recursive:true});
 await rename(path.join(workspaceData,'storages'),path.join(root,'home','storages'));
 await rename(path.join(workspaceData,'sessions'),path.join(root,'home','sessions'));
 await writeFile(path.join(root,'managed-host.patch.yml'),'- id: session-log-deepseek\n  disabled: true\n- id: session-telemetry-otel\n  disabled: true\n');
 endpoint=await host.start(); client=await NativeTaskClient.connect({origin:endpoint.origin,bootToken:endpoint.token});
 [task]=await service.catalog(); assert.equal(task.title,'changed'); assert.equal(task.id,originalTaskId);
 await assert.rejects(access(path.join(root,'home','storages','schedule.json')));
 await access(path.join(workspaceData,'storages','schedule.json'));
 const deleted=await service.delete(task.id); assert.equal(deleted.deleted,true); assert.deepEqual(await service.catalog(),[]);
 await service.close(); console.log('real host: create, conflict, history, restart and delete passed');
} finally { await client?.dispose(); await host.stop(); await rm(root, { recursive: true, force: true }); }
});
