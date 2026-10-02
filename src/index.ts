// Trustabl as an AI SDK tool.
//
// Exposes the scanner as a tool an agent can call mid-conversation, the same
// analysis the CLI and the MCP server run. Nothing is uploaded: the scan
// executes on the machine running the agent.

import { tool } from "ai";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
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
  /** Production findings. Equals the sum of `bySeverity`. */
  findingCount: number;
  /** Production findings by severity. Deliberately excludes test-path
   *  findings, so a reader cannot add up a severity the tool then refused to
   *  show them. */
  bySeverity: Record<string, number>;
  /** Findings dropped for living in a test path, reported rather than hidden. */
  excludedTestPathFindings: number;
  /** Production findings below `minSeverity`, so the caller can tell the
   *  difference between "nothing worse exists" and "the floor hid it". */
  belowSeverityFloor: number;
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

  // Test-path findings are reported by the engine but de-weighted; an agent
  // asking "what is wrong with this repo" means the shipped code. They are
  // counted separately rather than folded into the histogram: counting them
  // there produced a summary reading "10 high" next to a single returned
  // finding, which a model would faithfully report as ten high-severity
  // issues when there was one medium.
  const production = all.filter((f: any) => f.origin !== "test");
  const bySeverity: Record<string, number> = {};
  for (const f of production) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;

  const floor = ORDER.indexOf(opts.minSeverity);
  const kept = production
    .filter((f: any) => {
      const i = ORDER.indexOf(f.severity);
      return i !== -1 && i <= floor;
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
    findingCount: production.length,
    bySeverity,
    excludedTestPathFindings: all.length - production.length,
    belowSeverityFloor: production.length - kept.length,
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
export interface RawScanOptions {
  /** A local directory, or a GitHub repository URL to clone and scan. */
  path: string;
  /** `json` returns the full ScanResult; `sarif` returns a SARIF 2.1.0 log. */
  format?: "json" | "sarif";
  /** Also write the document to this path. The directory must exist. */
  outputPath?: string;
  /** Seconds before the scan is abandoned. Default: 300. */
  timeoutSeconds?: number;
}

/**
 * Run a scan and return the complete result, for your own code rather than a
 * model.
 *
 * `scanRepo` deliberately summarises, because a full scan of a large repository
 * exceeds six megabytes and no model can read it. That is the wrong shape for a
 * dashboard, a SARIF upload, a stored baseline or a diff between two scans —
 * hence a separate function. Keeping them separate is the point: the raw result
 * cannot reach a context window by accident.
 *
 * ```ts
 * import { scan } from "@trustabl/ai-sdk";
 *
 * const result = await scan({ path: "." });
 * console.log(result.findings.length);
 *
 * await scan({ path: ".", format: "sarif", outputPath: "trustabl.sarif" });
 * ```
 */
export async function scan(options: RawScanOptions): Promise<any> {
  const format = options.format ?? "json";
  const bin = await resolveBinary();

  const { stdout } = await execFileAsync(
    bin,
    ["scan", options.path, "--format", format],
    {
      timeout: (options.timeoutSeconds ?? 300) * 1000,
      maxBuffer: 256 * 1024 * 1024,
    },
  ).catch((err: any) => {
    // A non-zero exit is the severity gate firing, not a failure: the document
    // is still on stdout and is exactly what the caller asked for.
    if (err?.stdout) return { stdout: err.stdout as string };
    throw err;
  });

  if (options.outputPath) {
    // Write the bytes the scanner produced, not a re-serialisation of the
    // parsed object. Round-tripping through JSON.stringify would reorder keys
    // and drop formatting, which breaks byte-comparison against a baseline.
    await writeFile(options.outputPath, stdout, "utf8");
  }

  return JSON.parse(stdout);
}

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
