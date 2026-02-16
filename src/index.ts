/**
 * Auto-Tobe-Agent - Autonomous Code Fixer
 *
 * QA Agent가 발견한 GitHub Issues를 자동으로 수정하는 Agent
 *
 * Phase 1: 프로젝트 기반 구축 (타입, 설정, 디렉토리)
 * Phase 2: issue-parser, project-resolver 구현
 * Phase 3: fix-orchestrator, pr-creator 구현
 * Phase 4: verification-reporter 구현
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import type { ProjectsConfig, ApprovalPolicyConfig } from './types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadConfig<T>(relativePath: string): T {
  const fullPath = resolve(__dirname, '..', relativePath);
  const content = readFileSync(fullPath, 'utf-8');
  return JSON.parse(content) as T;
}

function main(): void {
  console.log('Auto-Tobe-Agent v0.1.0');
  console.log('='.repeat(40));

  const projects = loadConfig<ProjectsConfig>('configs/projects.json');
  console.log(`Projects config v${projects.version} loaded`);

  const enabledProjects = Object.entries(projects.projects)
    .filter(([, config]) => config.enabled)
    .map(([name]) => name);
  console.log(`Enabled projects: ${enabledProjects.join(', ')}`);

  const policy = loadConfig<ApprovalPolicyConfig>('configs/approval-policy.json');
  console.log(`Approval policy v${policy.version} loaded`);
  console.log(`Default reviewers: ${policy.default_reviewers.join(', ')}`);

  console.log('='.repeat(40));
  console.log('Phase 1: 프로젝트 기반 구축 완료');
}

main();
