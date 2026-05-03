/**
 * Skill Executor — Minimal template engine
 *
 * Supported expressions:
 *   {{params.X}}           — input parameter
 *   {{env.X}}              — environment variable
 *   {{today}}              — ISO date (YYYY-MM-DD)
 *   {{read "filename"}}    — read file from state dir
 *   {{steps.name.output}}  — output from a previous step
 */

import fs from "node:fs";
import path from "node:path";

export type TemplateContext = {
  params: Record<string, unknown>;
  env: Record<string, string | undefined>;
  state_dir: string;
  steps: Record<string, { output?: string }>;
};

const PATTERN = /\{\{(.*?)\}\}/g;

function resolveExpression(expr: string, ctx: TemplateContext): string {
  const trimmed = expr.trim();

  // {{today}}
  if (trimmed === "today") {
    return new Date().toISOString().slice(0, 10);
  }

  // {{params.X}}
  if (trimmed.startsWith("params.")) {
    const key = trimmed.slice("params.".length);
    const val = ctx.params[key];
    return val === undefined ? "" : String(val);
  }

  // {{env.X}}
  if (trimmed.startsWith("env.")) {
    const key = trimmed.slice("env.".length);
    return ctx.env[key] ?? "";
  }

  // {{steps.name.output}}
  if (trimmed.startsWith("steps.")) {
    const rest = trimmed.slice("steps.".length);
    const dotIdx = rest.indexOf(".");
    if (dotIdx > 0) {
      const stepName = rest.slice(0, dotIdx);
      const field = rest.slice(dotIdx + 1);
      if (field === "output") {
        return ctx.steps[stepName]?.output ?? "";
      }
    }
    return "";
  }

  // {{read "filename"}} or {{read 'filename'}}
  const readMatch = trimmed.match(/^read\s+["'](.+?)["']$/);
  if (readMatch) {
    const filePath = path.resolve(ctx.state_dir, readMatch[1]);
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return `[file not found: ${readMatch[1]}]`;
    }
  }

  // Unknown expression — return as-is
  return `{{${expr}}}`;
}

/**
 * Render a template string by replacing all `{{...}}` expressions.
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(PATTERN, (_match, expr: string) => resolveExpression(expr, ctx));
}

/**
 * Deep-render all string values in an object (for HTTP bodies, headers, etc.)
 */
export function renderDeep(value: unknown, ctx: TemplateContext): unknown {
  if (typeof value === "string") {
    return renderTemplate(value, ctx);
  }
  if (Array.isArray(value)) {
    return value.map((v) => renderDeep(v, ctx));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = renderDeep(v, ctx);
    }
    return result;
  }
  return value;
}
