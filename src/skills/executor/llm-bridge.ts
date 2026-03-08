/**
 * Skill Executor — LLM Bridge
 *
 * Sends a prompt to the agent via TCP bridge (claude-helper) and polls
 * for the response file. This is the same pattern used by Mission Control
 * but implemented in the core.
 *
 * Flow:
 * 1. Write prompt to a temp file with instructions to save response to a known path
 * 2. Send message to agent via TCP bridge
 * 3. Poll for response file until it exists or timeout
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("skill-llm-bridge");

const DEFAULT_BRIDGE_HOST = "127.0.0.1";
const DEFAULT_BRIDGE_PORT = 15999;
const POLL_INTERVAL_MS = 3_000;

/**
 * Send a message to the agent via the claude-helper TCP bridge.
 */
function sendToAgent(
  message: string,
  agentId = "main",
  host = DEFAULT_BRIDGE_HOST,
  port = DEFAULT_BRIDGE_PORT,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = `OPENCLAW_SEND|${agentId}|${message}\n`;
    const sock = new net.Socket();
    sock.setTimeout(35_000);

    sock.connect(port, host, () => {
      sock.write(cmd, "utf-8");
    });

    sock.on("data", () => {
      sock.destroy();
      resolve();
    });

    sock.on("timeout", () => {
      sock.destroy();
      reject(new Error("TCP bridge timeout"));
    });

    sock.on("error", (err) => {
      sock.destroy();
      reject(new Error(`TCP bridge error: ${err.message}`));
    });
  });
}

/**
 * Poll for a file to exist and return its contents.
 */
function pollForFile(filePath: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const check = () => {
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          if (content.trim().length > 0) {
            resolve(content);
            return;
          }
        } catch {
          // file might be partially written, retry
        }
      }

      if (Date.now() - start > timeoutMs) {
        reject(
          new Error(`LLM response timeout after ${timeoutMs}ms — file not found: ${filePath}`),
        );
        return;
      }

      setTimeout(check, POLL_INTERVAL_MS);
    };

    check();
  });
}

/**
 * Create an LLM handler that sends prompts to the agent via TCP bridge
 * and polls for the response file.
 */
export function createBridgeLlmHandler(opts?: {
  agentId?: string;
  bridgeHost?: string;
  bridgePort?: number;
}): (
  prompt: string,
  handlerOpts?: { timeout_ms?: number; skill_filter?: string[] },
) => Promise<string> {
  const agentId = opts?.agentId ?? "main";
  const host = opts?.bridgeHost ?? DEFAULT_BRIDGE_HOST;
  const port = opts?.bridgePort ?? DEFAULT_BRIDGE_PORT;

  return async (prompt: string, handlerOpts?: { timeout_ms?: number }) => {
    const timeoutMs = handlerOpts?.timeout_ms ?? 600_000;

    // Create a unique response file path
    const responseId = `skill-llm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const responseDir = path.join(
      process.env.HOME ?? "/tmp",
      ".openclaw",
      "workspace",
      "skill-runs",
      "_llm-responses",
    );
    fs.mkdirSync(responseDir, { recursive: true });
    const responsePath = path.join(responseDir, `${responseId}.md`);

    // Wrap the prompt with instructions to save the response
    const wrappedPrompt = [
      "TASK — execute this precisely, then save your full response.",
      "",
      prompt,
      "",
      `IMPORTANT: When done, save your COMPLETE response text to: ${responsePath}`,
      "Use the write tool or exec tool to write the file. Reply DONE after saving.",
    ].join("\n");

    log.info(`Sending LLM prompt via bridge`, { agentId, responseId });

    // Send to agent
    await sendToAgent(wrappedPrompt, agentId, host, port);

    // Poll for response
    const response = await pollForFile(responsePath, timeoutMs);

    log.info(`LLM response received`, { agentId, responseId, length: response.length });

    // Cleanup response file
    try {
      fs.unlinkSync(responsePath);
    } catch {
      // ignore cleanup errors
    }

    return response;
  };
}
