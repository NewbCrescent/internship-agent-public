import { spawn } from "node:child_process";
import { z } from "zod";

const detectorSchema = z.object({ score: z.number(), ai_likeness_percentile: z.number(), passed: z.boolean() });
const payloadSchema = z.object({
  samples: z.record(z.string(), z.object({
    detectors: z.record(z.string(), detectorSchema),
    all_three_passed: z.boolean(),
    average_ai_likeness_percentile: z.number(),
    target_average: z.number(),
    voice_proxy_passed: z.boolean()
  }))
});

/**
 * The candidate's local three-detector voice-proxy gate. A pass is a
 * secondary voice-distribution signal, never proof of human authorship.
 */
export type VoiceGateResult = {
  passed: boolean;
  allThreePassed: boolean;
  averagePercentile: number;
  targetAverage: number;
  detectors: Record<string, { score: number; percentile: number; passed: boolean }>;
};

export type VoiceGate = (text: string) => Promise<VoiceGateResult>;

export function parseVoiceGateOutput(stdout: string): VoiceGateResult {
  const payload = payloadSchema.parse(JSON.parse(stdout) as unknown);
  const samples = Object.values(payload.samples);
  if (samples.length !== 1) throw new Error("The voice gate returned " + samples.length + " samples for one draft.");
  const sample = samples[0]!;
  return {
    passed: sample.voice_proxy_passed,
    allThreePassed: sample.all_three_passed,
    averagePercentile: sample.average_ai_likeness_percentile,
    targetAverage: sample.target_average,
    detectors: Object.fromEntries(Object.entries(sample.detectors).map(([name, detector]) => [name, {
      score: detector.score, percentile: detector.ai_likeness_percentile, passed: detector.passed
    }]))
  };
}

/**
 * Runs the configured gate command (`voice-gate --json`, draft on stdin).
 * The draft never leaves the machine through this path.
 */
export function createCommandVoiceGate(command: string, timeoutMs = 600_000): VoiceGate {
  return (text) => new Promise((resolve, reject) => {
    const child = spawn(command, ["--json"], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("The voice gate timed out.")); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(new Error("The voice gate could not start: " + error.message)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = Buffer.concat(stderr).toString("utf8").trim().split("\n").slice(-3).join(" ");
        reject(new Error(`The voice gate exited with ${code}${tail ? ": " + tail : ""}.`));
        return;
      }
      try { resolve(parseVoiceGateOutput(Buffer.concat(stdout).toString("utf8"))); } catch (error) { reject(error as Error); }
    });
    child.stdin.end(text);
  });
}
