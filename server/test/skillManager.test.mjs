import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillManager } from '../dist/skillManager.js';

test('SkillManager 能够发现并解析包含 frontmatter 的 SKILL.md 技能目录', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-skills-test-'));
    try {
        const skillsDir = path.join(tmpDir, 'skills');
        fs.mkdirSync(skillsDir, { recursive: true });

        // 1. Quoted description directory skill
        const skill1Dir = path.join(skillsDir, 'test-tool-a');
        fs.mkdirSync(skill1Dir);
        fs.writeFileSync(
            path.join(skill1Dir, 'SKILL.md'),
            `---
name: "test-tool-a"
description: "这是一个测试工具 A，用于执行自动化测试。"
---

# Test Tool A
`
        );

        // 2. Unquoted description directory skill
        const skill2Dir = path.join(skillsDir, 'test-tool-b');
        fs.mkdirSync(skill2Dir);
        fs.writeFileSync(
            path.join(skill2Dir, 'SKILL.md'),
            `---
name: test-tool-b
description: 这是一个不带引号的测试工具 B 描述说明。
---

# Test Tool B
`
        );

        // 3. Flat markdown skill
        fs.writeFileSync(
            path.join(skillsDir, 'flat-skill.md'),
            `---
name: "flat-skill"
description: "平铺 Markdown 文件技能"
---
`
        );

        const manager = new SkillManager(tmpDir, [skillsDir]);
        const list = manager.listSkills();

        assert.strictEqual(list.length, 3);
        const names = list.map((s) => s.name);
        assert.deepStrictEqual(names, ['flat-skill', 'test-tool-a', 'test-tool-b']);

        const toolA = list.find((s) => s.name === 'test-tool-a');
        assert.ok(toolA);
        assert.strictEqual(toolA.description, '这是一个测试工具 A，用于执行自动化测试。');

        const toolB = list.find((s) => s.name === 'test-tool-b');
        assert.ok(toolB);
        assert.strictEqual(toolB.description, '这是一个不带引号的测试工具 B 描述说明。');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
