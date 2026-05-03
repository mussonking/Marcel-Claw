/**
 * Librarian -- Message Extractor
 *
 * Heuristic extraction of structured information from conversation messages.
 * No LLM required -- pure pattern matching for immediate (synchronous) analysis.
 */

export type ExtractedInfo = {
  decisions: string[];
  preferences: string[];
  projects: string[];
  todos: string[];
  facts: string[];
  messageCount: number;
  userMessages: number;
};

type ParsedMessage = {
  role: string;
  text: string;
};

// ============================================================================
// Message Parsing
// ============================================================================

export function parseMessages(messages: unknown[]): ParsedMessage[] {
  const parsed: ParsedMessage[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const m = msg as Record<string, unknown>;
    const role = typeof m.role === "string" ? m.role : "unknown";
    const content = m.content;

    if (typeof content === "string") {
      parsed.push({ role, text: content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          parsed.push({ role, text: (block as Record<string, unknown>).text as string });
        }
      }
    }
  }

  return parsed;
}

// ============================================================================
// Pattern Detectors
// ============================================================================

const DECISION_PATTERNS = [
  /\bon va (?:faire|utiliser|implémenter|créer|modifier|ajouter|enlever|mettre)[^.!?\n]{5,80}/gi,
  /\bj[''e]?(?:ai|'ai) décidé[^.!?\n]{5,80}/gi,
  /\bfaut (?:faire|utiliser|implémenter|ajouter|enlever|mettre)[^.!?\n]{5,80}/gi,
  /\bil faut[^.!?\n]{5,80}/gi,
  /\bdécision[^.!?\n]{5,80}/gi,
  /\bwe(?:'re| are) going to[^.!?\n]{5,80}/gi,
  /\bwe(?:'ll| will)[^.!?\n]{5,80}/gi,
  /\blet's[^.!?\n]{5,80}/gi,
  /\bdecided to[^.!?\n]{5,80}/gi,
  /\bgoing to[^.!?\n]{5,80}/gi,
];

const PREFERENCE_PATTERNS = [
  /\bj[''e]?(?:'aime|aime)(?: mieux| ça| utiliser| vraiment)?[^.!?\n]{5,80}/gi,
  /\bje (?:préfère|prefer)[^.!?\n]{5,80}/gi,
  /\btoujours utiliser[^.!?\n]{5,80}/gi,
  /\bjamais utiliser[^.!?\n]{5,80}/gi,
  /\bnever use[^.!?\n]{5,80}/gi,
  /\balways use[^.!?\n]{5,80}/gi,
  /\bI prefer[^.!?\n]{5,80}/gi,
  /\bI(?:'d| would) rather[^.!?\n]{5,80}/gi,
  /\bI (?:don't|hate|dislike) like[^.!?\n]{5,80}/gi,
];

const TODO_PATTERNS = [
  /\bfaut pas oublier[^.!?\n]{5,80}/gi,
  /\bn[''o]?(?:ublie|ubliez) pas[^.!?\n]{5,80}/gi,
  /\bremind me[^.!?\n]{5,80}/gi,
  /\bTODO[^.!?\n]{5,80}/gi,
  /\bà faire[^.!?\n]{5,80}/gi,
  /\bdon't forget[^.!?\n]{5,80}/gi,
];

const FACT_PATTERNS = [
  /\bje suis[^.!?\n]{5,60}/gi,
  /\bMarco (?:est|a|fait|travaille)[^.!?\n]{5,80}/gi,
  /\bI(?:'m| am)[^.!?\n]{5,60}/gi,
  /\bMy (?:name|job|role|project)[^.!?\n]{5,60}/gi,
];

// Phrases that are never meaningful as project names
const PROJECT_BLOCKLIST = new Set([
  "Active Projects",
  "Recent Decisions",
  "Known Entities",
  "Marco Preferences",
  "Open Todos",
  "Validation Failed",
  "Web Fetch",
  "Mission Control", // too generic -- appears in every session
  "Marcel Memory",
  "Error Message",
  "Tool Call",
]);

function matchPatterns(texts: string[], patterns: RegExp[]): string[] {
  const results = new Set<string>();
  for (const text of texts) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const cleaned = match[0].trim().replace(/\s+/g, " ");
        if (cleaned.length >= 8) {
          results.add(cleaned);
        }
      }
    }
  }
  return [...results].slice(0, 10);
}

function detectProjects(messages: ParsedMessage[]): string[] {
  const found = new Set<string>();

  // Detect repeated capitalized multi-word phrases (min 4 occurrences, min 10 chars)
  const capPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
  const frequency: Map<string, number> = new Map();
  for (const msg of messages) {
    let match: RegExpExecArray | null;
    capPattern.lastIndex = 0;
    while ((match = capPattern.exec(msg.text)) !== null) {
      const word = match[1];
      frequency.set(word, (frequency.get(word) ?? 0) + 1);
    }
  }
  for (const [word, count] of frequency.entries()) {
    if (count >= 4 && word.length >= 10 && !PROJECT_BLOCKLIST.has(word)) {
      found.add(word);
    }
  }

  return [...found].slice(0, 8);
}

// ============================================================================
// Main Extractor
// ============================================================================

export function extractFromMessages(messages: unknown[]): ExtractedInfo {
  const parsed = parseMessages(messages);
  const userMessages = parsed.filter((m) => m.role === "user");
  const allMessages = parsed;
  const userTexts = userMessages.map((m) => m.text);

  return {
    decisions: matchPatterns(userTexts, DECISION_PATTERNS),
    preferences: matchPatterns(userTexts, PREFERENCE_PATTERNS),
    todos: matchPatterns(userTexts, TODO_PATTERNS),
    facts: matchPatterns(userTexts, FACT_PATTERNS),
    projects: detectProjects(allMessages),
    messageCount: parsed.length,
    userMessages: userMessages.length,
  };
}

// ============================================================================
// Summary Builder
// ============================================================================

export function buildHeuristicSummary(sessionId: string, info: ExtractedInfo): string {
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [`## Session ${date} -- ${sessionId.slice(0, 8)}`, ""];

  if (info.projects.length > 0) {
    lines.push(`**Topics:** ${info.projects.join(", ")}`);
  }

  if (info.decisions.length > 0) {
    lines.push("**Decisions:**");
    for (const d of info.decisions.slice(0, 3)) {
      lines.push(`- ${d}`);
    }
  }

  if (info.preferences.length > 0) {
    lines.push("**Preferences mentioned:**");
    for (const p of info.preferences.slice(0, 2)) {
      lines.push(`- ${p}`);
    }
  }

  if (info.todos.length > 0) {
    lines.push("**TODOs:**");
    for (const t of info.todos.slice(0, 2)) {
      lines.push(`- ${t}`);
    }
  }

  lines.push(`_${info.userMessages} user messages, ${info.messageCount} total_`);

  return lines.join("\n");
}
