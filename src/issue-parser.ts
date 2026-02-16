import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  ParsedIssue,
  IssueParseError,
  Priority,
  IssueCategory,
  QaAgentMeta,
} from './types/index.js';

const execAsync = promisify(exec);

/** gh issue view --json 응답 형식 */
interface GhIssueJson {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: Array<{ name: string }>;
  createdAt: string;
  state: string;
}

/** gh issue list --json 응답 형식 */
interface GhIssueListItem {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
  state: string;
}

// --- 제목 파싱 ---

/** [P0][Security] 형식의 제목에서 우선순위 추출 */
const TITLE_PRIORITY_RE = /^\[P(\d)\]/;

/** [P0][Category] 형식의 제목에서 카테고리 추출 */
const TITLE_CATEGORY_RE = /^\[P\d\]\[(\w+)\]/;

const CATEGORY_MAP: Record<string, IssueCategory> = {
  security: 'security',
  performance: 'performance',
  architecture: 'architecture',
  codequality: 'code-quality',
  operations: 'operations',
  frontend: 'frontend',
  testing: 'testing',
};

// --- 본문 파싱 ---

/** QA-AGENT-META 블록 추출 */
const QA_META_RE = /<!--\s*QA-AGENT-META\s*\n([\s\S]*?)\n\s*-->/;

/** 마크다운 ## 섹션 분리 */
const SECTION_RE = /^## (.+)$/gm;

/** 파일 경로 추출 (백틱 내 경로) */
const FILE_PATH_RE = /`([\w\-/.]+\.(?:java|ts|tsx|js|jsx|py|groovy|yml|yaml|json|xml|sql|md))`/g;

/** 코드 블록 추출 */
const CODE_BLOCK_RE = /```(\w*)\n([\s\S]*?)```/g;

/**
 * gh CLI로 단일 이슈 정보를 가져옵니다.
 */
async function fetchIssue(issueNumber: number, repo: string): Promise<GhIssueJson> {
  const { stdout } = await execAsync(
    `gh issue view ${issueNumber} --repo ${repo} --json number,title,body,url,labels,createdAt,state`,
  );
  return JSON.parse(stdout) as GhIssueJson;
}

/**
 * gh CLI로 Open 이슈 목록을 가져옵니다.
 */
export async function fetchOpenIssueNumbers(repo: string, limit = 100): Promise<GhIssueListItem[]> {
  const { stdout } = await execAsync(
    `gh issue list --repo ${repo} --state open --limit ${limit} --json number,title,labels,state`,
  );
  return JSON.parse(stdout) as GhIssueListItem[];
}

/**
 * 제목에서 우선순위를 추출합니다.
 * 1. 제목 패턴 [P0]~[P3]
 * 2. 라벨 P0~P3
 * 3. 기본값 P3
 */
function extractPriority(title: string, labels: string[]): Priority {
  const titleMatch = title.match(TITLE_PRIORITY_RE);
  if (titleMatch) {
    const p = `P${titleMatch[1]}` as Priority;
    if (['P0', 'P1', 'P2', 'P3'].includes(p)) return p;
  }

  for (const label of labels) {
    if (['P0', 'P1', 'P2', 'P3'].includes(label)) return label as Priority;
  }

  return 'P3';
}

/**
 * 제목/라벨에서 카테고리를 추출합니다.
 * 1. 제목 패턴 [P0][Category]
 * 2. 라벨 (security, performance 등)
 * 3. 제목 키워드 기반 추론
 */
function extractCategory(title: string, labels: string[]): IssueCategory {
  const titleMatch = title.match(TITLE_CATEGORY_RE);
  if (titleMatch) {
    const cat = titleMatch[1].toLowerCase();
    if (cat in CATEGORY_MAP) return CATEGORY_MAP[cat];
  }

  for (const label of labels) {
    const lower = label.toLowerCase();
    if (lower in CATEGORY_MAP) return CATEGORY_MAP[lower];
  }

  const lowerTitle = title.toLowerCase();
  if (lowerTitle.includes('security') || lowerTitle.includes('보안') || lowerTitle.includes('인증')) return 'security';
  if (lowerTitle.includes('performance') || lowerTitle.includes('n+1') || lowerTitle.includes('성능')) return 'performance';
  if (lowerTitle.includes('frontend') || lowerTitle.includes('프론트')) return 'frontend';
  if (lowerTitle.includes('test') || lowerTitle.includes('테스트')) return 'testing';
  if (lowerTitle.includes('docker') || lowerTitle.includes('deploy') || lowerTitle.includes('배포')) return 'operations';

  return 'code-quality';
}

/**
 * 본문에서 QA-AGENT-META 블록을 추출합니다.
 */
function extractQaAgentMeta(body: string): QaAgentMeta | undefined {
  const match = body.match(QA_META_RE);
  if (!match) return undefined;

  try {
    return JSON.parse(match[1]) as QaAgentMeta;
  } catch {
    return undefined;
  }
}

/**
 * 마크다운 본문을 섹션별로 분리합니다.
 */
function splitSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = body.split(SECTION_RE);

  // parts[0]은 첫 ## 이전 텍스트, 이후 [제목, 내용, 제목, 내용, ...] 패턴
  for (let i = 1; i < parts.length; i += 2) {
    const sectionName = parts[i].trim();
    const sectionContent = (parts[i + 1] || '').trim();
    sections[sectionName] = sectionContent;
  }

  return sections;
}

/**
 * 본문에서 파일 경로를 추출합니다.
 */
function extractFilePaths(body: string): string[] {
  const paths = new Set<string>();
  let match: RegExpExecArray | null;

  FILE_PATH_RE.lastIndex = 0;
  while ((match = FILE_PATH_RE.exec(body)) !== null) {
    paths.add(match[1]);
  }

  return [...paths];
}

/**
 * 본문에서 코드 블록을 추출합니다.
 */
function extractCodeSnippets(body: string): string[] {
  const snippets: string[] = [];
  let match: RegExpExecArray | null;

  CODE_BLOCK_RE.lastIndex = 0;
  while ((match = CODE_BLOCK_RE.exec(body)) !== null) {
    snippets.push(match[2].trim());
  }

  return snippets;
}

/**
 * 본문에서 문제/권장수정 내용을 파싱합니다.
 * 신규 형식: ## 문제, ## 영향, ## 권장 수정
 * 레거시 형식: ## 설명, ## 심각도, ## 제안 해결책
 */
function parseBodyContent(body: string): ParsedIssue['parsedContent'] {
  const sections = splitSections(body);

  const problem = sections['문제'] || sections['설명'] || '';
  const recommendation =
    sections['권장 수정'] || sections['제안 해결책'] || sections['해결 방안'] || undefined;
  const affectedFiles = extractFilePaths(body);
  const codeSnippets = extractCodeSnippets(body);

  return {
    problem,
    recommendation,
    affectedFiles: affectedFiles.length > 0 ? affectedFiles : undefined,
    codeSnippets: codeSnippets.length > 0 ? codeSnippets : undefined,
  };
}

/**
 * 이슈의 자동 수정 가능 여부를 판단합니다.
 */
function determineAutoFixable(
  priority: Priority,
  category: IssueCategory,
  meta?: QaAgentMeta,
): boolean {
  if (meta?.auto_fixable !== undefined) return meta.auto_fixable;

  // P0 보안 이슈 중 Git 이력 관련은 자동 수정 불가
  if (priority === 'P0' && category === 'security') return false;

  return true;
}

/**
 * GitHub Issue에서 구조화된 이슈 데이터를 파싱합니다.
 */
export async function parseIssue(
  issueNumber: number,
  repo: string,
): Promise<ParsedIssue | IssueParseError> {
  try {
    const issue = await fetchIssue(issueNumber, repo);
    const labels = issue.labels.map((l) => l.name);
    const priority = extractPriority(issue.title, labels);
    const category = extractCategory(issue.title, labels);
    const meta = extractQaAgentMeta(issue.body);
    const parsedContent = parseBodyContent(issue.body);

    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      url: issue.url,
      repo,
      labels,
      priority: meta?.priority ?? priority,
      category: meta?.category ?? category,
      meta,
      parsedContent,
      createdAt: issue.createdAt,
      isAutoFixable: determineAutoFixable(priority, category, meta),
    };
  } catch (error) {
    return {
      issueNumber,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 여러 이슈를 일괄 파싱합니다.
 */
export async function parseIssues(
  issueNumbers: number[],
  repo: string,
): Promise<Array<ParsedIssue | IssueParseError>> {
  const results: Array<ParsedIssue | IssueParseError> = [];

  for (const num of issueNumbers) {
    const result = await parseIssue(num, repo);
    results.push(result);
  }

  return results;
}

/**
 * 파싱 결과가 성공인지 확인합니다.
 */
export function isParsedIssue(
  result: ParsedIssue | IssueParseError,
): result is ParsedIssue {
  return 'title' in result;
}

/**
 * 이슈를 우선순위별로 정렬합니다 (P0 → P1 → P2 → P3).
 */
export function sortByPriority(issues: ParsedIssue[]): ParsedIssue[] {
  const order: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return [...issues].sort((a, b) => order[a.priority] - order[b.priority]);
}
