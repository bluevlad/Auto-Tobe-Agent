import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import type {
  ParsedIssue,
  ResolvedProject,
  FixResult,
  ModifiedFile,
  VerificationResult,
  ApprovalPolicyConfig,
  PriorityPolicy,
} from './types/index.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let cachedPolicy: ApprovalPolicyConfig | null = null;

/**
 * 승인 정책을 로드합니다 (캐시 활용).
 */
function loadApprovalPolicy(): ApprovalPolicyConfig {
  if (cachedPolicy) return cachedPolicy;
  const configPath = resolve(__dirname, '..', 'configs', 'approval-policy.json');
  const content = readFileSync(configPath, 'utf-8');
  cachedPolicy = JSON.parse(content) as ApprovalPolicyConfig;
  return cachedPolicy;
}

/**
 * 이슈 제목에서 브랜치용 slug을 생성합니다.
 */
function toBranchSlug(title: string): string {
  return title
    .replace(/^\[P\d\]\[\w+\]\s*/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 40)
    .replace(/-$/, '');
}

/**
 * 이슈 제목/카테고리에서 커밋 scope를 추출합니다.
 * COMMIT_CONVENTION 표준: fix(scope): subject
 */
function extractCommitScope(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes('security') || lower.includes('보안') || lower.includes('인증')) return 'security';
  if (lower.includes('auth') || lower.includes('jwt') || lower.includes('cors')) return 'auth';
  if (lower.includes('performance') || lower.includes('n+1') || lower.includes('성능')) return 'perf';
  if (lower.includes('docker') || lower.includes('deploy') || lower.includes('배포')) return 'ops';
  if (lower.includes('frontend') || lower.includes('프론트') || lower.includes('ui')) return 'ui';
  if (lower.includes('test') || lower.includes('테스트')) return 'test';
  if (lower.includes('api') || lower.includes('endpoint')) return 'api';
  if (lower.includes('db') || lower.includes('query') || lower.includes('sql')) return 'db';
  return 'core';
}

/**
 * Claude Code CLI 호출용 프롬프트를 구성합니다.
 */
function buildFixPrompt(issue: ParsedIssue, project: ResolvedProject): string {
  const lines: string[] = [];

  lines.push(`# GitHub Issue #${issue.number} 수정`);
  lines.push('');
  lines.push(`**제목**: ${issue.title}`);
  lines.push(`**우선순위**: ${issue.priority}`);
  lines.push(`**카테고리**: ${issue.category}`);
  lines.push('');

  if (issue.parsedContent.problem) {
    lines.push('## 문제');
    lines.push(issue.parsedContent.problem);
    lines.push('');
  }

  if (issue.parsedContent.recommendation) {
    lines.push('## 권장 수정');
    lines.push(issue.parsedContent.recommendation);
    lines.push('');
  }

  if (issue.parsedContent.affectedFiles?.length) {
    lines.push('## 영향 받는 파일');
    for (const f of issue.parsedContent.affectedFiles) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }

  if (issue.parsedContent.codeSnippets?.length) {
    lines.push('## 참고 코드 스니펫');
    for (const snippet of issue.parsedContent.codeSnippets) {
      lines.push('```');
      lines.push(snippet);
      lines.push('```');
      lines.push('');
    }
  }

  lines.push('## 수정 규칙');
  lines.push('- 기존 코드 스타일을 유지하세요');
  lines.push('- 필요한 최소한의 변경만 수행하세요');
  lines.push('- 새로운 의존성 추가를 최소화하세요');
  lines.push('- 수정 후 빌드와 테스트가 통과해야 합니다');
  lines.push(`- 기술 스택: ${project.config.tech_stack.backend}, ${project.config.tech_stack.frontend}, ${project.config.tech_stack.database}`);
  lines.push('');
  lines.push('수정이 완료되면 변경사항을 커밋하지 마세요. 파일 수정만 해주세요.');

  return lines.join('\n');
}

/**
 * fix 브랜치를 생성합니다.
 */
async function createFixBranch(
  branchName: string,
  mainBranch: string,
  cwd: string,
): Promise<void> {
  await execAsync(`git checkout ${mainBranch}`, { cwd });
  try {
    await execAsync(`git pull origin ${mainBranch}`, { cwd });
  } catch {
    // remote가 없거나 오프라인인 경우 무시
  }
  await execAsync(`git checkout -b ${branchName}`, { cwd });
}

/**
 * Claude Code CLI를 호출하여 코드를 수정합니다.
 * spawn으로 프롬프트를 stdin에 전달하여 인자 길이 제한을 회피합니다.
 */
function invokeClaudeCode(
  prompt: string,
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p'], {
      cwd,
      shell: true,
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.local/bin:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
      },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Claude Code CLI timed out after ${timeoutMs}ms`));
      } else if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(`Claude Code CLI exited with code ${code}: ${stderr || stdout}`),
        );
      }
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`Claude Code CLI spawn error: ${err.message}`));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * 수정된 파일 목록을 감지합니다.
 */
async function detectModifiedFiles(
  cwd: string,
  baseBranch: string,
): Promise<ModifiedFile[]> {
  try {
    // 커밋된 변경사항 (baseBranch 대비)
    const { stdout: committed } = await execAsync(
      `git diff --numstat ${baseBranch}...HEAD`,
      { cwd },
    );

    if (committed.trim()) {
      return parseNumstat(committed);
    }

    // 커밋 전 변경사항 (staged + unstaged)
    const { stdout: unstaged } = await execAsync('git diff --numstat', { cwd });
    const { stdout: staged } = await execAsync('git diff --cached --numstat', { cwd });
    const combined = (unstaged + staged).trim();

    if (combined) {
      return parseNumstat(combined);
    }

    return [];
  } catch {
    return [];
  }
}

/**
 * git diff --numstat 출력을 파싱합니다.
 */
function parseNumstat(output: string): ModifiedFile[] {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      const added = parseInt(parts[0], 10) || 0;
      const deleted = parseInt(parts[1], 10) || 0;
      const path = parts[2] || '';

      let changeType: ModifiedFile['changeType'] = 'modified';
      if (deleted === 0 && added > 0) changeType = 'added';
      if (added === 0 && deleted > 0) changeType = 'deleted';

      return { path, changeType, linesAdded: added, linesDeleted: deleted };
    });
}

/**
 * Windows 호환을 위한 명령어 변환.
 */
function adaptCommandForPlatform(command: string): string {
  if (process.platform === 'win32') {
    return command.replace(/^\.\/gradlew\b/, 'gradlew.bat');
  }
  return command;
}

/**
 * 빌드/테스트 검증을 실행합니다.
 */
async function runVerification(
  type: VerificationResult['type'],
  command: string,
  cwd: string,
): Promise<VerificationResult> {
  const startTime = Date.now();
  const adapted = adaptCommandForPlatform(command);

  try {
    const { stdout } = await execAsync(adapted, {
      cwd,
      timeout: 300_000, // 5분
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      type,
      passed: true,
      command: adapted,
      output: stdout.substring(0, 5000),
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      type,
      passed: false,
      command: adapted,
      output: err.stdout?.substring(0, 5000),
      error: (err.stderr || err.message || '').substring(0, 5000),
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * 변경사항을 커밋합니다.
 * 이미 커밋되어 있으면 기존 HEAD 해시를 반환합니다.
 */
async function commitChanges(
  issueNumber: number,
  title: string,
  cwd: string,
): Promise<string | undefined> {
  const { stdout: status } = await execAsync('git status --porcelain', { cwd });

  if (!status.trim()) {
    // 이미 커밋 완료 또는 변경 없음 → HEAD 해시 반환
    try {
      const { stdout: hash } = await execAsync('git rev-parse HEAD', { cwd });
      return hash.trim();
    } catch {
      return undefined;
    }
  }

  await execAsync('git add -A', { cwd });

  const slug = toBranchSlug(title);
  // 커밋 메시지: COMMIT_CONVENTION 표준 준수
  // type(scope): subject + fixes #N in footer
  const scope = extractCommitScope(title);
  const subject = slug.replace(/-/g, ' ');
  const commitMsg = `fix(${scope}): ${subject}

Auto-fixed by Auto-Tobe-Agent

fixes #${issueNumber}

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`;

  const escaped = commitMsg.replace(/"/g, '\\"');
  await execAsync(`git commit -m "${escaped}"`, { cwd });

  const { stdout: hash } = await execAsync('git rev-parse HEAD', { cwd });
  return hash.trim();
}

/**
 * 실패 시 브랜치를 정리합니다.
 */
async function cleanupBranch(
  branchName: string,
  mainBranch: string,
  cwd: string,
): Promise<void> {
  try {
    await execAsync('git reset --hard', { cwd });
    await execAsync(`git checkout ${mainBranch}`, { cwd });
    await execAsync(`git branch -D ${branchName}`, { cwd });
  } catch {
    // 정리 실패는 무시
  }
}

/**
 * 초기 FixResult를 생성합니다.
 */
function createInitialResult(
  issue: ParsedIssue,
  project: ResolvedProject,
  policy: PriorityPolicy,
): FixResult {
  return {
    issueNumber: issue.number,
    project: project.name,
    repo: issue.repo,
    priority: issue.priority,
    category: issue.category,
    strategy: policy.fix_strategy,
    status: 'pending',
    modifiedFiles: [],
    verifications: [],
    startedAt: new Date().toISOString(),
    retryCount: 0,
    sourceRunId: issue.sourceRunId,
  };
}

/**
 * 이슈 수정 워크플로우를 오케스트레이션합니다.
 *
 * 흐름: 정책 확인 → 브랜치 생성 → Claude Code CLI 호출 →
 *       빌드 검증 → 테스트 검증 → 커밋 → 결과 반환
 */
export async function orchestrateFix(
  issue: ParsedIssue,
  project: ResolvedProject,
): Promise<FixResult> {
  const policyConfig = loadApprovalPolicy();
  const policy = policyConfig.policies[issue.priority];
  const result = createInitialResult(issue, project, policy);
  const cwd = project.config.local_path;
  const mainBranch = project.config.main_branch;

  console.log(`\n[fix] #${issue.number} ${issue.title}`);
  console.log(`  Priority: ${issue.priority}, Strategy: ${policy.fix_strategy}`);

  // 1. 자동 수정 가능 여부 확인
  if (!issue.isAutoFixable) {
    console.log('  SKIP: 자동 수정 불가 (manual fix required)');
    result.status = 'skipped';
    result.error = 'Issue marked as not auto-fixable';
    result.completedAt = new Date().toISOString();
    return result;
  }

  if (!policy.auto_fix) {
    console.log('  SKIP: 정책상 자동 수정 비활성화');
    result.status = 'skipped';
    result.error = `Auto-fix disabled for ${issue.priority}`;
    result.completedAt = new Date().toISOString();
    return result;
  }

  if (!project.localPathExists) {
    console.log(`  FAIL: 로컬 경로 없음 (${cwd})`);
    result.status = 'failed';
    result.error = `Local path not found: ${cwd}`;
    result.completedAt = new Date().toISOString();
    return result;
  }

  // 2. 브랜치 생성
  const branchName = `${policyConfig.global_rules.branch_prefix}/${issue.number}-${toBranchSlug(issue.title)}`;
  result.branchName = branchName;
  result.status = 'in_progress';

  console.log(`  Branch: ${branchName}`);

  const timeoutMs = policy.timeout_minutes * 60 * 1000;
  const maxRetry = policy.max_retry;

  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    result.retryCount = attempt;

    if (attempt > 0) {
      console.log(`  Retry ${attempt}/${maxRetry}...`);
    }

    try {
      // 이전 시도 정리 (재시도 시)
      if (attempt > 0) {
        await cleanupBranch(branchName, mainBranch, cwd);
      }

      // 브랜치 생성
      await createFixBranch(branchName, mainBranch, cwd);

      // 3. Claude Code CLI 호출
      console.log('  Invoking Claude Code CLI...');
      const prompt = buildFixPrompt(issue, project);
      const claudeOutput = await invokeClaudeCode(prompt, cwd, timeoutMs);
      console.log(`  Claude response: ${claudeOutput.substring(0, 200)}...`);

      result.status = 'fix_applied';

      // 4. 수정된 파일 감지
      const modifiedFiles = await detectModifiedFiles(cwd, mainBranch);
      result.modifiedFiles = modifiedFiles;

      if (modifiedFiles.length === 0) {
        console.log('  WARN: 수정된 파일 없음');
        result.status = 'failed';
        result.error = 'No files were modified by Claude Code CLI';
        continue; // 재시도
      }

      console.log(`  Modified files: ${modifiedFiles.length}`);
      for (const f of modifiedFiles) {
        console.log(`    ${f.changeType} ${f.path} (+${f.linesAdded}/-${f.linesDeleted})`);
      }

      // 5. 빌드 검증
      if (policyConfig.global_rules.require_clean_build) {
        console.log(`  Running build: ${project.config.commands.build_backend}`);
        const buildResult = await runVerification(
          'build',
          project.config.commands.build_backend,
          cwd,
        );
        result.verifications.push(buildResult);

        if (!buildResult.passed) {
          console.log(`  BUILD FAILED (${buildResult.durationMs}ms)`);
          result.status = 'failed';
          result.error = `Build failed: ${buildResult.error?.substring(0, 200)}`;
          continue; // 재시도
        }

        console.log(`  BUILD PASSED (${buildResult.durationMs}ms)`);
        result.status = 'build_verified';
      }

      // 6. 테스트 검증
      if (policyConfig.global_rules.require_existing_tests_pass) {
        console.log(`  Running tests: ${project.config.commands.test_backend}`);
        const testResult = await runVerification(
          'test',
          project.config.commands.test_backend,
          cwd,
        );
        result.verifications.push(testResult);

        if (!testResult.passed) {
          console.log(`  TEST FAILED (${testResult.durationMs}ms)`);
          result.status = 'failed';
          result.error = `Tests failed: ${testResult.error?.substring(0, 200)}`;
          continue; // 재시도
        }

        console.log(`  TEST PASSED (${testResult.durationMs}ms)`);
        result.status = 'test_verified';
      }

      // 7. 커밋
      const commitHash = await commitChanges(issue.number, issue.title, cwd);
      result.commitHash = commitHash;

      console.log(`  Commit: ${commitHash?.substring(0, 8)}`);
      console.log(`  Status: ${result.status}`);

      result.completedAt = new Date().toISOString();
      result.durationMs = Date.now() - new Date(result.startedAt).getTime();

      return result; // 성공
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.log(`  ERROR: ${errMsg.substring(0, 200)}`);
      result.error = errMsg;
      result.status = 'failed';
    }
  }

  // 모든 재시도 실패
  console.log(`  FAILED after ${maxRetry + 1} attempts`);
  await cleanupBranch(branchName, mainBranch, cwd);

  result.completedAt = new Date().toISOString();
  result.durationMs = Date.now() - new Date(result.startedAt).getTime();

  return result;
}

/**
 * 여러 이슈를 우선순위 순서대로 수정합니다.
 * global_rules.max_concurrent_fixes에 따라 동시 수정 수를 제한합니다.
 */
export async function orchestrateBatchFix(
  issues: ParsedIssue[],
  project: ResolvedProject,
): Promise<FixResult[]> {
  const results: FixResult[] = [];

  console.log(`\n[batch] ${issues.length}건 수정 시작 (project: ${project.name})`);

  // 현재는 순차 처리 (max_concurrent_fixes: 1)
  for (const issue of issues) {
    const result = await orchestrateFix(issue, project);
    results.push(result);

    // 실패한 이슈가 있어도 다음 이슈 계속 처리
    if (result.status === 'failed') {
      console.log(`  [batch] #${issue.number} failed, continuing...`);
    }
  }

  console.log(`\n[batch] Complete: ${results.filter((r) => r.status !== 'failed' && r.status !== 'skipped').length}/${issues.length} succeeded`);

  return results;
}

// export for testing
export { buildFixPrompt, toBranchSlug, loadApprovalPolicy };
