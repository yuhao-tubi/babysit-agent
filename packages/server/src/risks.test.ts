import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRiskVerdicts, parseRisksFile, parseVerdictsFile } from "./risks.js";
import type { RiskCandidate } from "./types.js";

function candidate(over: Partial<RiskCandidate> = {}): RiskCandidate {
  return {
    id: "risk-1",
    title: "Unbounded loop",
    level: "medium",
    location: { path: "src/a.ts", startLine: 10, permalink: "https://x/blob/sha/src/a.ts#L10" },
    explanation: "e",
    codeSnippet: "```diff\n+ loop\n```",
    ...over,
  };
}

test("a confirmed match is marked confirmed with its verdict attached", () => {
  const risks = mergeRiskVerdicts(
    [candidate()],
    [{ id: "risk-1", confirmed: true, rationale: "real: a.ts:10 never terminates" }]
  );
  assert.equal(risks.length, 1);
  assert.equal(risks[0].state, "confirmed");
  assert.equal(risks[0].verdict?.confirmed, true);
  assert.match(risks[0].verdict!.rationale, /never terminates/);
});

test("a rejected match is marked dismissed with the rationale kept", () => {
  const risks = mergeRiskVerdicts(
    [candidate()],
    [{ id: "risk-1", confirmed: false, rationale: "already handled at a.ts:22 guard" }]
  );
  assert.equal(risks[0].state, "dismissed");
  assert.equal(risks[0].verdict?.confirmed, false);
  assert.match(risks[0].verdict!.rationale, /already handled/);
});

test("a confirmer level override replaces the candidate's level", () => {
  const risks = mergeRiskVerdicts(
    [candidate({ level: "medium" })],
    [{ id: "risk-1", confirmed: true, level: "high", rationale: "worse than finder thought" }]
  );
  assert.equal(risks[0].level, "high");
});

test("no level override keeps the finder's level", () => {
  const risks = mergeRiskVerdicts(
    [candidate({ level: "low" })],
    [{ id: "risk-1", confirmed: true, rationale: "ok" }]
  );
  assert.equal(risks[0].level, "low");
});

test("a finder risk with no matching confirmer record is unverified", () => {
  const risks = mergeRiskVerdicts([candidate()], []);
  assert.equal(risks[0].state, "unverified");
  assert.equal(risks[0].verdict, undefined);
});

test("an orphan confirmer record (no matching candidate) is ignored", () => {
  const risks = mergeRiskVerdicts(
    [candidate({ id: "risk-1" })],
    [
      { id: "risk-1", confirmed: true, rationale: "ok" },
      { id: "risk-ghost", confirmed: true, rationale: "hallucinated" },
    ]
  );
  assert.equal(risks.length, 1);
  assert.equal(risks[0].id, "risk-1");
});

test("empty candidates merge to an empty array (zero-risk case)", () => {
  assert.deepEqual(mergeRiskVerdicts([], []), []);
});

test("parseRisksFile parses a valid finder array", () => {
  const raw = JSON.stringify([
    {
      id: "risk-1",
      title: "t",
      level: "high",
      location: { path: "a.ts", startLine: 3, permalink: "p" },
      explanation: "e",
      codeSnippet: "c",
    },
  ]);
  const risks = parseRisksFile(raw);
  assert.equal(risks.length, 1);
  assert.equal(risks[0].id, "risk-1");
  assert.equal(risks[0].level, "high");
});

test("parseRisksFile returns [] on malformed or non-array JSON", () => {
  assert.deepEqual(parseRisksFile("not json"), []);
  assert.deepEqual(parseRisksFile('{"not":"an array"}'), []);
});

test("parseRisksFile drops entries missing required fields", () => {
  const raw = JSON.stringify([
    { id: "ok", title: "t", level: "low", location: { path: "a.ts", startLine: 1, permalink: "p" }, explanation: "e", codeSnippet: "c" },
    { id: "bad-no-location", title: "t", level: "low", explanation: "e", codeSnippet: "c" },
    { title: "bad-no-id", level: "low", location: { path: "a.ts", startLine: 1, permalink: "p" }, explanation: "e", codeSnippet: "c" },
    { id: "bad-level", title: "t", level: "critical", location: { path: "a.ts", startLine: 1, permalink: "p" }, explanation: "e", codeSnippet: "c" },
  ]);
  const risks = parseRisksFile(raw);
  assert.deepEqual(risks.map((r) => r.id), ["ok"]);
});

test("parseVerdictsFile returns [] on malformed JSON (confirmer-failure degradation)", () => {
  assert.deepEqual(parseVerdictsFile("boom"), []);
  // and merging with [] leaves every finder risk unverified
  const risks = mergeRiskVerdicts(
    parseRisksFile(
      JSON.stringify([
        { id: "risk-1", title: "t", level: "high", location: { path: "a.ts", startLine: 1, permalink: "p" }, explanation: "e", codeSnippet: "c" },
      ])
    ),
    parseVerdictsFile("boom")
  );
  assert.equal(risks[0].state, "unverified");
});

test("parseVerdictsFile drops records missing id or confirmed", () => {
  const raw = JSON.stringify([
    { id: "ok", confirmed: true, rationale: "r" },
    { confirmed: true, rationale: "no id" },
    { id: "no-confirmed", rationale: "r" },
  ]);
  const recs = parseVerdictsFile(raw);
  assert.deepEqual(recs.map((r) => r.id), ["ok"]);
});

test("merged risks are sorted high → medium → low by (overridden) level", () => {
  const risks = mergeRiskVerdicts(
    [
      candidate({ id: "a", level: "low" }),
      candidate({ id: "b", level: "high" }),
      candidate({ id: "c", level: "medium" }),
    ],
    [
      // c gets bumped to high by the confirmer — sort must use the override.
      { id: "c", confirmed: true, level: "high", rationale: "bumped" },
    ]
  );
  assert.deepEqual(
    risks.map((r) => r.id),
    ["b", "c", "a"]
  );
});
