/**
 * Auto-Tobe-Agent - Autonomous Code Fixer
 *
 * QA Agent가 발견한 GitHub Issues를 자동으로 수정하는 Agent
 *
 * 사용법:
 *   npm start                          # 설정 로드 및 상태 표시
 *   npm start -- scan <project>        # 이슈 스캔 및 파싱
 *   npm start -- resolve <project>     # 프로젝트 상태 확인
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import type { ProjectsConfig, ApprovalPolicyConfig, Priority } from './types/index.js';
import { fetchOpenIssueNumbers, parseIssue, isParsedIssue, sortByPriority } from './issue-parser.js';
import { resolveProject, resolveAllProjects } from './project-resolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadConfig<T>(relativePath: string): T {
  const fullPath = resolve(__dirname, '..', relativePath);
  const content = readFileSync(fullPath, 'utf-8');
  return JSON.parse(content) as T;
}

/**
 * 기본 모드: 설정 로드 및 상태 표시
 */
function showStatus(): void {
  console.log('Auto-Tobe-Agent v0.2.0');
  console.log('='.repeat(50));

  const projects = loadConfig<ProjectsConfig>('configs/projects.json');
  console.log(`Projects config v${projects.version} loaded`);

  const enabledProjects = Object.entries(projects.projects)
    .filter(([, config]) => config.enabled)
    .map(([name]) => name);
  console.log(`Enabled projects: ${enabledProjects.join(', ')}`);

  const policy = loadConfig<ApprovalPolicyConfig>('configs/approval-policy.json');
  console.log(`Approval policy v${policy.version} loaded`);
  console.log(`Default reviewers: ${policy.default_reviewers.join(', ')}`);

  console.log('='.repeat(50));
  console.log('\nCommands:');
  console.log('  npm start -- scan <project>     이슈 스캔');
  console.log('  npm start -- resolve <project>  프로젝트 상태');
}

/**
 * scan 모드: 프로젝트의 Open Issues를 파싱합니다.
 */
async function scanIssues(projectName: string): Promise<void> {
  console.log(`\n[scan] ${projectName} 이슈 스캔 시작...`);
  console.log('='.repeat(50));

  // 1. 프로젝트 해석
  const project = await resolveProject(projectName);
  console.log(`[resolve] ${project.name}: ${project.config.repo}`);
  console.log(`  Local: ${project.config.local_path} (${project.localPathExists ? 'exists' : 'NOT FOUND'})`);
  if (project.gitStatus) {
    console.log(`  Branch: ${project.gitStatus.currentBranch}`);
    console.log(`  Clean: ${project.gitStatus.isClean}`);
    if (project.gitStatus.behindRemote > 0) console.log(`  Behind: ${project.gitStatus.behindRemote}`);
    if (project.gitStatus.aheadRemote > 0) console.log(`  Ahead: ${project.gitStatus.aheadRemote}`);
  }

  // 2. Open Issues 목록 가져오기
  console.log(`\n[fetch] Fetching open issues from ${project.config.repo}...`);
  const issueList = await fetchOpenIssueNumbers(project.config.repo);
  console.log(`  Found ${issueList.length} open issues`);

  if (issueList.length === 0) {
    console.log('\n  No open issues to process.');
    return;
  }

  // 3. 각 이슈 파싱
  console.log(`\n[parse] Parsing ${issueList.length} issues...`);
  const parsed = [];
  const errors = [];

  for (const item of issueList) {
    const result = await parseIssue(item.number, project.config.repo);
    if (isParsedIssue(result)) {
      parsed.push(result);
    } else {
      errors.push(result);
    }
  }

  // 4. 우선순위별 정렬 및 출력
  const sorted = sortByPriority(parsed);

  console.log('\n' + '='.repeat(50));
  console.log(`SCAN RESULTS: ${project.name}`);
  console.log('='.repeat(50));

  const priorityGroups: Record<Priority, typeof sorted> = { P0: [], P1: [], P2: [], P3: [] };
  for (const issue of sorted) {
    priorityGroups[issue.priority].push(issue);
  }

  for (const [priority, issues] of Object.entries(priorityGroups)) {
    if (issues.length === 0) continue;
    console.log(`\n${priority} (${issues.length}건):`);
    for (const issue of issues) {
      const fixable = issue.isAutoFixable ? 'auto-fix' : 'manual';
      const files = issue.parsedContent.affectedFiles?.length ?? 0;
      console.log(`  #${issue.number} [${issue.category}] ${issue.title}`);
      console.log(`         fixable: ${fixable}, files: ${files}`);
    }
  }

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}건):`);
    for (const err of errors) {
      console.log(`  #${err.issueNumber}: ${err.error}`);
    }
  }

  console.log('\n' + '-'.repeat(50));
  console.log(`Total: ${parsed.length} parsed, ${errors.length} errors`);
  console.log(`Auto-fixable: ${parsed.filter((p) => p.isAutoFixable).length}`);
  console.log(`Manual: ${parsed.filter((p) => !p.isAutoFixable).length}`);
}

/**
 * resolve 모드: 프로젝트 상태를 확인합니다.
 */
async function resolveProjectCommand(projectName?: string): Promise<void> {
  if (projectName) {
    const project = await resolveProject(projectName);
    console.log(`\n[resolve] ${project.name}`);
    console.log(`  Repo: ${project.config.repo}`);
    console.log(`  Path: ${project.config.local_path}`);
    console.log(`  Exists: ${project.localPathExists}`);
    console.log(`  Tech: ${project.config.tech_stack.backend} + ${project.config.tech_stack.frontend}`);
    console.log(`  DB: ${project.config.tech_stack.database}`);
    console.log(`  Build: ${project.config.commands.build_backend}`);
    console.log(`  Test: ${project.config.commands.test_backend}`);
    if (project.gitStatus) {
      console.log(`  Branch: ${project.gitStatus.currentBranch}`);
      console.log(`  Clean: ${project.gitStatus.isClean}`);
      console.log(`  Behind: ${project.gitStatus.behindRemote}, Ahead: ${project.gitStatus.aheadRemote}`);
    }
  } else {
    const projects = await resolveAllProjects();
    console.log(`\n[resolve] ${projects.length} enabled projects:`);
    for (const p of projects) {
      const status = p.localPathExists ? (p.gitStatus?.isClean ? 'clean' : 'dirty') : 'NOT FOUND';
      console.log(`  ${p.name}: ${p.config.repo} [${status}]`);
    }
  }
}

/**
 * 메인 엔트리포인트
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const target = args[1];

  try {
    switch (command) {
      case 'scan':
        if (!target) {
          console.error('Usage: npm start -- scan <project>');
          process.exit(1);
        }
        await scanIssues(target);
        break;

      case 'resolve':
        await resolveProjectCommand(target);
        break;

      default:
        showStatus();
        break;
    }
  } catch (error) {
    console.error('\nError:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
