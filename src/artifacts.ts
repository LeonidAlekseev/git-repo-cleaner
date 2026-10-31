/**
 * Что считается артефактом AI-инструментов и какие правила очистки из этого следуют.
 *
 * Все regex применяются без учёта регистра.
 * - paths/extended исполняет git-filter-repo (Python re) и проверяет результат JavaScript,
 *   поэтому они должны быть совместимы с обоими (tests/artifacts_test.ts это проверяет).
 * - words для содержимого файлов тоже исполняет git-filter-repo.
 * - trailers, authors и words для сообщений исполняются только здесь, в JavaScript.
 */

export interface Artifact {
  key: string;
  label: string;
  /** Точные имена файлов и папок: удаляются действием files. */
  paths?: string[];
  /** Широкие шаблоны путей (claude-*, claude*.json ...): удаляются действием extended. */
  extended?: string[];
  /** Упоминания: вырезаются действиями mentions (сообщения) и content (файлы). */
  words?: string[];
  /** Имя или почта автора-бота: такой автор/коммиттер переписывается действием authors. */
  authors?: string[];
  /** Строка-атрибуция целиком (без ^$): удаляется из блока трейлеров действием trailers. */
  trailers?: string[];
  default?: boolean;
}

export const ARTIFACTS: Artifact[] = [
  {
    key: "claude",
    label: "Claude Code (.claude/, CLAUDE.md, claudedocs/, трейлеры, автор Claude)",
    paths: [
      "(^|/)\\.claude(/|$)",
      "(^|/)CLAUDE(\\.local)?\\.md$",
      "(^|/)claudedocs(/|$)",
      "(^|/)\\.vscode/claude\\.json$",
      "(^|/)\\.claude(rc|ignore)$",
      "(^|/)\\.?claude[^/]*\\.(tmp|temp|log)$",
    ],
    extended: ["(^|/)\\.?claude([-_.][^/]*)?(/|$)", "(^|/)\\.claude[^/]*(/|$)", "(^|/)\\.mcp\\.json$"],
    words: ["claude\\s*code", "claude"],
    authors: ["^claude(\\s+code)?$"],
    trailers: [
      "(?:🤖\\s*)?Generated with \\[Claude Code\\]\\([^)]*\\)",
      "(?:🤖\\s*)?Generated with Claude(?: Code)?",
      "Co-authored-by:\\s*Claude\\b[^<]*<[^>]*>",
    ],
    default: true,
  },
  {
    key: "anthropic",
    label: "Anthropic (почта @anthropic.com в авторах и трейлерах, упоминания)",
    words: ["noreply@anthropic\\.com", "anthropic"],
    authors: ["@anthropic\\.com$"],
    trailers: ["Co-authored-by:[^<]*<[^>]*@anthropic\\.com>"],
    default: true,
  },
  {
    key: "openspec",
    label: "OpenSpec (openspec/)",
    paths: ["(^|/)openspec(/|$)"],
    extended: ["openspec"],
    words: ["openspec"],
    default: true,
  },
  {
    key: "agents",
    label: "AGENTS.md / AGENT.md / AGENTS.override.md",
    paths: ["(^|/)AGENTS?(\\.[\\w-]+)?\\.md$"],
    words: ["agents\\.md"],
    default: true,
  },
  {
    key: "serena",
    label: "Serena MCP (.serena/)",
    paths: ["(^|/)\\.serena(/|$)"],
    default: true,
  },
  {
    key: "cursor",
    label: "Cursor (.cursor/, .cursorrules, .cursorignore, автор Cursor Agent)",
    paths: ["(^|/)\\.cursor(/|$)", "(^|/)\\.cursor(rules|ignore|indexingignore)$"],
    authors: ["^cursor( agent)?$", "@cursor\\.(com|sh)$"],
    trailers: ["Co-authored-by:\\s*Cursor(?: Agent)?\\s*<[^>]*>"],
  },
  {
    key: "copilot",
    label: "GitHub Copilot (.github/copilot-instructions.md, *.prompt.md, автор Copilot)",
    paths: [
      "(^|/)\\.github/copilot-instructions\\.md$",
      "(^|/)\\.github/(instructions|prompts)/[^/]+\\.(instructions|prompt)\\.md$",
    ],
    authors: ["^copilot$", "copilot@users\\.noreply\\.github\\.com$"],
    trailers: ["Co-authored-by:\\s*Copilot\\s*<[^>]*>"],
  },
  {
    key: "codex",
    label: "OpenAI Codex (.codex/, автор Codex)",
    paths: ["(^|/)\\.codex(/|$)"],
    authors: ["^(openai\\s+)?codex$"],
    trailers: ["Co-authored-by:\\s*(?:OpenAI\\s+)?Codex\\b[^<]*<[^>]*>"],
  },
  {
    key: "gemini",
    label: "Gemini (GEMINI.md, .gemini/, автор gemini-code-assist)",
    paths: ["(^|/)GEMINI\\.md$", "(^|/)\\.gemini(/|$)"],
    authors: ["^gemini-code-assist"],
    trailers: ["Co-authored-by:\\s*gemini-code-assist(?:\\[bot\\])?\\s*<[^>]*>"],
  },
  {
    key: "aider",
    label: "Aider (.aider*, «(aider)» в имени автора)",
    paths: ["(^|/)\\.aider[^/]*(/|$)"],
    authors: ["\\(aider\\)$"],
    trailers: ["Co-authored-by:\\s*aider\\b[^<]*<[^>]*>"],
  },
  {
    key: "windsurf",
    label: "Windsurf (.windsurf/, .windsurfrules)",
    paths: ["(^|/)\\.windsurf(/|$)", "(^|/)\\.windsurfrules$"],
  },
];

export interface Action {
  key: string;
  label: string;
  default: boolean;
}

export const ACTIONS: Action[] = [
  { key: "files", label: "Удалять файлы и папки артефактов (точные имена)", default: true },
  { key: "extended", label: "Расширенные шаблоны путей (claude-*, claude*.json, .mcp.json …)", default: false },
  { key: "trailers", label: "Удалять трейлеры-атрибуции в конце сообщений (Co-Authored-By …)", default: true },
  { key: "authors", label: "Переписывать авторов-ботов на ваше имя", default: true },
  { key: "mentions", label: "Вырезать упоминания из текста сообщений коммитов", default: false },
  { key: "content", label: "Вырезать упоминания из содержимого файлов (может сломать код)", default: false },
];

export interface Rules {
  /** regex путей для удаления */
  paths: string[];
  /** regex упоминаний в содержимом файлов */
  fileWords: string[];
  /** regex упоминаний в сообщениях коммитов */
  messageWords: string[];
  /** regex строк-атрибуций в блоке трейлеров */
  trailers: string[];
  /** regex имени/почты авторов-ботов */
  authors: string[];
}

export interface Extra {
  words: string[];
  paths: string[];
}

/** Собрать правила из выбранных артефактов, действий и своих regex. */
export function buildRules(artifacts: Artifact[], actions: Set<string>, extra: Extra): Rules {
  const collect = (pick: (a: Artifact) => string[] | undefined) => artifacts.flatMap((a) => pick(a) ?? []);
  const words = [...collect((a) => a.words), ...extra.words];
  return {
    paths: [
      ...(actions.has("files") ? collect((a) => a.paths) : []),
      ...(actions.has("extended") ? collect((a) => a.extended) : []),
      ...(actions.has("files") || actions.has("extended") ? extra.paths : []),
    ],
    fileWords: actions.has("content") ? words : [],
    messageWords: actions.has("mentions") ? words : [],
    trailers: actions.has("trailers") ? collect((a) => a.trailers) : [],
    authors: actions.has("authors") ? collect((a) => a.authors) : [],
  };
}

export function isEmpty(rules: Rules): boolean {
  return Object.values(rules).every((list) => list.length === 0);
}

/** Скомпилировать regex один раз: true, если любое значение совпало с любым шаблоном. */
export function matcher(patterns: string[]): (...values: string[]) => boolean {
  const compiled = patterns.map((p) => new RegExp(p, "i"));
  return (...values) => compiled.some((re) => values.some((v) => re.test(v)));
}
