import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

type EvalCase = {
  id: string;
  category: string;
  question: string;
  expected_source_hint: string;
};

type EvalResult = {
  test: EvalCase;
  answer: string;
  fallback: boolean;
  cited: boolean;
  hintRecall: number;
  error?: string;
};

const FALLBACK = "not found in indexed source";
const DEFAULT_ENDPOINT = "http://localhost:4004/odata/v4/ticket-automator/sendQuestion";
const STOP_WORDS = new Set([
  "sap", "the", "and", "for", "per", "service", "plan", "price", "pricing",
  "source", "catalog", "monthly", "month", "edition",
]);

async function main(): Promise<void> {
  const dataset = JSON.parse(await readFile(new URL("./eval.json", import.meta.url), "utf8")) as EvalCase[];
  validateDataset(dataset);
  console.log(`Validated ${dataset.length} evaluation cases across ${new Set(dataset.map((item) => item.category)).size} categories.`);

  if (process.argv.includes("--validate-only")) return;

  const category = process.env.EVAL_CATEGORY;
  const limit = positiveInteger(process.env.EVAL_LIMIT, dataset.length);
  const selected = dataset
    .filter((item) => !category || item.category === category)
    .slice(0, limit);
  assert(selected.length > 0, "No evaluation cases matched EVAL_CATEGORY/EVAL_LIMIT.");

  const endpoint = process.env.EVAL_ENDPOINT || DEFAULT_ENDPOINT;
  const results: EvalResult[] = [];
  for (const [index, test] of selected.entries()) {
    const result = await evaluateCase(endpoint, test);
    results.push(result);
    const status = result.error ? "ERROR" : result.fallback ? "FALLBACK" : "GROUNDED";
    console.log(`[${index + 1}/${selected.length}] ${test.id} ${status} hint=${result.hintRecall.toFixed(2)}`);
  }

  printSummary(results);
  const failures = results.filter((result) => result.error);
  if (failures.length) {
    throw new Error(`${failures.length} evaluation case(s) violated the response contract or failed to run.`);
  }
}

function validateDataset(dataset: EvalCase[]): void {
  assert(Array.isArray(dataset) && dataset.length > 0, "eval.json must contain a non-empty array.");
  const ids = new Set<string>();
  dataset.forEach((item, index) => {
    assert.match(item.id, /^Q\d{3}$/, `Invalid id at index ${index}.`);
    assert(!ids.has(item.id), `Duplicate evaluation id: ${item.id}.`);
    ids.add(item.id);
    for (const field of ["category", "question", "expected_source_hint"] as const) {
      assert.equal(typeof item[field], "string", `${item.id}.${field} must be a string.`);
      assert(item[field].trim().length > 0, `${item.id}.${field} must not be empty.`);
    }
  });
}

async function evaluateCase(endpoint: string, test: EvalCase): Promise<EvalResult> {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: test.question }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    const answer = extractAnswer(await response.text());
    const fallback = answer.trim().toLowerCase() === FALLBACK;
    const cited = /\nSources:\s*\n/i.test(answer) && /https?:\/\//i.test(answer);
    if (!fallback && !cited) throw new Error("Answer has neither a verified source citation nor the fallback response.");
    return { test, answer, fallback, cited, hintRecall: hintRecall(test.expected_source_hint, answer) };
  } catch (error) {
    return {
      test,
      answer: "",
      fallback: false,
      cited: false,
      hintRecall: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractAnswer(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed === "string") return parsed;
    if (typeof parsed?.value === "string") return parsed.value;
  } catch {
    // A plain text response is also accepted.
  }
  return body.trim();
}

function hintRecall(hint: string, answer: string): number {
  const terms = tokenize(hint);
  if (!terms.length) return 1;
  const normalizedAnswer = normalize(answer);
  return terms.filter((term) => normalizedAnswer.includes(term)).length / terms.length;
}

function tokenize(value: string): string[] {
  return [...new Set(normalize(value).split(/\s+/).filter((term) => term.length > 1 && !STOP_WORDS.has(term)))];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/,/g, "").replace(/[^a-z0-9.]+/g, " ").trim();
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  assert(Number.isInteger(parsed) && parsed > 0, "EVAL_LIMIT must be a positive integer.");
  return parsed;
}

function printSummary(results: EvalResult[]): void {
  const grounded = results.filter((result) => result.cited).length;
  const fallback = results.filter((result) => result.fallback).length;
  const errors = results.filter((result) => result.error).length;
  const averageRecall = results.reduce((sum, result) => sum + result.hintRecall, 0) / results.length;
  console.log("\nEvaluation summary");
  console.table({ total: results.length, grounded, fallback, errors, hint_recall: averageRecall.toFixed(3) });

  const categories = [...new Set(results.map((result) => result.test.category))];
  console.table(categories.map((name) => {
    const rows = results.filter((result) => result.test.category === name);
    return {
      category: name,
      total: rows.length,
      grounded: rows.filter((result) => result.cited).length,
      fallback: rows.filter((result) => result.fallback).length,
      errors: rows.filter((result) => result.error).length,
      hint_recall: (rows.reduce((sum, result) => sum + result.hintRecall, 0) / rows.length).toFixed(3),
    };
  }));

  for (const result of results.filter((item) => item.error)) {
    console.error(`${result.test.id}: ${result.error}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
