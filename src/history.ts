/**
 * Анализ истории: что изменится в коммитах и какие файлы удалятся.
 * Один и тот же план служит предпросмотром, входом для git-filter-repo и проверкой итога.
 */

import { matcher, type Rules } from "./artifacts.ts";
import { git } from "./git.ts";
import { cleanMessage, compileMessageRules } from "./message.ts";

export interface Commit {
  sha: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  message: string;
}

/** Прочитать коммиты, достижимые из revs (например ["--all"]). */
export async function readCommits(repo: string, revs: string[]): Promise<Commit[]> {
  const log = await git(["log", ...revs, "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x01"], { cwd: repo });
  const commits: Commit[] = [];
  for (const [i, entry] of log.split("\x01").entries()) {
    // git log отделяет записи переводом строки после %x01.
    const record = i > 0 && entry.startsWith("\n") ? entry.slice(1) : entry;
    if (!record) continue;
    const [sha, authorName, authorEmail, committerName, committerEmail, ...message] = record.split("\x00");
    commits.push({ sha, authorName, authorEmail, committerName, committerEmail, message: message.join("\x00") });
  }
  return commits;
}

/** Изменение одного коммита. Формат совпадает с тем, что читает commitCallback. */
export interface CommitChange {
  /** новое сообщение */
  m?: string;
  /** переписать автора */
  a?: true;
  /** переписать коммиттера */
  c?: true;
}

export interface CommitPlan {
  changes: Map<string, CommitChange>;
  /** удаляемая строка-атрибуция → сколько раз встретилась */
  trailers: Map<string, number>;
  /** коммитов с вырезанными упоминаниями */
  scrubbed: number;
  /** "Имя <почта>" авторов и коммиттеров, которые будут переписаны */
  authors: Set<string>;
}

export function planCommits(commits: Commit[], rules: Rules): CommitPlan {
  const messageRules = compileMessageRules(rules.trailers, rules.messageWords);
  const isBot = matcher(rules.authors);
  const plan: CommitPlan = { changes: new Map(), trailers: new Map(), scrubbed: 0, authors: new Set() };
  for (const commit of commits) {
    const change: CommitChange = {};
    const cleaned = cleanMessage(commit.message, messageRules);
    if (cleaned.changed) change.m = cleaned.message;
    for (const line of cleaned.removed) plan.trailers.set(line, (plan.trailers.get(line) ?? 0) + 1);
    if (cleaned.scrubbed) plan.scrubbed++;
    if (isBot(commit.authorName, commit.authorEmail)) {
      change.a = true;
      plan.authors.add(`${commit.authorName} <${commit.authorEmail}>`);
    }
    if (isBot(commit.committerName, commit.committerEmail)) {
      change.c = true;
      plan.authors.add(`${commit.committerName} <${commit.committerEmail}>`);
    }
    if (Object.keys(change).length) plan.changes.set(commit.sha, change);
  }
  return plan;
}

/** Все пути, когда-либо существовавшие в коммитах revs, совпавшие с шаблонами. */
export async function matchingPaths(repo: string, revs: string[], patterns: string[]): Promise<string[]> {
  if (!patterns.length) return [];
  const isArtifact = matcher(patterns);
  const names = await git(["log", ...revs, "--name-only", "--no-renames", "--format="], { cwd: repo });
  return [...new Set(names.split("\n"))].filter((name) => name && isArtifact(name)).sort();
}

/**
 * Тело --commit-callback для git-filter-repo (Python): применяет готовый план из JSON.
 * Решения принимаются только в TypeScript; здесь лишь подстановка по исходному SHA.
 */
export function commitCallback(changesFile: string, name: string, email: string): string {
  const j = JSON.stringify;
  return `
import json
store = globals()
if "changes" not in store:
    with open(${j(changesFile)}, encoding="utf-8") as f:
        store["changes"] = json.load(f)
change = store["changes"].get(commit.original_id.decode())
if change:
    if "m" in change:
        commit.message = change["m"].encode("utf-8")
    if change.get("a"):
        commit.author_name, commit.author_email = ${j(name)}.encode(), ${j(email)}.encode()
    if change.get("c"):
        commit.committer_name, commit.committer_email = ${j(name)}.encode(), ${j(email)}.encode()
`;
}
