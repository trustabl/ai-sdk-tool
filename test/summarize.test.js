// The summariser is the only non-trivial logic in this package: a full scan of
// a real repository exceeds six megabytes of JSON, past what any model can
// read, so what it drops and what it keeps decides whether the tool is useful
// or misleading.

import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../dist/index.js";

const opts = { minSeverity: "medium", maxFindings: 2, timeoutSeconds: 300 };

const raw = {
  repo: "https://github.com/owner/repo",
  sdks: ["google_adk"],
  languages: ["python"],
  tools: [{}, {}],
  agents: [{}],
  subagents: [],
  skills: [],
  mcp_servers: [],
  overall_score: 0.77,
  findings: [
    { rule_id: "A-1", severity: "critical", title: "c", file_path: "a.py", start_line: 1, suggested_fix: "x" },
    { rule_id: "A-2", severity: "high", title: "h", file_path: "b.py", start_line: 2, suggested_fix: "y" },
    { rule_id: "A-3", severity: "medium", title: "m", file_path: "c.py", start_line: 3, suggested_fix: "z" },
    { rule_id: "A-4", severity: "low", title: "l", file_path: "d.py", start_line: 4, suggested_fix: "" },
    { rule_id: "A-5", severity: "critical", title: "t", file_path: "tests/e.py", start_line: 5, origin: "test", suggested_fix: "" },
  ],
};

test("keeps only findings at or above minSeverity", () => {
  const s = summarize(raw, { ...opts, maxFindings: 50 });
  assert.deepEqual(s.findings.map((f) => f.ruleId), ["A-1", "A-2", "A-3"]);
});

test("excludes test-path findings even at critical", () => {
  const s = summarize(raw, { ...opts, maxFindings: 50 });
  assert.ok(!s.findings.some((f) => f.ruleId === "A-5"), "A-5 is test-origin and must not be reported");
});

test("orders by severity, worst first", () => {
  const s = summarize(raw, { ...opts, maxFindings: 50 });
  assert.deepEqual(s.findings.map((f) => f.severity), ["critical", "high", "medium"]);
});

test("caps at maxFindings and says so", () => {
  const s = summarize(raw, opts);
  assert.equal(s.findings.length, 2);
  assert.equal(s.truncated, true, "truncated must be true or the model reports a partial list as complete");
});

test("does not claim truncation when nothing was dropped", () => {
  const s = summarize(raw, { ...opts, maxFindings: 50 });
  assert.equal(s.truncated, false);
});

test("histogram covers production findings only, and the counts reconcile", () => {
  // The bug this guards: counting test-path findings in the histogram while
  // excluding them from `findings` produced a summary reading "10 high" beside
  // a single returned finding. A model reports that as ten high-severity
  // issues. findingCount must equal the sum of bySeverity, always.
  const s = summarize(raw, opts);
  assert.equal(s.findingCount, 4, "4 production findings; the 5th is test-origin");
  assert.deepEqual(s.bySeverity, { critical: 1, high: 1, medium: 1, low: 1 });
  const summed = Object.values(s.bySeverity).reduce((a, b) => a + b, 0);
  assert.equal(summed, s.findingCount, "histogram must sum to findingCount");
});

test("reports what it excluded rather than hiding it", () => {
  const s = summarize(raw, opts);
  assert.equal(s.excludedTestPathFindings, 1, "A-5 lives in tests/");
  assert.equal(s.belowSeverityFloor, 1, "A-4 is low, below the medium floor");
});

test("every production finding is accounted for exactly once", () => {
  const s = summarize(raw, { ...opts, maxFindings: 50 });
  assert.equal(s.findings.length + s.belowSeverityFloor, s.findingCount);
});

test("carries the inventory so the caller can sanity-check the target", () => {
  const s = summarize(raw, opts);
  assert.deepEqual(s.inventory, { tools: 2, agents: 1, subagents: 0, skills: 0, mcpServers: 0 });
  assert.deepEqual(s.sdks, ["google_adk"]);
});
