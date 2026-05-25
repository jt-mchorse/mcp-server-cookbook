// Safe child-process bridge for the internal-tools server.
//
// Posture (D-009):
// - Binary is one of a fixed allowlist resolved at construction.
// - Args are passed as an array to `spawn`; `shell` is never enabled.
// - The environment is scrubbed to a documented passlist (no API keys,
//   no auth tokens, no caller-supplied env).
// - cwd is locked to a configured root supplied at construction.
// - Stdout/stderr are capped at MAX_OUTPUT_BYTES each; on overflow the
//   call rejects with a typed error.
// - A per-call timeout fires SIGKILL; on expiry the call rejects.
//
// The bridge never accepts a "raw command string" — only structured
// inputs. The tool handlers translate from the MCP-call schema into
// the argv array.

import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export const MAX_OUTPUT_BYTES = 1_048_576; // 1 MiB per stream
export const DEFAULT_TIMEOUT_MS = 10_000;

const ENV_PASSLIST = ["PATH", "LANG", "LC_ALL", "TZ", "NODE_OPTIONS"] as const;

export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeError";
  }
}
export class AllowlistError extends BridgeError {
  constructor(message: string) {
    super(message);
    this.name = "AllowlistError";
  }
}
export class TimeoutError extends BridgeError {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
export class OutputCapError extends BridgeError {
  constructor(message: string) {
    super(message);
    this.name = "OutputCapError";
  }
}
export class NonZeroExitError extends BridgeError {
  readonly exitCode: number | null;
  readonly stderr: string;
  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message);
    this.name = "NonZeroExitError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface BridgeConfig {
  /** Absolute paths of executables permitted to be spawned. */
  readonly allowlist: ReadonlyArray<string>;
  /** Working directory used for every spawn. Must be absolute. */
  readonly cwd: string;
  /** Per-call timeout. Defaults to DEFAULT_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /**
   * Maximum bytes captured from each of stdout and stderr. Defaults to
   * MAX_OUTPUT_BYTES. Exceeding kills the child and rejects with
   * OutputCapError so a runaway tool can't OOM the server.
   */
  readonly maxOutputBytes?: number;
}

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Validate a `BridgeConfig` at the entry of `runBridged` so D-009's
 * protective posture (no shell, no OOM, no hang, no PATH-based attack
 * surface widening) cannot be silently undermined by a misconfigured
 * operator input. Without this guard:
 *   - timeoutMs = 0 SIGKILLs every child on the next tick.
 *   - maxOutputBytes = 0 SIGKILLs on the first byte of any output.
 *   - allowlist entries that are not absolute paths trigger PATH lookups
 *     inside spawn() — the "no shell" posture only blocks metacharacters,
 *     not PATH search, so a relative allowlist entry widens the attack
 *     surface beyond the documented contract at the BridgeConfig field
 *     docstring.
 *   - cwd that is not absolute resolves against process.cwd(), violating
 *     the "locked to a configured root" guarantee in the same docstring.
 *
 * Mirrors the portfolio's contract-tightening sweep (PRs
 * llm-eval-harness#41, llm-cost-optimizer#35, rag-production-kit#37,
 * embedding-model-shootout#30, vector-search-at-scale#28,
 * chunking-strategies-lab#28, python-async-llm-pipelines#31,
 * prompt-regression-suite#36, agent-orchestration-platform#30):
 * operator-supplied numeric/path inputs validated at the entry site
 * with a loud error rather than silent degeneracy.
 */
function validateConfig(cfg: BridgeConfig): void {
  if (typeof cfg.cwd !== "string" || cfg.cwd.length === 0 || !isAbsolute(cfg.cwd)) {
    throw new BridgeError(`BridgeConfig.cwd must be an absolute path; got ${JSON.stringify(cfg.cwd)}`);
  }
  if (!Array.isArray(cfg.allowlist) || cfg.allowlist.length === 0) {
    throw new BridgeError("BridgeConfig.allowlist must be a non-empty array of absolute paths");
  }
  for (const entry of cfg.allowlist) {
    if (typeof entry !== "string" || entry.length === 0 || !isAbsolute(entry)) {
      throw new BridgeError(
        `BridgeConfig.allowlist entries must be absolute paths; got ${JSON.stringify(entry)}`,
      );
    }
  }
  if (cfg.timeoutMs !== undefined) {
    if (!Number.isInteger(cfg.timeoutMs) || cfg.timeoutMs < 1) {
      throw new BridgeError(
        `BridgeConfig.timeoutMs must be an integer >= 1; got ${cfg.timeoutMs}`,
      );
    }
  }
  if (cfg.maxOutputBytes !== undefined) {
    if (!Number.isInteger(cfg.maxOutputBytes) || cfg.maxOutputBytes < 1) {
      throw new BridgeError(
        `BridgeConfig.maxOutputBytes must be an integer >= 1; got ${cfg.maxOutputBytes}`,
      );
    }
  }
}

/**
 * Run an allow-listed binary with an array of args.
 *
 * Never enables `shell`. The binary string MUST be present in the
 * allowlist verbatim; relative paths and PATH lookups are rejected.
 */
export async function runBridged(
  cfg: BridgeConfig,
  binary: string,
  args: ReadonlyArray<string>,
): Promise<RunResult> {
  validateConfig(cfg);
  if (!cfg.allowlist.includes(binary)) {
    throw new AllowlistError(
      `binary not on allowlist: ${binary} (allowed: ${cfg.allowlist.join(", ")})`,
    );
  }
  for (const a of args) {
    if (typeof a !== "string") {
      throw new BridgeError(`argv entries must be strings; got ${typeof a}`);
    }
  }
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = cfg.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_PASSLIST) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(binary, [...args], {
      cwd: cfg.cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let killed = false;
    let timedOut = false;
    let outputCapped: "stdout" | "stderr" | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        if (!killed) {
          killed = true;
          outputCapped = "stdout";
          child.kill("SIGKILL");
        }
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) {
        if (!killed) {
          killed = true;
          outputCapped = "stderr";
          child.kill("SIGKILL");
        }
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new BridgeError(`spawn failed: ${err.message}`));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      if (timedOut) {
        reject(new TimeoutError(`${binary} exceeded ${timeoutMs}ms timeout`));
        return;
      }
      if (outputCapped) {
        reject(
          new OutputCapError(
            `${binary} ${outputCapped} exceeded ${maxOutputBytes} bytes`,
          ),
        );
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new NonZeroExitError(
          `${binary} exited with code=${code} signal=${signal ?? "null"}`,
          code,
          stderr,
        ),
      );
    });
  });
}
