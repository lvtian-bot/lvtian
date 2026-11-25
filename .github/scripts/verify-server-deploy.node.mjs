import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { verifyServerDeploy } from './verify-server-deploy.mjs';

const mergeSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);

function response(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fixture(overrides = {}) {
    const routes = new Map([
        ['/branches/main', { commit: { sha: mergeSha } }],
        [`/commits/${mergeSha}/pulls?per_page=100&page=1`, [{ number: 77, merged_at: '2026-11-24T17:16:42Z',
            merge_commit_sha: mergeSha, base: { ref: 'main' }, head: { sha: headSha } }]],
        ['/pulls/77/files?per_page=100&page=1', [{ filename: 'server/src/server.ts' }]],
        [`/actions/workflows/pr-check.yml/runs?event=pull_request&head_sha=${headSha}&per_page=100`, {
            workflow_runs: [{ id: 123, head_sha: headSha, event: 'pull_request', pull_requests: [{ number: 77 }],
                status: 'completed', conclusion: 'success' }],
        }],
        ['/actions/runs/123/jobs?per_page=100&page=1', [
            { name: 'JS 检查（类型/Lint/测试）', status: 'completed', conclusion: 'success' },
            { name: '服务端检查（类型/测试）', status: 'completed', conclusion: 'success' },
        ]],
        [`/commits/${mergeSha}`, { sha: mergeSha }],
    ]);
    for (const [path, value] of Object.entries(overrides)) routes.set(path, value);
    const calls = [];
    const fetchImpl = async (url) => {
        const path = new URL(url).pathname.replace('/repos/lvtian-bot/lvtian', '') + new URL(url).search;
        calls.push(path);
        return routes.has(path) ? response(routes.get(path)) : response({ message: 'missing route' }, 404);
    };
    return { fetchImpl, calls };
}

const pushInput = {
    token: 'token', repository: 'lvtian-bot/lvtian', eventName: 'push', actor: 'any-contributor',
    githubSha: mergeSha, githubRef: 'refs/heads/main', event: { after: mergeSha },
};

test('merged PR with both checks deploys the exact merge SHA without inspecting author email', async () => {
    const { fetchImpl } = fixture();
    assert.deepEqual(await verifyServerDeploy(pushInput, fetchImpl), {
        deploySha: mergeSha, mode: 'merged-pr', pullNumber: 77, pullHeadSha: headSha, checkRunId: 123,
    });
});

test('direct main push without a merged PR is rejected', async () => {
    const { fetchImpl } = fixture({ [`/commits/${mergeSha}/pulls?per_page=100&page=1`]: [] });
    await assert.rejects(verifyServerDeploy(pushInput, fetchImpl), /必须且只能对应一个已合并/);
});

test('a successful workflow missing either required job is rejected', async () => {
    const { fetchImpl } = fixture({ '/actions/runs/123/jobs?per_page=100&page=1': [
        { name: '服务端检查（类型/测试）', status: 'completed', conclusion: 'success' },
    ] });
    await assert.rejects(verifyServerDeploy(pushInput, fetchImpl), /没有同时通过客户端与服务端检查/);
});

test('a successful check for the same head on another PR is rejected', async () => {
    const path = `/actions/workflows/pr-check.yml/runs?event=pull_request&head_sha=${headSha}&per_page=100`;
    const { fetchImpl } = fixture({ [path]: { workflow_runs: [{ id: 123, head_sha: headSha,
        event: 'pull_request', pull_requests: [{ number: 99 }], status: 'completed', conclusion: 'success' }] } });
    await assert.rejects(verifyServerDeploy(pushInput, fetchImpl), /没有同时通过客户端与服务端检查/);
});

test('CI and deployment gate changes never auto-deploy', async () => {
    const { fetchImpl } = fixture({ '/pulls/77/files?per_page=100&page=1': [
        { filename: 'server/src/server.ts' }, { filename: '.github/workflows/pr-check.yml' },
    ] });
    await assert.rejects(verifyServerDeploy(pushInput, fetchImpl), /禁止自动部署/);
});

test('push verification is bound to the event SHA even if main later advances', async () => {
    const { fetchImpl } = fixture({ '/branches/main': { commit: { sha: 'c'.repeat(40) } } });
    assert.equal((await verifyServerDeploy(pushInput, fetchImpl)).deploySha, mergeSha);
    await assert.rejects(verifyServerDeploy({ ...pushInput, event: { after: headSha } }, fetchImpl),
        /push.after 与 GITHUB_SHA 不一致/);
});

test('only lvtian-bot can manually deploy an explicit current main SHA', async () => {
    const { fetchImpl } = fixture();
    const input = { token: 'token', repository: 'lvtian-bot/lvtian', eventName: 'workflow_dispatch',
        actor: 'lvtian-bot', deploySha: mergeSha, githubRef: 'refs/heads/main', event: {} };
    assert.deepEqual(await verifyServerDeploy(input, fetchImpl), { deploySha: mergeSha, mode: 'manual-owner' });
    await assert.rejects(verifyServerDeploy({ ...input, actor: 'someone-else' }, fetchImpl), /仅允许 lvtian-bot/);
    await assert.rejects(verifyServerDeploy({ ...input, deploySha: headSha }, fetchImpl), /必须等于当前 main/);
    await assert.rejects(verifyServerDeploy({ ...input, githubRef: 'refs/heads/feature' }, fetchImpl), /必须从 main/);
});

test('the production workflow runs the verifier before secrets and deploys its exact output SHA', () => {
    const workflow = fs.readFileSync(new URL('../workflows/server-deploy.yml', import.meta.url), 'utf8');
    const verify = workflow.indexOf('node .github/scripts/verify-server-deploy.mjs');
    const sshKey = workflow.indexOf('SSH_KEY: ${{ secrets.SERVER_SSH_KEY }}');
    assert.ok(verify >= 0 && sshKey > verify);
    assert.match(workflow, /DEPLOY_SHA: \$\{\{ steps\.verify\.outputs\.deploy_sha \}\}/);
    assert.match(workflow, /git reset --hard "\$\{DEPLOY_SHA\}"/);
    assert.doesNotMatch(workflow, /git reset --hard origin\/main/);
});
