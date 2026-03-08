/**
 * Marcel Librarian — Core Extension
 *
 * Persistent memory and context injection for Marcel.
 *
 * - before_prompt_build: FTS5 search against SQLite memories DB → injects top relevant results
 * - agent_end: heuristic extraction → INSERT into memories + sessions + queue tables
 *   Only processes Telegram/Discord sessions (not cron/automated sessions).
 *   Sends a Telegram notification listing what was stored, with numbered IDs for easy deletion.
 * - Deep analysis runs via a separate cron job (librarian-analyze) every 2h
 */

import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { LibrarianStorage } from "./storage.js";

// ============================================================================
// Helpers
// ============================================================================

function parseTelegramChatId(sessionKey: string): string | null {
  const match = /^agent:[^:]+:telegram:(?:group|dm):(.+)$/.exec(sessionKey);
  return match?.[1] ?? null;
}

function isRealUserSession(sessionKey: string): boolean {
  return sessionKey.includes(":telegram:") || sessionKey.includes(":discord:");
}

async function sendTelegramNotif(
  token: string,
  chatId: string,
  items: Array<{ id: number; text: string; category: string }>,
): Promise<void> {
  const lines: string[] = [
    `🧠 *Memory — ${items.length} item${items.length > 1 ? "s" : ""} added*`,
  ];

  for (const item of items) {
    const preview = item.text.length > 90 ? item.text.slice(0, 90) + "…" : item.text;
    lines.push(`\`[${item.id}]\` _${item.category}_: ${preview}`);
  }

  lines.push("");
  lines.push("*Commands:*");
  lines.push("`delete 42` • `delete 42,43` • `mem list` • `mem search <term>`");

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "Markdown",
    }),
  }).catch(() => {
    /* non-fatal */
  });
}

// ============================================================================
// Plugin Definition
// ============================================================================

export default {
  id: "librarian",
  name: "Marcel Librarian",
  version: "2026.2.25",
  description:
    "Persistent memory and context injection. Analyzes conversations, maintains structured knowledge, injects relevant context before each LLM call.",

  register(api: OpenClawPluginApi) {
    const cfg = api.config as Record<string, unknown> & {
      agents?: { defaults?: { workspace?: string } };
      channels?: { telegram?: { groups?: Record<string, { memoryEnabled?: boolean }> } };
    };
    const workspaceDir =
      cfg?.agents?.defaults?.workspace ?? path.join(os.homedir(), ".openclaw/workspace");
    const librarianDir = path.join(workspaceDir, "librarian");
    const storage = new LibrarianStorage(librarianDir);

    const isMemoryEnabledForGroup = (chatId: string): boolean => {
      const groups = cfg?.channels?.telegram?.groups ?? {};
      // Try exact match and @-prefixed match (Telegram session keys use @username format)
      const key = Object.keys(groups).find(
        (k) =>
          k === chatId ||
          k.toLowerCase() === chatId.toLowerCase() ||
          `@${k}`.toLowerCase() === chatId.toLowerCase(),
      );
      if (!key) return false;
      return groups[key]?.memoryEnabled === true;
    };

    // ========================================================================
    // Hook 1 — Context Injection (before LLM call)
    // ========================================================================

    api.on(
      "before_prompt_build",
      (event, _ctx) => {
        try {
          const context = storage.buildContextBlock(event.prompt ?? "");
          if (!context) return;

          api.logger.info?.("librarian: injecting context");
          return { prependContext: context };
        } catch (err) {
          api.logger.warn(`librarian: context injection failed: ${String(err)}`);
        }
      },
      { priority: 80 },
    );

    // ========================================================================
    // Hook 2 — Session Processing (after conversation ends)
    // ========================================================================

    api.on("agent_end", async (event, ctx) => {
      if (!event.success) return;

      const messages = event.messages;
      if (!messages || messages.length === 0) return;

      // Skip cron sessions to avoid self-referential loops
      const sessionId = ctx.sessionId ?? "unknown";
      if (sessionId.startsWith("librarian-")) return;

      // Only process Telegram/Discord sessions with memoryEnabled: true
      const sessionKey = ctx.sessionKey ?? "";
      if (!isRealUserSession(sessionKey)) return;

      const chatId = parseTelegramChatId(sessionKey);
      if (!chatId || !isMemoryEnabledForGroup(chatId)) return;

      try {
        const agentDir = path.resolve(workspaceDir, "../agents/main/sessions");

        const inserted = storage.processSession({
          sessionId,
          messages,
          sessionsDir: agentDir,
        });

        api.logger.info?.(
          `librarian: session processed (${sessionId.slice(0, 8)}) — ${inserted.length} memories added`,
        );

        // Send Telegram notification if anything was stored
        if (inserted.length > 0) {
          const token = process.env.TELEGRAM_BOT_TOKEN;
          const chatId = parseTelegramChatId(sessionKey);
          if (token && chatId) {
            await sendTelegramNotif(token, chatId, inserted);
          }
        }
      } catch (err) {
        api.logger.warn(`librarian: session processing failed: ${String(err)}`);
      }
    });

    // ========================================================================
    // Service Registration
    // ========================================================================

    api.registerService({
      id: "librarian",
      start: () => {
        api.logger.info(`librarian: ready (dir: ${librarianDir})`);
      },
      stop: () => {
        api.logger.info("librarian: stopped");
      },
    });
  },
};
