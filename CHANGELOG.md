# Changelog

All notable changes to `@trustabl/ai-sdk` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The package version and the scanner it downloads are tracked separately. The
engine pin lives in `package.json` under `trustabl.engineVersion` and is noted
below whenever it moves.

## [0.1.1] - 2026-10-02

Engine pin: `0.1.13` (unchanged).

### Fixed

- **The severity histogram no longer counts findings the tool then hides.**
  `bySeverity` counted every finding, including test-path ones excluded from
  the returned list. Scanning a repository that vendors sample agent code
  produced a summary reading `{"high": 10}` beside a single returned finding
  and `truncated: false` — each statement true, and together they report ten
  high-severity problems where there is one medium. A model given that output
  repeats it. `bySeverity` now covers production findings only and
  `findingCount` equals its sum.

### Added

- **`excludedTestPathFindings` and `belowSeverityFloor`.** What the summary
  leaves out is now stated rather than implied, and
  `findings.length + belowSeverityFloor === findingCount` always holds, so
  every finding is accounted for exactly once.
- **`scan()` — the full result, for your code rather than a model.** `scanRepo`
  summarises because a model cannot read six megabytes, which is the wrong
  shape for a dashboard, a SARIF upload, a stored baseline or a diff between
  two scans.

    ```ts
    const result = await scan({ path: '.' });
    await scan({ path: '.', outputPath: 'trustabl.json' });
    await scan({ path: '.', format: 'sarif', outputPath: 'trustabl.sarif' });
    ```

    SARIF 2.1.0 uploads straight to GitHub code scanning. The file written is
    the scanner's own bytes rather than a re-serialisation, so it byte-compares
    against a baseline. `scan` and `scanRepo` are separate functions on purpose:
    the raw result cannot reach a context window by accident.

### Documentation

- How to fix findings. Every finding carries `suggestedFix`; the agent applies
  it using a file-writing tool the developer supplies. This package ships no
  write tool deliberately — an AI SDK agent often runs unattended, and a
  model-driven write primitive is a larger thing to hand out than a scanner.

## [0.1.0] - 2026-10-02

Engine pin: `0.1.13`.

First release.

### Added

- **`scanRepo()`** — Trustabl as an AI SDK tool. Takes a local directory or a
  GitHub URL, reads the code without executing the agent, and returns the
  inventory it found plus the findings worth acting on, each with rule id,
  severity, file, line and a suggested fix.
- **Summarised output.** A full scan of a large repository exceeds six
  megabytes of JSON. The tool returns the inventory, a severity histogram and
  the findings above a severity floor, with `truncated` set when the cap
  applied.
- **Test-path exclusion.** Findings under `tests/`, `testdata/`, `test_*.py`,
  `*.spec.ts` and the rest are excluded whatever their severity. Sample agent
  code vendored as a fixture is not what the agent is being asked about.
- **Self-resolving scanner.** The package ships no binary. On first use it
  downloads the pinned release for the host platform and verifies it against
  that release's `checksums.txt` before anything is executed. `TRUSTABL_BIN`
  skips the download; `TRUSTABL_CACHE_DIR` moves the cache.
- **Windows ARM64 support** via the x64 build under emulation, since no
  `windows/arm64` asset is published.

Verified against AI SDK `5.0.271`, `6.0.299` and `7.0.126`.
