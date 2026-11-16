// R2 calibration harness replay: the shared eval script's --scope ai4s branch runs the example gold set
// (industry/ai4s-gold.example.jsonl) end to end on a local fake model — no paid call. It proves the column's
// own prompts are used (never the astronomy ones), the material gate leaves limited-coverage entries
// unscored, and auto-selection stays off before calibration while the score still separates qualified
// material from junk. The script runs as a child process so its own DB pool and module cache stay separate.
import { stub } from "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { REPO_ROOT } from "@aihot/backend/config";

const seen: Array<{ step: "prefilter" | "score"; ai4s: boolean }> = [];
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
  const system = body.messages[0]!.role === "system" ? String(body.messages[0]!.content) : "";
  const last = body.messages[body.messages.length - 1]!.content;
  const user = typeof last === "string" ? last : JSON.stringify(last);
  const step = system.includes("做宽召回") ? "prefilter" : system.includes("事件注意力评分器") ? "score" : null;
  assert.ok(step, `unexpected prompt in the ai4s replay: ${system.slice(0, 60)}`);
  seen.push({ step, ai4s: system.includes("AI4S") });
  const content = (o: unknown) => ({ id: "replay", model: "stub", choices: [{ message: { content: JSON.stringify(o) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  if (step === "prefilter") return content({ label: user.includes("emails") ? "BLOCK" : "PASS", reason: "回放" });
  return content({ attentionScore: user.includes("50-year-old") ? 30 : 88 });
});
after(async () => { await provider.close(); await closeDb(); });

function runEval(env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "scripts/eval-selection.ts", "--gold", "industry/ai4s-gold.example.jsonl",
      "--scope", "ai4s", "--no-import", "--models", "glm-5.3-flash-selection", "--n", "200", "--seed", "7",
    ], { cwd: REPO_ROOT, env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("eval-selection timed out")); }, 90_000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

test("eval-selection --scope ai4s replays the gold set on a fake model: column prompts, material gate, honest auto-off", async () => {
  const { code, stdout, stderr } = await runEval({
    DATABASE_URL: process.env.DATABASE_URL!,
    DASHSCOPE_BASE_URL: `${provider.url}/v1`, ZHIPU_BASE_URL: `${provider.url}/v1`, DEEPSEEK_BASE_URL: `${provider.url}/v1`,
    DASHSCOPE_API_KEY: "test-key", ZHIPU_API_KEY: "test-key", DEEPSEEK_API_KEY: "test-key",
    PREFILTER_MODEL: "qwen3.7-flash", SCORE_MODEL: "glm-5.3-flash-selection",
    MODEL_CALLS_ENABLED: "true", COLLECT_ENABLED: "false",
    FEISHU_CONTENT_PUSH_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false", LOG_LEVEL: "error",
  });
  assert.equal(code, 0, `eval exited ${code}: ${stderr.slice(-600)}`);

  assert.ok(seen.some((s) => s.step === "prefilter" && s.ai4s), "the ai4s prefilter prompt is used");
  assert.ok(seen.some((s) => s.step === "score" && s.ai4s), "the ai4s score prompt is used");
  assert.ok(!seen.some((s) => !s.ai4s), "no astronomy prompt leaks into the ai4s replay");

  const reportLine = stdout.split("\n").find((l) => l.startsWith("report: "));
  assert.ok(reportLine, `no report line in stdout: ${stdout.slice(-300)}`);
  const report = JSON.parse(readFileSync(reportLine.slice("report: ".length).trim(), "utf8"));
  assert.equal(report.meta.scope, "ai4s");
  assert.ok(String(report.meta.promptVersion).includes("ai4s"), "the report records the ai4s prompt versions");

  const m = report.models["glm-5.3-flash-selection"];
  assert.equal(m.summary.n, 7);
  assert.equal(m.summary.either, 2, "the two synthetic limited-coverage entries are labelled 'either'");
  assert.equal(m.summary.errors, 0);
  assert.deepEqual([m.summary.tp, m.summary.fp, m.summary.fn, m.summary.tn], [0, 0, 3, 2],
    "auto-selection off: qualified material is not auto-selected (FN), junk is rejected (TN)");

  const byId = Object.fromEntries(m.cases.map((c: any) => [c.caseId, c]));
  assert.equal(byId["ai4s-syn-short-research"].score, null, "limited coverage is not scored");
  assert.equal(byId["ai4s-syn-short-community"].score, null);
  assert.equal(byId["ai4s-syn-qualified"].score, 88);
  assert.equal(byId["ai4s-syn-strong-claim"].score, 30);
  assert.equal(byId["ai4s-syn-marketing"].relevance, "block");
  assert.ok(m.cases.every((c: any) => c.decision === "reject"), "no ai4s case is auto-selected before calibration");

  const sweep60 = m.sweep.find((s: any) => s.t === 60);
  assert.equal(sweep60.F1, 1, "the score still separates qualified material from junk at the T1 threshold");
});