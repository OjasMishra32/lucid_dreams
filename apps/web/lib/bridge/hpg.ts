import "server-only";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { REPO } from "./dreams";

const run = promisify(execFile);

/**
 * A run's prepped.mp4 (the clip cropped around the person, from startS), which stays on HiPerGator after export.
 * Goes through lucid_runner's own rsync and SSH connection, so it only works where the runner does (Ojasva's Mac).
 */
export async function fetchPrepped(id: string, dest: string): Promise<boolean> {
  if (!/^[\w.-]+$/.test(id)) return false;
  const code = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(join(REPO, "pipeline", "runner"))})`,
    "import lucid_runner as r",
    `r.rsync(f"{r.HOST}:{r.REMOTE}/runs/${id}/prepped.mp4", ${JSON.stringify(dest)})`,
  ].join("\n");
  try {
    await run(process.env.PYTHON ?? "python3", ["-c", code], { cwd: REPO, timeout: 300_000 });
    return existsSync(dest);
  } catch {
    return false;
  }
}
