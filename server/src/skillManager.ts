import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface SkillInfo {
    name: string;
    description: string;
}

export class SkillManager {
    private workspace: string;
    private candidateDirsOverride?: string[];

    constructor(workspace: string, candidateDirsOverride?: string[]) {
        this.workspace = workspace;
        this.candidateDirsOverride = candidateDirsOverride;
    }

    public listSkills(): SkillInfo[] {
        const candidateDirs: string[] = this.candidateDirsOverride ?? [
            path.join(this.workspace, '.agents', 'skills'),
            path.join(this.workspace, '.dsh', 'skills'),
            process.env.DSH_AGENTS_HOME
                ? path.join(process.env.DSH_AGENTS_HOME, 'skills')
                : path.join(os.homedir(), '.agents', 'skills'),
            process.env.DSH_HOME
                ? path.join(process.env.DSH_HOME, 'skills')
                : path.join(os.homedir(), '.dsh', 'skills')
        ];

        const skillMap = new Map<string, SkillInfo>();

        for (const dir of candidateDirs) {
            if (!fs.existsSync(dir)) continue;
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.name.startsWith('.')) continue;

                    let skillFilePath: string | null = null;
                    let fallbackName = entry.name;

                    if (entry.isDirectory()) {
                        const directSkillMd = path.join(dir, entry.name, 'SKILL.md');
                        const directSkillLower = path.join(dir, entry.name, 'skill.md');
                        if (fs.existsSync(directSkillMd)) {
                            skillFilePath = directSkillMd;
                        } else if (fs.existsSync(directSkillLower)) {
                            skillFilePath = directSkillLower;
                        }
                    } else if (entry.isFile() && entry.name.endsWith('.md')) {
                        skillFilePath = path.join(dir, entry.name);
                        fallbackName = entry.name.replace(/\.md$/, '');
                    }

                    if (skillFilePath) {
                        try {
                            const content = fs.readFileSync(skillFilePath, 'utf8');
                            const info = this.parseSkillMarkdown(content, fallbackName);
                            if (info && !skillMap.has(info.name)) {
                                skillMap.set(info.name, info);
                            }
                        } catch {
                            // ignore read errors
                        }
                    }
                }
            } catch {
                // ignore readdir errors
            }
        }

        return Array.from(skillMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    }

    private parseSkillMarkdown(content: string, fallbackName: string): SkillInfo | null {
        const fmMatch = content.match(/^---\s*[\r\n]+([\s\S]*?)[\r\n]+---/);
        if (!fmMatch) {
            return { name: fallbackName, description: '' };
        }
        const yaml = fmMatch[1];
        const nameMatch = yaml.match(/(?:^|\n)name:\s*["']?([^"'\r\n]+)["']?/);
        let desc = '';
        const descQuotedMatch = yaml.match(/(?:^|\n)description:\s*["']([\s\S]*?)["']\s*(?:\n|$)/);
        if (descQuotedMatch) {
            desc = descQuotedMatch[1].trim();
        } else {
            const descBareMatch = yaml.match(/(?:^|\n)description:\s*([^\r\n]+)/);
            if (descBareMatch) {
                desc = descBareMatch[1].trim();
            }
        }
        const name = (nameMatch ? nameMatch[1] : fallbackName).trim();
        if (!name) return null;
        if (desc === '>' || desc === '|') {
            desc = '';
        }
        return { name, description: desc };
    }
}
