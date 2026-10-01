// Trustabl as an AI SDK tool.
//
// Exposes the scanner as a tool an agent can call mid-conversation, the same
// analysis the CLI and the MCP server run. Nothing is uploaded: the scan
// executes on the machine running the agent.

import { tool } from "ai";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { resolveBinary, ENGINE_VERSION } from "./binary.js";

const execFileAsync = promisify(execFile);

export interface ScanOptions {
  /** Findings at or above this severity are returned. Default: "medium". */
  minSeverity?: Severity;
  /** Cap on findings returned, newest severity first. Default: 25. */
  maxFindings?: number;
  /** Seconds before the scan is abandoned. Default: 300. */
  timeoutSeconds?: number;
}

export type Severity = "critical" | "high" | "medium" | "low" | "info";

const ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export interface ScanSummary {
  repo: string;
  sdks: string[];
  languages: string[];
  inventory: { tools: number; agents: number; subagents: number; skills: number; mcpServers: number };
  score: number | null;
  findingCount: number;
  bySeverity: Record<string, number>;
  findings: Array<{
    ruleId: string;
    severity: string;
    title: string;
    file: string;
    line: number;
    suggestedFix: string;
  }>;
  truncated: boolean;
  engineVersion: string;
}

/**
 * A scan of a full repository can exceed six megabytes of JSON — far past what
 * a model can read, and past most context windows outright. The tool therefore
 * returns a summary: the inventory, the severity histogram, and the findings
 * that clear `minSeverity`, capped at `maxFindings`. `truncated` says plainly
 * when something was left out, so the model never reports a partial list as
 * complete.
 */
export function summarize(raw: any, opts: Required<ScanOptions>): ScanSummary {
  const all = Array.isArray(raw.findings) ? raw.findings : [];
  const bySeverity: Record<string, number> = {};
  for (const f of all) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;

  const floor = ORDER.indexOf(opts.minSeverity);
  const kept = all
    .filter((f: any) => {
      const i = ORDER.indexOf(f.severity);
      // Test-path findings are reported by the engine but de-weighted; an
      // agent asking "what is wrong with this repo" means the shipped code.
      return i !== -1 && i <= floor && f.origin !== "test";
    })
    .sort((a: any, b: any) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));

  return {
    repo: raw.repo ?? "",
    sdks: raw.sdks ?? [],
    languages: raw.languages ?? [],
    inventory: {
      tools: (raw.tools ?? []).length,
      agents: (raw.agents ?? []).length,
      subagents: (raw.subagents ?? []).length,
      skills: (raw.skills ?? []).length,
      mcpServers: (raw.mcp_servers ?? []).length,
    },
    score: typeof raw.overall_score === "number" ? raw.overall_score : null,
    findingCount: all.length,
    bySeverity,
    findings: kept.slice(0, opts.maxFindings).map((f: any) => ({
      ruleId: f.rule_id,
      severity: f.severity,
      title: f.title,
      file: f.file_path || "(repository)",
      line: f.start_line ?? 0,
      suggestedFix: f.suggested_fix ?? "",
    })),
    truncated: kept.length > opts.maxFindings,
    engineVersion: ENGINE_VERSION,
  };
}

/**
 * Scan a repository for AI-agent reliability and safety gaps.
 *
 * ```ts
 * import { generateText } from "ai";
 * import { scanRepo } from "@trustabl/ai-sdk";
 *
 * const { text } = await generateText({
 *   model: "openai/gpt-5.1",
 *   prompt: "Scan https://github.com/google/adk-python and tell me the worst three issues.",
 *   tools: { scanRepo: scanRepo() },
 * });
 * ```
 */
export function scanRepo(options: ScanOptions = {}) {
  const opts: Required<ScanOptions> = {
    minSeverity: options.minSeverity ?? "medium",
    maxFindings: options.maxFindings ?? 25,
    timeoutSeconds: options.timeoutSeconds ?? 300,
  };

  return tool({
    description:
      "Scan a code repository for AI-agent reliability and safety gaps with Trustabl — " +
      "unsafe tool grants, prompt-injectable shell calls, missing turn limits, network " +
      "calls with no timeout, weak tool contracts. Reads the code statically and never " +
      "runs the agent. Returns the discovered inventory and the findings worth acting on. " +
      "Read the inventory first: if the tool and agent counts look wrong, the scan was " +
      "pointed at the wrong place and the findings are not yet worth reporting.",
    inputSchema: z.object({
      path: z
        .string()
        .describe(
          "What to scan: a local directory path, or a GitHub repository URL such as " +
            "https://github.com/owner/repo, which is cloned and scanned.",
        ),
    }),
    execute: async ({ path: target }): Promise<ScanSummary> => {
      const bin = await resolveBinary();
      const { stdout } = await execFileAsync(
        bin,
        // The progress reporter writes nothing when stdout is not a TTY, so
        // stdout here is the JSON document and nothing else. Verified against
        // the released binary rather than assumed.
        ["scan", target, "--format", "json"],
        {
          timeout: opts.timeoutSeconds * 1000,
          maxBuffer: 256 * 1024 * 1024,
        },
      ).catch((err: any) => {
        // A non-zero exit is the severity gate firing, not a failure: the JSON
        // is still on stdout and is exactly what the caller asked for.
        if (err?.stdout) return { stdout: err.stdout as string };
        throw err;
      });

      return summarize(JSON.parse(stdout), opts);
    },
  });
}

export { resolveBinary, ENGINE_VERSION };
