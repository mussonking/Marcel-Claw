import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { emitAgentEvent } from "../infra/agent-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { makeZeroUsageSnapshot } from "./usage.js";

// ── Constants ──────────────────────────────────────────────────────────────

const HOME = os.homedir();
const ARCHIVE_DIR = path.join(HOME, ".openclaw/agents/main/compaction-archive");
const MEMORY_DIR = path.join(HOME, ".openclaw/workspace/memory");
const OPENCLAW_CONFIG = path.join(HOME, ".openclaw/openclaw.json");
const MIN_MESSAGES_FOR_EXTRACTION = 6;

// ── Session key parsing ────────────────────────────────────────────────────

/**
 * Extract Telegram chatId from session key.
 * Format: "agent:main:telegram:group:<chatId>"
 * Returns null for non-Telegram sessions.
 */
function parseTelegramChatId(sessionKey: string): string | null {
  const match = /^agent:[^:]+:telegram:group:(.+)$/.exec(sessionKey);
  return match?.[1] ?? null;
}

/**
 * Read compactionMode for a given Telegram chatId from openclaw.json.
 * Returns "normal" as default.
 */
async function getGroupCompactionMode(chatId: string): Promise<"light" | "normal"> {
  try {
    const raw = await fs.readFile(OPENCLAW_CONFIG, "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const groups = ((cfg.channels as Record<string, unknown>)?.telegram as Record<string, unknown>)
      ?.groups as Record<string, Record<string, unknown>> | undefined;
    const mode = groups?.[chatId]?.compactionMode as string | undefined;
    return mode === "light" ? "light" : "normal";
  } catch {
    return "normal";
  }
}

// ── Telegram notification ──────────────────────────────────────────────────

async function sendTelegramNotif(text: string, chatId?: string): Promise<void> {
  try {
    const raw = await fs.readFile(OPENCLAW_CONFIG, "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const telegram = (cfg.channels as Record<string, unknown>)?.telegram as
      | Record<string, unknown>
      | undefined;
    const botToken = telegram?.botToken as string | undefined;
    if (!botToken) {
      return;
    }

    // Use provided chatId, or fall back to first enabled group
    let targetChatId = chatId;
    if (!targetChatId) {
      const groups = telegram?.groups as Record<string, Record<string, unknown>> | undefined;
      if (groups) {
        for (const [id, g] of Object.entries(groups)) {
          if (g.enabled) {
            targetChatId = id;
            break;
          }
        }
      }
    }
    if (!targetChatId) {
      return;
    }

    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: targetChatId, text, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // fire-and-forget
  }
}

// ── Conversation parsing ───────────────────────────────────────────────────

async function parseConversationText(sessionFile: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(sessionFile, "utf-8");
    const lines = raw.trim().split("\n");
    const turns: string[] = [];

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const msg = (entry.message ?? entry) as Record<string, unknown>;
        const role = msg.role as string | undefined;
        if (role !== "user" && role !== "assistant") {
          continue;
        }

        const content = msg.content;
        let text = "";
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          for (const block of content as Array<Record<string, unknown>>) {
            if (block.type === "text" && typeof block.text === "string") {
              text += block.text + " ";
            }
          }
        }
        text = text.trim();
        if (text && !text.startsWith("/")) {
          turns.push(`${role}: ${text.slice(0, 2000)}`);
        }
      } catch {
        // skip malformed lines
      }
    }

    return turns.length >= MIN_MESSAGES_FOR_EXTRACTION ? turns.join("\n\n") : null;
  } catch {
    return null;
  }
}

// ── Gemini helpers ─────────────────────────────────────────────────────────

async function callGemini(prompt: string, maxTokens = 1024): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(25_000),
      },
    );
    if (!resp.ok) {
      return null;
    }
    const data = (await resp.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
  } catch {
    return null;
  }
}

async function extractFacts(conversation: string, today: string): Promise<string | null> {
  const prompt = `You are extracting durable facts from a conversation between a user (Marco) and his AI agent (Marcel).

Rules:
- Extract ONLY durable, future-useful information
- Skip small talk, greetings, transient commands
- Categories to extract:
  1. TECHNICAL DECISIONS: architecture choices, libraries, patterns adopted
  2. COMPLETED TASKS: things done and confirmed
  3. USER PREFERENCES: how Marco wants Marcel to work
  4. SYSTEM FACTS: paths, configs, services (no sensitive credential values)
  5. KNOWN ISSUES: bugs, limitations, active workarounds

Output format (strict Markdown, nothing else):
# Compaction memory -- ${today}

## Technical decisions
- [fact]

## Completed tasks
- [fact]

## User preferences
- [fact]

## System facts
- [fact]

## Known issues
- [fact]

Omit empty categories. If nothing durable found, reply exactly: NOTHING_TO_EXTRACT

Conversation (${conversation.split("\n\n").length} exchanges):
${conversation.slice(-12000)}`;

  const result = await callGemini(prompt, 1024);
  if (!result || result === "NOTHING_TO_EXTRACT") {
    return null;
  }
  return result;
}

async function detectDrift(conversation: string): Promise<boolean> {
  if (conversation.split("\n\n").length < 10) {
    return false;
  }

  const turns = conversation.split("\n\n");
  const first = turns
    .slice(0, Math.floor(turns.length * 0.2))
    .join("\n\n")
    .slice(0, 2000);
  const last = turns
    .slice(Math.floor(turns.length * 0.8))
    .join("\n\n")
    .slice(0, 2000);

  const prompt = `Compare these two conversation excerpts and determine if the topic has significantly changed.

FIRST 20% of conversation:
${first}

LAST 20% of conversation:
${last}

Reply with exactly one word: DRIFT (topic changed significantly) or COHERENT (same topic or natural progression).`;

  const result = await callGemini(prompt, 10);
  return result?.toUpperCase().includes("DRIFT") ?? false;
}

// ── Drift state (shared between before/after handlers) ─────────────────────

const driftBySession = new Map<string, boolean>();

// ── Compaction handlers ────────────────────────────────────────────────────

export function handleAutoCompactionStart(ctx: EmbeddedPiSubscribeContext) {
  ctx.state.compactionInFlight = true;
  ctx.state.livenessState = "paused";
  ctx.ensureCompactionPromise();
  ctx.log.debug(`embedded run compaction start: runId=${ctx.params.runId}`);
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "compaction",
    data: { phase: "start" },
  });
  void ctx.params.onAgentEvent?.({
    stream: "compaction",
    data: { phase: "start" },
  });

  const sessionFile = ctx.params.session.sessionFile;
  const sessionKey = ctx.params.sessionKey ?? "";

  if (sessionFile) {
    void (async () => {
      const today = new Date().toISOString().split("T")[0];
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const chatId = parseTelegramChatId(sessionKey) ?? undefined;
      const compactionMode = chatId ? await getGroupCompactionMode(chatId) : "normal";

      // 1. Archive JSONL snapshot (all modes)
      try {
        await fs.mkdir(ARCHIVE_DIR, { recursive: true });
        await fs.copyFile(sessionFile, path.join(ARCHIVE_DIR, `${timestamp}.jsonl`));
      } catch {
        // non-fatal
      }

      // 2. Parse conversation
      const conversation = await parseConversationText(sessionFile);
      if (!conversation) {
        return;
      }

      // 3. Extract facts -> write to memory/
      try {
        let facts: string | null;
        if (compactionMode === "light") {
          facts = await callGemini(
            `Summarize in 3-5 bullet points the key facts from this conversation (keep it minimal):\n${conversation.slice(-4000)}`,
            300,
          );
        } else {
          facts = await extractFacts(conversation, today);
        }

        if (facts) {
          await fs.mkdir(MEMORY_DIR, { recursive: true });
          const sessionHash = createHash("md5")
            .update(sessionFile + timestamp)
            .digest("hex")
            .slice(0, 8);
          await fs.writeFile(
            path.join(MEMORY_DIR, `compaction-${today}-${sessionHash}.md`),
            facts,
            "utf-8",
          );
        }
      } catch {
        // non-fatal
      }

      // 4. Drift detection (normal mode only, Telegram sessions only)
      if (compactionMode === "normal" && chatId) {
        try {
          const hasDrift = await detectDrift(conversation);
          driftBySession.set(sessionKey, hasDrift);
        } catch {
          driftBySession.set(sessionKey, false);
        }
      }
    })();
  }

  // Run before_compaction plugin hook (fire-and-forget)
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("before_compaction")) {
    void hookRunner
      .runBeforeCompaction(
        {
          messageCount: ctx.params.session.messages?.length ?? 0,
          messages: ctx.params.session.messages,
          sessionFile: ctx.params.session.sessionFile,
        },
        {
          sessionKey: ctx.params.sessionKey,
        },
      )
      .catch((err) => {
        ctx.log.warn(`before_compaction hook failed: ${String(err)}`);
      });
  }
}

export function handleAutoCompactionEnd(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { willRetry?: unknown; result?: unknown; aborted?: unknown },
) {
  ctx.state.compactionInFlight = false;
  const willRetry = Boolean(evt.willRetry);
  // Increment counter whenever compaction actually produced a result,
  // regardless of willRetry.  Overflow-triggered compaction sets willRetry=true
  // (the framework retries the LLM request), but the compaction itself succeeded
  // and context was trimmed -- the counter must reflect that.  (#38905)
  const hasResult = evt.result != null;
  const wasAborted = Boolean(evt.aborted);
  if (hasResult && !wasAborted) {
    ctx.incrementCompactionCount();
    const observedCompactionCount = ctx.getCompactionCount();
    void reconcileSessionStoreCompactionCountAfterSuccess({
      sessionKey: ctx.params.sessionKey,
      agentId: ctx.params.agentId,
      configStore: ctx.params.config?.session?.store,
      observedCompactionCount,
    }).catch((err) => {
      ctx.log.warn(`late compaction count reconcile failed: ${String(err)}`);
    });
  }
  if (willRetry) {
    ctx.noteCompactionRetry();
    ctx.resetForCompactionRetry();
    ctx.log.debug(`embedded run compaction retry: runId=${ctx.params.runId}`);
  } else {
    if (!wasAborted) {
      ctx.state.livenessState = "working";
    }
    ctx.maybeResolveCompactionWait();
    clearStaleAssistantUsageOnSessionMessages(ctx);
  }
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "compaction",
    data: { phase: "end", willRetry, completed: hasResult && !wasAborted },
  });
  void ctx.params.onAgentEvent?.({
    stream: "compaction",
    data: { phase: "end", willRetry, completed: hasResult && !wasAborted },
  });

  if (!willRetry) {
    const sessionKey = ctx.params.sessionKey;
    if (sessionKey) {
      const sessionFile = ctx.params.session.sessionFile;
      const chatId = parseTelegramChatId(sessionKey) ?? undefined;
      const kept = ctx.params.session.messages?.length ?? 0;
      const dropped = ctx.getCompactionCount();
      const total = kept + dropped;
      const hasDrift = driftBySession.get(sessionKey) ?? false;
      driftBySession.delete(sessionKey);

      void (async () => {
        if (hasDrift && sessionFile && chatId) {
          // Drift: truncate session file -> next message starts fresh
          try {
            await fs.writeFile(sessionFile, "", "utf-8");
          } catch {
            // non-fatal
          }

          await sendTelegramNotif(
            `🔄 *Topic drift detected -- fresh start*\n` +
              `The conversation had drifted significantly. Context saved to memory.\n` +
              `_${dropped} messages archived · Starting clean._`,
            chatId,
          );
        } else if (chatId) {
          await sendTelegramNotif(
            `🧠 *Compaction complete*\n` +
              `${dropped} messages dropped / ${total} -> ${kept} kept\n` +
              `_Key facts saved to vector memory._`,
            chatId,
          );
        }
      })();
    }

    // Run after_compaction plugin hook (fire-and-forget)
    const hookRunnerEnd = getGlobalHookRunner();
    if (hookRunnerEnd?.hasHooks("after_compaction")) {
      void hookRunnerEnd
        .runAfterCompaction(
          {
            messageCount: ctx.params.session.messages?.length ?? 0,
            compactedCount: ctx.getCompactionCount(),
            sessionFile: ctx.params.session.sessionFile,
          },
          { sessionKey: ctx.params.sessionKey },
        )
        .catch((err) => {
          ctx.log.warn(`after_compaction hook failed: ${String(err)}`);
        });
    }
  }
}

export async function reconcileSessionStoreCompactionCountAfterSuccess(params: {
  sessionKey?: string;
  agentId?: string;
  configStore?: string;
  observedCompactionCount: number;
  now?: number;
}): Promise<number | undefined> {
  const { reconcileSessionStoreCompactionCountAfterSuccess: reconcile } =
    await import("./pi-embedded-subscribe.handlers.compaction.runtime.js");
  return reconcile(params);
}

function clearStaleAssistantUsageOnSessionMessages(ctx: EmbeddedPiSubscribeContext): void {
  const messages = ctx.params.session.messages;
  if (!Array.isArray(messages)) {
    return;
  }
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const candidate = message as { role?: unknown; usage?: unknown };
    if (candidate.role !== "assistant") {
      continue;
    }
    // pi-coding-agent expects assistant usage to exist when computing context usage.
    // Reset stale snapshots to zeros instead of deleting the field.
    candidate.usage = makeZeroUsageSnapshot();
  }
}
