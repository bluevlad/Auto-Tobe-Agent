import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import type {
  ParsedIssue,
  ResolvedProject,
  FixResult,
  ModifiedFile,
  VerificationResult,
  ConflictCheckResult,
  FileConflictInfo,
  ApprovalPolicyConfig,
  PriorityPolicy,
} from './types/index.js';
import { extractDeduplicationKey } from './issue-parser.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Java 프로젝트 빌드를 위한 JAVA_HOME 자동 감지.
 * 환경변수에 없으면 Homebrew OpenJDK 경로를 탐색합니다.
 */
function ensureJavaEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  if (!env.JAVA_HOME) {
    const brewJdk = '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home';
    if (existsSync(brewJdk)) {
      env.JAVA_HOME = brewJdk;
      env.PATH = `${brewJdk}/bin:${env.PATH ?? ''}`;
    }
  }
  return env;
}

/**
 * Claude Code CLI 바이너리 경로를 OS에 따라 결정합니다.
 *
 * 탐색 순서:
 * 1. 환경변수 CLAUDE_CLI_PATH (명시적 오버라이드)
 * 2. $HOME/.local/bin/claude (macOS/Linux 기본)
 * 3. %APPDATA%\npm\claude.cmd (Windows npm global)
 * 4. PATH에서 탐색 (which/where)
 */
function resolveClaudeCliPath(): string {
  // 1. 환경변수 오버라이드
  if (process.env.CLAUDE_CLI_PATH && existsSync(process.env.CLAUDE_CLI_PATH)) {
    return process.env.CLAUDE_CLI_PATH;
  }

  // 2. OS별 기본 경로
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';

  if (process.platform === 'win32') {
    const candidates = [
      resolve(home, '.local', 'bin', 'claude.exe'),
      resolve(process.env.APPDATA ?? '', 'npm', 'claude.cmd'),
      resolve(home, '.local', 'bin', 'claude'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  } else {
    const unixPath = resolve(home, '.local', 'bin', 'claude');
    if (existsSync(unixPath)) return unixPath;
  }

  // 3. fallback: PATH에 있다고 가정
  return 'claude';
}

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

/** Claude CLI 에러 타입 */
type FixErrorType = 'auth_error' | 'path_error' | 'timeout' | 'unknown';

/** Claude CLI 에러를 분류합니다. */
function classifyError(errorMessage: string): FixErrorType {
  if (/401|authentication_error|unauthorized|api.key/i.test(errorMessage)) {
    return 'auth_error';
  }
  if (/no such file|not found|ENOENT|command not found/i.test(errorMessage)) {
    return 'path_error';
  }
  if (/timed?\s*out|timeout/i.test(errorMessage)) {
    return 'timeout';
  }
  return 'unknown';
}

/** Pre-flight 검증 결과 */
interface PreflightResult {
  ok: boolean;
  errors: string[];
}

/**
 * 수정 실행 전 환경을 사전 검증합니다.
 */
export async function preflightCheck(project: ResolvedProject): Promise<PreflightResult> {
  const errors: string[] = [];

  // 1. Claude CLI 바이너리 존재 + OAuth 인증 상태 확인
  const claudePath = resolveClaudeCliPath();
  if (claudePath === 'claude' || !existsSync(claudePath)) {
    errors.push(`Claude CLI 바이너리를 찾을 수 없습니다. CLAUDE_CLI_PATH 환경변수를 설정하거나 claude를 설치하세요.`);
  } else {
    try {
      await execAsync(`"${claudePath}" --version`, { timeout: 10_000 });
    } catch {
      errors.push('Claude CLI 실행 불가. OAuth 로그인 상태를 확인하세요 (claude login).');
    }
  }

  // 3. 프로젝트 로컬 경로
  const cwd = project.config.local_path;
  if (!project.localPathExists) {
    errors.push(`프로젝트 로컬 경로가 존재하지 않습니다: ${cwd}`);
  }

  // 4. Java Runtime 확인 (Gradle 프로젝트)
  if (project.config.tech_stack.build_tool === 'gradle' || project.config.tech_stack.build_tool === 'maven') {
    try {
      await execAsync('java --version', { timeout: 5_000 });
    } catch {
      errors.push('Java Runtime이 설치되어 있지 않습니다. brew install openjdk@21 후 JAVA_HOME을 설정하세요.');
    }
  }

  // 5. 빌드 도구 존재 확인 (cwd 반영)
  if (project.localPathExists) {
    const commands = project.config.commands;
    const checks: Array<{ cmd: string; cwdSuffix?: string }> = [
      { cmd: commands.build_backend, cwdSuffix: commands.build_backend_cwd },
      { cmd: commands.test_backend, cwdSuffix: commands.test_backend_cwd },
    ];

    for (const check of checks) {
      // gradlew 파일 존재 확인
      const match = check.cmd.match(/^\.\/(\S+)/);
      if (match) {
        const toolPath = resolve(cwd, check.cwdSuffix ?? '', match[1]);
        if (!existsSync(toolPath)) {
          errors.push(`빌드 도구를 찾을 수 없습니다: ${toolPath} (명령: ${check.cmd})`);
        }
      }
    }

    // 5. Git clean working tree (경고만 — untracked 파일은 fix 브랜치에 영향 없음)
    if (project.gitStatus && !project.gitStatus.isClean) {
      console.log(`  WARN: 프로젝트 working tree가 clean하지 않습니다 (branch: ${project.gitStatus.currentBranch})`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** 사람 작업 중 쿨다운 기본값 (시간) */
const HUMAN_ACTIVITY_COOLDOWN_HOURS = 1;

/**
 * 대상 프로젝트의 Git 작업 상태를 확인하여 사람이 작업 중인지 검증합니다.
 *
 * 검증 항목:
 * 1. 현재 브랜치가 main인가 (아니면 사람이 작업 중으로 추정)
 * 2. uncommitted 변경사항이 있는가
 * 3. 최근 N시간 내 사람 커밋이 있는가
 *
 * @see AGENT_CONFLICT_PREVENTION_GUIDE.md §2.2
 */
export async function checkConflictSafety(
  projectPath: string,
  mainBranch: string,
): Promise<ConflictCheckResult> {
  try {
    // 1. 현재 브랜치 확인
    const { stdout: branchRaw } = await execAsync(
      `git -C "${projectPath}" branch --show-current`,
      { timeout: 10_000 },
    );
    const activeBranch = branchRaw.trim();

    if (activeBranch && activeBranch !== mainBranch) {
      return {
        safe: false,
        reason: `현재 브랜치가 ${activeBranch} (사람 작업 중 추정)`,
        action: 'skip',
        activeBranch,
      };
    }

    // 2. uncommitted 변경사항 확인
    const { stdout: statusRaw } = await execAsync(
      `git -C "${projectPath}" status --porcelain`,
      { timeout: 10_000 },
    );

    if (statusRaw.trim()) {
      return {
        safe: false,
        reason: 'uncommitted 변경사항 존재 (사람 편집 중 추정)',
        action: 'skip',
        activeBranch,
      };
    }

    // 3. 최근 N시간 내 사람 커밋 확인 (Agent 커밋 제외)
    const sinceHours = HUMAN_ACTIVITY_COOLDOWN_HOURS;
    const { stdout: recentRaw } = await execAsync(
      `git -C "${projectPath}" log --since="${sinceHours} hours ago" --oneline --no-merges --invert-grep --grep="Auto-Tobe-Agent"`,
      { timeout: 10_000 },
    );

    const recentLines = recentRaw.trim().split('\n').filter(Boolean);
    if (recentLines.length > 0) {
      return {
        safe: false,
        reason: `최근 ${sinceHours}시간 내 사람 커밋 ${recentLines.length}건 감지`,
        action: 'defer',
        activeBranch,
        recentCommitCount: recentLines.length,
      };
    }

    return { safe: true, action: 'proceed', activeBranch };
  } catch {
    // Git 명령 실패 시 안전하게 진행 (경로 문제 등은 이후 단계에서 처리)
    return { safe: true, action: 'proceed' };
  }
}

/**
 * 수정된 파일이 현재 열린 PR의 변경 파일과 겹치는지 감지합니다.
 *
 * 겹치는 파일이 있으면 PR을 draft로 생성하고 경고 코멘트를 추가하기 위한
 * 정보를 반환합니다. 충돌 감지 실패 시(API 오류 등) null을 반환하여
 * 정상 흐름을 방해하지 않습니다.
 *
 * @see AGENT_CONFLICT_PREVENTION_GUIDE.md §2.3
 */
export async function detectFileConflicts(
  repo: string,
  modifiedFiles: ModifiedFile[],
): Promise<FileConflictInfo | null> {
  if (modifiedFiles.length === 0) return null;

  try {
    const { stdout } = await execAsync(
      `gh pr list --repo ${repo} --state open --json number,title,files`,
      { timeout: 30_000 },
    );

    const prs = JSON.parse(stdout) as Array<{
      number: number;
      title: string;
      files: Array<{ path: string }>;
    }>;

    if (prs.length === 0) return null;

    const modifiedPaths = new Set(modifiedFiles.map((f) => f.path));
    const conflictingFiles: string[] = [];
    const conflictingPRs: Array<{ number: number; title: string }> = [];

    for (const pr of prs) {
      if (!pr.files) continue;
      const overlap = pr.files
        .map((f) => f.path)
        .filter((p) => modifiedPaths.has(p));

      if (overlap.length > 0) {
        conflictingFiles.push(...overlap);
        conflictingPRs.push({ number: pr.number, title: pr.title });
      }
    }

    if (conflictingFiles.length === 0) return null;

    const unique = [...new Set(conflictingFiles)];
    console.log(`  WARN: 파일 충돌 감지 — ${unique.length}개 파일이 열린 PR과 겹침`);
    for (const pr of conflictingPRs) {
      console.log(`    ↔ PR #${pr.number}: ${pr.title}`);
    }

    return { conflictingFiles: unique, conflictingPRs };
  } catch {
    // gh CLI 실패 시 충돌 감지를 건너뜀 (정상 흐름 유지)
    return null;
  }
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
  return new Promise((promiseResolve, promiseReject) => {
    const allowedTools = [
      'Read', 'Edit', 'Write', 'Glob', 'Grep',
      'Bash(git:*)', 'Bash(npm:*)', 'Bash(npx:*)',
      'Bash(./gradlew:*)', 'Bash(gradle:*)',
    ];
    const claudePath = resolveClaudeCliPath();
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    const sep = process.platform === 'win32' ? ';' : ':';
    const localBin = resolve(home, '.local', 'bin');
    const child = spawn(claudePath, [
      '-p',
      '--allowedTools', allowedTools.join(','),
    ], {
      cwd,
      env: {
        ...process.env,
        PATH: `${localBin}${sep}${process.env.PATH ?? ''}`,
      },
      shell: process.platform === 'win32',
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
        promiseReject(new Error(`Claude Code CLI timed out after ${timeoutMs}ms`));
      } else if (code === 0) {
        promiseResolve(stdout);
      } else {
        promiseReject(
          new Error(`Claude Code CLI exited with code ${code}: ${stderr || stdout}`),
        );
      }
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      promiseReject(new Error(`Claude Code CLI spawn error: ${err.message}`));
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

  // gradlew 실행 권한 보장 (git reset 후 권한 소실 방어)
  const gradlewMatch = adapted.match(/^\.\/(\S+)/);
  if (gradlewMatch) {
    const toolPath = resolve(cwd, gradlewMatch[1]);
    if (existsSync(toolPath)) {
      try {
        await execAsync(`chmod +x "${toolPath}"`);
      } catch { /* ignore */ }
    }
  }

  try {
    const { stdout } = await execAsync(adapted, {
      cwd,
      env: ensureJavaEnv(),
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

  // 2. 충돌 안전성 검증 (사람 작업 중 감지)
  const conflictCheck = await checkConflictSafety(cwd, mainBranch);
  if (!conflictCheck.safe) {
    console.log(`  SKIP: ${conflictCheck.reason}`);
    result.status = 'skipped';
    result.error = `Conflict safety: ${conflictCheck.reason}`;
    result.completedAt = new Date().toISOString();
    return result;
  }

  // 2.5 중복 이슈 키 생성
  const deduplicationKey = extractDeduplicationKey(issue.title);

  // 3. 브랜치 생성
  const branchName = `${policyConfig.global_rules.branch_prefix}/${issue.number}-${toBranchSlug(issue.title)}`;
  result.branchName = branchName;
  result.status = 'in_progress';
  result.deduplicationKey = deduplicationKey;

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

      // 4.1 파일 수준 충돌 감지 (열린 PR과 겹치는 파일 확인)
      const fileConflicts = await detectFileConflicts(issue.repo, modifiedFiles);
      if (fileConflicts) {
        result.fileConflicts = fileConflicts;
      }

      // 5. 빌드 검증 (Frontend-only 변경 시 프론트엔드 빌드만 실행)
      const isFrontendOnly = modifiedFiles.every(
        (f) => f.path.startsWith(project.config.project_structure.frontend_root ?? 'web-admin/')
          || f.path.endsWith('.css') || f.path.endsWith('.scss'),
      );

      if (policyConfig.global_rules.require_clean_build) {
        let buildCmd: string;
        let buildCwd: string;

        if (isFrontendOnly && project.config.commands.build_frontend) {
          // Frontend-only 변경: npm build만 실행 (gradlew 스킵)
          buildCmd = project.config.commands.build_frontend;
          buildCwd = project.config.commands.build_frontend_cwd
            ? resolve(cwd, project.config.commands.build_frontend_cwd)
            : cwd;
          console.log(`  Frontend-only change detected. Running: ${buildCmd} (cwd: ${buildCwd})`);
        } else {
          buildCmd = project.config.commands.build_backend;
          buildCwd = project.config.commands.build_backend_cwd
            ? resolve(cwd, project.config.commands.build_backend_cwd)
            : cwd;
          console.log(`  Running build: ${buildCmd} (cwd: ${buildCwd})`);
        }

        const buildResult = await runVerification('build', buildCmd, buildCwd);
        result.verifications.push(buildResult);

        if (!buildResult.passed) {
          console.log(`  BUILD FAILED (${buildResult.durationMs}ms)`);

          // PR-first 전략: 빌드 실패해도 수정 파일이 있으면 PR 생성 (CI에 위임)
          if (modifiedFiles.length > 0 && policy.auto_pr) {
            console.log('  PR-first: 빌드 실패하지만 PR 생성 후 CI에 검증 위임');
            const commitHash = await commitChanges(issue.number, issue.title, cwd);
            result.commitHash = commitHash;
            result.status = 'build_failed_ci_pending';
            result.error = `Build failed locally — CI verification required: ${buildResult.error?.substring(0, 200)}`;
            result.completedAt = new Date().toISOString();
            result.durationMs = Date.now() - new Date(result.startedAt).getTime();
            return result;
          }

          result.status = 'failed';
          result.error = `Build failed: ${buildResult.error?.substring(0, 200)}`;
          continue; // 재시도
        }

        console.log(`  BUILD PASSED (${buildResult.durationMs}ms)`);
        result.status = 'build_verified';
      }

      // 6. 테스트 검증
      if (policyConfig.global_rules.require_existing_tests_pass) {
        const testCwd = project.config.commands.test_backend_cwd
          ? resolve(cwd, project.config.commands.test_backend_cwd)
          : cwd;
        console.log(`  Running tests: ${project.config.commands.test_backend} (cwd: ${testCwd})`);
        const testResult = await runVerification(
          'test',
          project.config.commands.test_backend,
          testCwd,
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
 * 구조적 실패 감지 시 배치를 조기 중단합니다.
 */
export async function orchestrateBatchFix(
  issues: ParsedIssue[],
  project: ResolvedProject,
): Promise<FixResult[]> {
  const results: FixResult[] = [];
  let consecutiveAuthErrors = 0;
  let consecutivePathErrors = 0;

  console.log(`\n[batch] ${issues.length}건 수정 시작 (project: ${project.name})`);

  for (const issue of issues) {
    const result = await orchestrateFix(issue, project);
    results.push(result);

    if (result.status === 'failed' && result.error) {
      const errorType = classifyError(result.error);

      if (errorType === 'auth_error') {
        consecutiveAuthErrors++;
        consecutivePathErrors = 0;
      } else if (errorType === 'path_error') {
        consecutivePathErrors++;
        consecutiveAuthErrors = 0;
      } else {
        consecutiveAuthErrors = 0;
        consecutivePathErrors = 0;
      }

      // 연속 2건 auth_error → 배치 중단
      if (consecutiveAuthErrors >= 2) {
        console.log(`\n  [batch] ABORT: 연속 ${consecutiveAuthErrors}건 인증 에러. ANTHROPIC_API_KEY 확인 필요.`);
        break;
      }

      // 연속 3건 path_error → 배치 중단
      if (consecutivePathErrors >= 3) {
        console.log(`\n  [batch] ABORT: 연속 ${consecutivePathErrors}건 경로 에러. 프로젝트 설정 확인 필요.`);
        break;
      }

      console.log(`  [batch] #${issue.number} failed (${errorType}), continuing...`);
    } else {
      // 성공 또는 스킵 시 카운터 리셋
      consecutiveAuthErrors = 0;
      consecutivePathErrors = 0;
    }
  }

  console.log(`\n[batch] Complete: ${results.filter((r) => r.status !== 'failed' && r.status !== 'skipped').length}/${issues.length} succeeded`);

  return results;
}

// export for testing
export { buildFixPrompt, toBranchSlug, loadApprovalPolicy, classifyError };
