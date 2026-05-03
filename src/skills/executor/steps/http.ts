/**
 * Skill Executor — HTTP step runner
 */

import fs from "node:fs";
import path from "node:path";
import { renderDeep, renderTemplate, type TemplateContext } from "../template.js";
import type { AuthPreset, HttpStep, StepResult } from "../types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export async function executeHttpStep(
  step: HttpStep,
  ctx: TemplateContext,
  authPresets?: Record<string, AuthPreset>,
): Promise<StepResult> {
  const start = Date.now();
  const url = renderTemplate(step.url, ctx);
  const timeout = step.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    // Resolve auth preset
    if (step.auth && authPresets?.[step.auth]) {
      const authHeaders = await authPresets[step.auth].resolve();
      Object.assign(headers, authHeaders.headers);
    }

    // Render custom headers
    if (step.headers) {
      const rendered = renderDeep(step.headers, ctx) as Record<string, string>;
      Object.assign(headers, rendered);
    }

    // Render body
    let bodyStr: string | undefined;
    if (step.body !== undefined) {
      const rendered = renderDeep(step.body, ctx);
      if (typeof rendered === "string") {
        bodyStr = rendered;
        headers["Content-Type"] ??= "text/plain";
      } else {
        bodyStr = JSON.stringify(rendered);
        headers["Content-Type"] ??= "application/json";
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method: step.method,
      headers,
      body: bodyStr,
      signal: controller.signal,
    });

    clearTimeout(timer);

    const responseText = await response.text();

    if (!response.ok) {
      return {
        name: step.name,
        status: "error",
        error: `HTTP ${response.status}: ${responseText.slice(0, 500)}`,
        duration_ms: Date.now() - start,
      };
    }

    if (step.save_to) {
      const savePath = path.resolve(ctx.state_dir, step.save_to);
      fs.writeFileSync(savePath, responseText, "utf-8");
    }

    return {
      name: step.name,
      status: "ok",
      output: responseText,
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: step.name,
      status: "error",
      error: message,
      duration_ms: Date.now() - start,
    };
  }
}
