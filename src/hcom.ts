import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute an hcom CLI command.
 * @param args - Arguments to pass to hcom (e.g., ["list", "--json"])
 * @returns Parsed result with stdout, stderr, and exit code
 */
export async function execHcom(args: string[]): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync("hcom", args, {
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large outputs
      timeout: 30_000, // 30 second timeout
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err: any) {
    // execFile throws on non-zero exit codes
    return {
      stdout: (err.stdout || "").toString().trim(),
      stderr: (err.stderr || "").toString().trim(),
      exitCode: err.code ?? 1,
    };
  }
}

/**
 * Check if hcom CLI is available on PATH.
 */
export async function isHcomAvailable(): Promise<boolean> {
  const result = await execHcom(["--version"]);
  return result.exitCode === 0;
}

/**
 * Parse JSON output from hcom commands that support --json.
 * Returns null if parsing fails.
 */
export function parseHcomJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}