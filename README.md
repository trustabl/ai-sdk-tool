# @trustabl/ai-sdk

Scan a repository for AI-agent reliability and safety gaps from inside an [AI SDK](https://ai-sdk.dev) agent.

[Trustabl](https://trustabl.ai) is an Apache-2.0 static analyzer for AI-agent codebases. It reads the code, inventories the agents, tools, subagents, skills and MCP servers it declares, and checks each against a versioned rule pack covering nine agent SDKs. It never executes your agent.

```bash
npm install @trustabl/ai-sdk
```

## Use with agent

```ts
import { generateText } from 'ai';
import { scanRepo } from '@trustabl/ai-sdk';

const { text } = await generateText({
  model: 'openai/gpt-5.1',
  prompt: 'Scan https://github.com/google/adk-python and summarise the three worst issues.',
  tools: { scanRepo: scanRepo() },
});

console.log(text);
```

The tool takes one argument, `path`, which is either a local directory or a GitHub repository URL. A URL is cloned and scanned.

## What it returns

A full scan of a large repository exceeds six megabytes of JSON — past what a model can read. The tool returns a summary instead:

| Field | What it holds |
|---|---|
| `sdks`, `languages` | What the repository actually uses, derived from production code only |
| `inventory` | Counts of tools, agents, subagents, skills and MCP servers |
| `score` | Overall readiness, 0 to 1 |
| `findingCount`, `bySeverity` | Production findings, counted. `findingCount` always equals the sum of `bySeverity` |
| `excludedTestPathFindings` | Findings dropped for living in a test path |
| `belowSeverityFloor` | Production findings below `minSeverity` |
| `findings` | The ones worth acting on: rule id, severity, title, file, line, suggested fix |
| `truncated` | `true` when `maxFindings` capped the list |

Read the inventory first. If the tool and agent counts look wrong, the scan was pointed at the wrong place and the findings are not yet worth reporting.

## Fixing what it finds

Every finding carries `suggestedFix`, the same remediation text the CLI and the
Claude plugin use. The agent can act on it directly — give it a file-writing
tool of your own alongside this one:

```ts
tools: {
  scanRepo: scanRepo(),
  writeFile: yourWriteFileTool,
}
```

This package deliberately ships no write tool. An AI SDK agent often runs
unattended, and a model-driven write primitive is a much larger thing to hand
out than a scanner. Keeping it on your side means the decision, and whatever
approval flow your app already has, stays yours.

## Raw results: JSON and SARIF

`scanRepo` summarises because a model cannot read six megabytes. For your own
code — a dashboard, a SARIF upload, a stored baseline, a diff between two scans
— use `scan`, which returns the complete document:

```ts
import { scan } from '@trustabl/ai-sdk';

const result = await scan({ path: '.' });
console.log(result.findings.length);

// Write it out, in either format
await scan({ path: '.', outputPath: 'trustabl.json' });
await scan({ path: '.', format: 'sarif', outputPath: 'trustabl.sarif' });
```

SARIF 2.1.0 uploads straight to GitHub code scanning. The file written is the
scanner's own bytes, not a re-serialisation, so it byte-compares against a
baseline.

They are separate functions on purpose: the raw result cannot reach a context
window by accident.

## Options

```ts
scanRepo({
  minSeverity: 'medium',   // 'critical' | 'high' | 'medium' | 'low' | 'info'
  maxFindings: 25,
  timeoutSeconds: 300,
})
```

Findings in test paths (`tests/`, `testdata/`, `*_test.py`, `*.spec.ts` …) are excluded regardless of severity. Sample code vendored as fixtures is not what an agent is being asked about.

## How the scanner is obtained

This package ships no binary. On first use it downloads the Trustabl release matching its own version, verifies it against that release's `checksums.txt`, and caches it under `~/.cache/trustabl-ai-sdk`. Nothing is executed before the checksum matches.

The engine release this package downloads is pinned in `package.json` under `trustabl.engineVersion`, separate from the package's own version. The two change for different reasons: a fix to this package is not a new scanner. A scheduled workflow opens a pull request when the scanner publishes something newer, so the gap is visible rather than forgotten.

| Variable | Effect |
|---|---|
| `TRUSTABL_BIN` | Use this binary and skip the download entirely |
| `TRUSTABL_CACHE_DIR` | Where the downloaded binary is cached |

Prebuilt binaries cover macOS, Linux and Windows on x64 and arm64. Windows on ARM uses the x64 build, which runs under emulation.

## Privacy

Scanning runs entirely on the machine running your agent. There is no hosted scanner, no account, and your source is never uploaded. The only network calls are fetching the scanner release on first use, and fetching the rule pack at scan time.

## Compatibility

Verified against AI SDK `5.0.271`, `6.0.299` and `7.0.126`.

## Links

- [Documentation](https://trustabl.ai/docs)
- [Engine and rule packs](https://github.com/trustabl/agent-reliability-analyzer)
- [This package's source](https://github.com/trustabl/ai-sdk-tool)
- [Report an issue](https://github.com/trustabl/ai-sdk-tool/issues)
