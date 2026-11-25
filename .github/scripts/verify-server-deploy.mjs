import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const REQUIRED_JOBS = [
    'JS 检查（类型/Lint/测试）',
    '服务端检查（类型/测试）',
];
const PR_CHECK_WORKFLOW_PATH = '.github/workflows/pr-check.yml';

function requireSha(value, label) {
    if (!/^[0-9a-f]{40}$/i.test(value ?? '')) {
        throw new Error(`${label} 必须是完整 40 位提交 SHA`);
    }
    return value.toLowerCase();
}

function apiClient({ token, repository, fetchImpl }) {
    const request = async (path) => {
        const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
            headers: {
                accept: 'application/vnd.github+json',
                authorization: `Bearer ${token}`,
                'x-github-api-version': '2022-11-28',
            },
        });
        if (!response.ok) {
            throw new Error(`GitHub API ${path} 返回 ${response.status}`);
        }
        return response.json();
    };
    const allPages = async (path) => {
        const rows = [];
        for (let page = 1; ; page += 1) {
            const separator = path.includes('?') ? '&' : '?';
            const batch = await request(`${path}${separator}per_page=100&page=${page}`);
            if (!Array.isArray(batch)) throw new Error(`GitHub API ${path} 未返回列表`);
            rows.push(...batch);
            if (batch.length < 100) return rows;
        }
    };
    return { request, allPages };
}

async function verifyManual({ actor, deploySha, githubRef, api }) {
    if (actor !== 'lvtian-bot') {
        throw new Error(`手动生产部署仅允许 lvtian-bot，当前为 ${actor || 'unknown'}`);
    }
    if (githubRef !== 'refs/heads/main') {
        throw new Error(`手动生产部署必须从 main 工作流运行，当前为 ${githubRef}`);
    }
    const sha = requireSha(deploySha, 'deploy_sha');
    const branch = await api.request('/branches/main');
    if (branch.commit?.sha !== sha) {
        throw new Error(`手动部署 SHA 必须等于当前 main：期望 ${branch.commit?.sha}，收到 ${sha}`);
    }
    await api.request(`/commits/${sha}`);
    return { deploySha: sha, mode: 'manual-owner' };
}

async function verifyPush({ githubSha, githubRef, repository, event, api }) {
    if (githubRef !== 'refs/heads/main') throw new Error(`自动部署仅接受 main，当前为 ${githubRef}`);
    const sha = requireSha(githubSha, 'GITHUB_SHA');
    if (event.after !== sha) throw new Error(`push.after 与 GITHUB_SHA 不一致：${event.after} != ${sha}`);
    if (event.repository?.full_name !== repository) throw new Error('push 事件仓库与 GITHUB_REPOSITORY 不一致');

    const pulls = await api.allPages(`/commits/${sha}/pulls`);
    const merged = pulls.filter((pull) => pull.merged_at && pull.merge_commit_sha === sha);
    if (merged.length !== 1 || !Number.isSafeInteger(merged[0]?.number)) {
        throw new Error(`提交 ${sha} 必须且只能对应一个已合并 PR，实际 ${merged.length}`);
    }
    const pull = await api.request(`/pulls/${merged[0].number}`);
    if (pull.number !== merged[0].number || pull.state !== 'closed' || !pull.merged_at
        || pull.merge_commit_sha !== sha || pull.base?.ref !== 'main'
        || pull.base?.repo?.full_name !== repository
        || pull.head?.repo?.full_name !== repository) {
        throw new Error(`提交 ${sha} 对应 PR 的分支或仓库来源不可信`);
    }
    const files = await api.allPages(`/pulls/${pull.number}/files`);
    if (!files.some((file) => file.filename.startsWith('server/'))) {
        throw new Error(`PR #${pull.number} 没有服务端改动，不应触发服务端部署`);
    }
    const protectedChange = files.find((file) => file.filename.startsWith('.github/'));
    if (protectedChange) {
        throw new Error(`PR #${pull.number} 修改了部署门禁文件 ${protectedChange.filename}，禁止自动部署；请由 lvtian-bot 审核后手动部署精确 SHA`);
    }

    const headSha = requireSha(pull.head?.sha, `PR #${pull.number} head SHA`);
    const workflow = await api.request('/actions/workflows/pr-check.yml');
    if (!Number.isSafeInteger(workflow.id) || workflow.path !== PR_CHECK_WORKFLOW_PATH
        || workflow.state !== 'active') {
        throw new Error('PR 检查工作流身份或状态不可信');
    }
    const runs = await api.request(`/actions/workflows/pr-check.yml/runs?event=pull_request&head_sha=${headSha}&per_page=100`);
    const pullCreated = Date.parse(pull.created_at);
    const pullMerged = Date.parse(pull.merged_at);
    const successfulRuns = (runs.workflow_runs ?? []).filter((run) => {
        const runCreated = Date.parse(run.created_at);
        const runUpdated = Date.parse(run.updated_at);
        const linkedPulls = run.pull_requests;
        // GitHub may clear workflow_run.pull_requests after a PR is merged. The
        // fallback still binds the run to this PR's exact same-repository branch
        // and lifetime; an absent/non-array association is never accepted.
        const linkedToPull = Array.isArray(linkedPulls)
            && (linkedPulls.length === 0
                || linkedPulls.some((runPull) => runPull.number === pull.number));
        return run.head_sha === headSha && run.event === 'pull_request'
            && run.workflow_id === workflow.id && run.path === PR_CHECK_WORKFLOW_PATH
            && run.head_branch === pull.head?.ref
            && run.head_repository?.full_name === repository
            && run.repository?.full_name === repository
            && Number.isFinite(pullCreated) && Number.isFinite(pullMerged)
            && Number.isFinite(runCreated) && Number.isFinite(runUpdated)
            && runCreated >= pullCreated && runUpdated <= pullMerged
            && Number.isSafeInteger(run.id) && Number.isSafeInteger(run.run_attempt)
            && run.run_attempt > 0 && linkedToPull
            && run.status === 'completed' && run.conclusion === 'success';
    });
    let verifiedRun;
    for (const run of successfulRuns) {
        const jobs = await api.allPages(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`);
        if (REQUIRED_JOBS.every((name) => {
            const matches = jobs.filter((job) => job.name === name);
            return matches.length === 1 && Number.isSafeInteger(matches[0].id)
                && matches[0].run_id === run.id
                && matches[0].run_attempt === run.run_attempt
                && matches[0].head_sha === headSha
                && matches[0].status === 'completed' && matches[0].conclusion === 'success';
        })) {
            verifiedRun = run;
            break;
        }
    }
    if (!verifiedRun) {
        throw new Error(`PR #${pull.number} 的 head ${headSha} 没有同时通过客户端与服务端检查`);
    }
    return { deploySha: sha, mode: 'merged-pr', pullNumber: pull.number,
        pullHeadSha: headSha, checkRunId: verifiedRun.id, checkRunAttempt: verifiedRun.run_attempt };
}

export async function verifyServerDeploy(input, fetchImpl = fetch) {
    const token = input.token;
    if (!token) throw new Error('缺少 GITHUB_TOKEN');
    if (!/^[^/]+\/[^/]+$/.test(input.repository ?? '')) throw new Error('GITHUB_REPOSITORY 无效');
    const api = apiClient({ token, repository: input.repository, fetchImpl });
    if (input.eventName === 'workflow_dispatch') {
        return verifyManual({ actor: input.actor, deploySha: input.deploySha,
            githubRef: input.githubRef, api });
    }
    if (input.eventName !== 'push') throw new Error(`不支持的部署事件 ${input.eventName}`);
    return verifyPush({ githubSha: input.githubSha, githubRef: input.githubRef, repository: input.repository,
        event: input.event, api });
}

async function main() {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const result = await verifyServerDeploy({
        token: process.env.GITHUB_TOKEN,
        repository: process.env.GITHUB_REPOSITORY,
        eventName: process.env.GITHUB_EVENT_NAME,
        actor: process.env.GITHUB_ACTOR,
        githubSha: process.env.GITHUB_SHA,
        githubRef: process.env.GITHUB_REF,
        deploySha: process.env.DEPLOY_SHA,
        event,
    });
    const lines = [
        `deploy_sha=${result.deploySha}`,
        `verification_mode=${result.mode}`,
        `pull_number=${result.pullNumber ?? ''}`,
        `check_run_id=${result.checkRunId ?? ''}`,
        `check_run_attempt=${result.checkRunAttempt ?? ''}`,
    ];
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
    console.log(`部署来源核验通过：${JSON.stringify(result)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(`部署来源核验失败：${error.message}`);
        process.exitCode = 1;
    });
}
