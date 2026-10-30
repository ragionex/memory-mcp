/**
 * Durable file writes shared by the offline queue and the installer.
 */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Creates a private file that must not exist yet; its bytes are flushed before this returns. */
export function writeNewPrivateFile(file: string, data: string | Buffer): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Windows refuses to replace a file while another program holds it or the new copy
// open; antivirus scanners do this to fresh files for a moment. Like npm's graceful-fs,
// wait such a lock out with growing pauses of at most 100 ms, for about a minute.
const LOCK_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const LOCK_WAIT_MS = 60_000;

async function renameWaitingOutLocks(from: string, to: string): Promise<void> {
  const started = Date.now();
  for (let pause = 0; ; pause = Math.min(pause + 10, 100)) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? "";
      if (process.platform !== "win32" || !LOCK_CODES.has(code) || Date.now() - started >= LOCK_WAIT_MS) throw error;
    }
    await sleep(pause);
  }
}

/**
 * Replaces a file the user owns so that readers and crashes see either the old
 * or the new bytes, never a truncated file. A symlink keeps pointing at its
 * target, and an existing file keeps its mode.
 */
export async function replaceFile(target: string, data: string): Promise<void> {
  let real = target;
  let mode: number | undefined;
  try {
    real = fs.realpathSync(target);
    mode = fs.statSync(real).mode & 0o777;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporary = `${real}.ragionex-tmp-${randomUUID()}`;
  try {
    const fd = fs.openSync(temporary, "wx", mode ?? 0o666);
    try {
      if (mode !== undefined) fs.fchmodSync(fd, mode);
      fs.writeFileSync(fd, data, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    await renameWaitingOutLocks(temporary, real);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // A copy a scanner still holds is left behind rather than hiding the real error.
    }
    throw error;
  }
  syncDirectory(dirname(real));
}
