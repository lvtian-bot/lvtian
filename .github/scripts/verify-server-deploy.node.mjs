import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { verifyServerDeploy } from './verify-server-deploy.mjs';

const mergeSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const repository = 'lvtian-bot/lvtian';
const pullCreated = '2026-11-25T04:00:38Z';
const pullMerged = '2026-11-25T04:03:30Z';
const jobsPath = '/actions/runs/123/attempts/1/jobs?per_page=100';

function pull(overrides = {}) {
    return {
        number: 77, state: 'closed', created_at: pullCreated, merged_at: pullMerged,
        merge_commit_sha: mergeSha,
        base: { ref: 'main', repo: { full_name: repository } },
        head: { ref: 'chore/upgrade-dsh-rc5', sha: headSha, repo: { full_name: repository } },
        ...overrides,
    };
}

function run(overrides = {}) {
    return {
        id: 123, workflow_id: 456, path: '.github/workflows/pr-check.yml',
        head_sha: headSha, head_branch: 'chore/upgrade-dsh-rc5', event: 'pull_request',
        head_repository: { full_name: repository }, repository: { full_name: repository },
        run_attempt: 1, created_at: '2026-11-25T04:00:43Z', updated_at: '2026-11-25T04:02:28Z',
        pull_requests: [], status: 'completed', conclusion: 'success', ...overrides,
    };
}

function jobs(overrides = {}) {
    const defaults = { run_id: 123, run_attempt: 1, head_sha: headSha,
        status: 'completed', conclusion: 'success' };
    return [
        { id: 1001, name: 'JS 检查（类型/Lint/测试）', ...defaults, ...overrides },
        { id: 1002, name: '服务端检查（类型/测试）', ...defaults, ...overrides },
    ];
}

function jobsPage(rows = jobs(), totalCount = rows.length) {
    return { total_count: totalCount, jobs: rows };
}

function response(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fixture(overrides = {}) {
    const routes = new Map([
        ['/branches/main', { commit: { sha: mergeSha } }],
        [`/commits/${mergeSha}/pulls?per_page=100&page=1`, [pull()]],
        ['/pulls/77', pull()],
        ['/pulls/77/files?per_page=100&page=1', [{ filename: 'server/src/server.ts' }]],
        ['/actions/workflows/pr-check.yml', { id: 456, path: '.github/workflows/pr-check.yml', state: 'active' }],
        [`/actions/workflows/pr-check.yml/runs?event=pull_request&head_sha=${headSha}&per_page=100`, {
            workflow_runs: [run()],
        }],
        [`${jobsPath}&page=1`, jobsPage()],
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
    token: 'token', repository, eventName: 'push', actor: 'any-contributor',
    githubSha: mergeSha, githubRef: 'refs/heads/main',
    event: { after: mergeSha, repository: { full_name: repository } },
};

test('real merged-PR payload with an empty workflow pull_requests array remains deployable', async () => {
    const { fetchImpl } = fixture();
    assert.deepEqual(await verifyServerDeploy(pushInput, fetchImpl), {
        deploySha: mergeSha, mode: 'merged-pr', pullNumber: 77, pullHeadSha: headSha,
        checkRunId: 123, checkRunAttempt: 1,
    });
});

test('direct main push without a merged PR is rejected', async () => {
    const { fetchImpl } = fixture({ [`/commits/${mergeSha}/pulls?per_page=100&page=1`]: [] });
    await assert.rejects(verifyServerDeploy(pushInput, fetchImpl), /必须且只能对应一个已合并/);
});

test('a successful workflow missing either required job is rejected', async () => {
    const { fetchImpl } = fixture({ [`${jobsPath}&page=1`]: jobsPage(jobs().slice(1)) });
    await assert.rejects(verifyServerDeploy(pushInput, fetchImpl), /没有同时通过客户端与服务端检查/);
});

test('required jobs are verified across wrapped GitHub API pages', async () => {
    const [js, server] = jobs();
    const optional = Array.from({ length: 99 }, (_, index) => ({
        ...js, id: 2000 + index, name: `Optional check ${index}`,
    }));
    const { fetchImpl, calls } = fixture({
        [`${jobsPath}&page=1`]: jobsPage([js, ...optional], 101),
        [`${jobsPath}&page=2`]: jobsPage([server], 101),
    });
    assert.equal((await verifyServerDeploy(pushInput, fetchImpl)).checkRunId, 123);
    assert.ok(calls.includes(`${jobsPath}&page=2`));
});

test('malformed jobs responses fail closed', async () => {
    for (const invalid of [jobs(), { total_count: 2 }, { jobs: {} }]) {
        const { fetchImpl } = fixture({ [`${jobsPath}&page=1`]: invalid });
        await assert.rejects(verifyServerDeploy(pushInput, fetchImpl), /未返回列表/);
    }
});

test('a successful check for the same head on another PR is rejected', async () => {
    const path = `/actions/workflows/pr-check.yml/runs?event=pull_request&head_sha=${headSha}&per_page=100`;
    const { fetchImpl } = fixture({ [path]: { workflow_runs: [run({ pull_requests: [{ number: 99 }] })] } });
    await assert.rejects(verifyServerDeploy(pushInput, fetchImpl), /没有同时通过客户端与服务端检查/);
});

test('an empty association from another PR lifecycle with the same head is rejected', async () => {
    const path = `/actions/workflows/pr-check.yml/runs?event=pull_request&head_sha=${headSha}&per_page=100`;
    for (const invalid of [
        run({ created_at: '2026-11-25T03:50:00Z', updated_at: '2026-11-25T03:55:00Z' }),
        run({ updated_at: '2026-11-25T04:04:00Z' }),
        run({ pull_requests: undefined }),
    ]) {
        const { fetchImpl } = fixture({ [path]: { workflow_runs: [invalid] } });
        await assert.rejects(verifyServerDeploy(pushInput, fetchImpl), /没有同时通过客户端与服务端检查/);
    }
});

test('wrong PR base or source repository is rejected before checks are considered', async () => {
    for (const invalid of [
        pull({ base: { ref: 'release', repo: { full_name: repository } } }),
        pull({ base: { ref: 'main', repo: { full_name: 'other/repo' } } }),
        pull({ head: { ref: 'chore/upgrade-dsh-rc5', sha: headSha,
            repo: { full_name: 'untrusted/fork' } } }),
    ]) {
        const { fetchImpl } = fixture({ '/pulls/77': invalid });
        await assert.rejects(verifyServerDeploy(pushInput, fetchImpl), /分支或仓库来源不可信/);
    }
});

test('a same-SHA run from another repository or branch is rejected', async () => {
    const path = `/actions/workflows/pr-check.yml/runs?event=pull_request&head_sha=${headSha}&per_page=100`;
    for (const invalid of [
        run({ head_repository: { full_name: 'untrusted/fork' } }),
        run({ repository: { full_name: 'other/repo' } }),
        run({ head_branch: 'other-branch' }),
    ]) {
        const { fetchImpl } = fixture({ [path]: { workflow_runs: [invalid] } });
        await assert.rejects(verifyServerDeploy(pushInput, fetchImpl), /没有同时通过客户端与服务端检查/);
    }
});

test('inactive or substituted workflow metadata is rejected', async () => {
    for (const invalid of [
        { id: 456, path: '.github/workflows/fake.yml', state: 'active' },
        { id: 456, path: '.github/workflows/pr-check.yml', state: 'disabled_manually' },
    ]) {
        const { fetchImpl } = fixture({ '/actions/workflows/pr-check.yml': invalid });
        await assert.rejects(verifyServerDeploy(pushInput, fetchImpl), /工作流身份或状态不可信/);
    }
});

test('a fake workflow identity or attempt cannot borrow successful job names', async () => {
    const path = `/actions/workflows/pr-check.yml/runs?event=pull_request&head_sha=${headSha}&per_page=100`;
    for (const invalid of [
        run({ workflow_id: 999 }),
        run({ path: '.github/workflows/fake.yml' }),
    ]) {
        const { fetchImpl } = fixture({ [path]: { workflow_runs: [invalid] } });
        await assert.rejects(verifyServerDeploy(pushInput, fetchImpl), /没有同时通过客户端与服务端检查/);
    }
    const { fetchImpl } = fixture({
        [path]: { workflow_runs: [run({ run_attempt: 2 })] },
        '/actions/runs/123/attempts/2/jobs?per_page=100&page=1': jobsPage(),
    });
    await assert.rejects(verifyServerDeploy(pushInput, fetchImpl), /没有同时通过客户端与服务端检查/);
});

test('failed or duplicate same-name jobs are rejected for the exact run attempt', async () => {
    const jobPath = `${jobsPath}&page=1`;
    const failed = jobs().map(job => job.name === '服务端检查（类型/测试）'
        ? { ...job, conclusion: 'failure' } : job);
    const duplicate = [...jobs(), { ...jobs()[0], conclusion: 'failure' }];
    for (const invalid of [failed, duplicate]) {
        const { fetchImpl } = fixture({ [jobPath]: jobsPage(invalid) });
        await assert.rejects(verifyServerDeploy(pushInput, fetchImpl), /没有同时通过客户端与服务端检查/);
    }
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
    await assert.rejects(verifyServerDeploy({ ...pushInput,
        event: { after: mergeSha, repository: { full_name: 'other/repo' } } }, fetchImpl),
        /push 事件仓库与 GITHUB_REPOSITORY 不一致/);
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
