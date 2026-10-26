/**
 * Durable file writes shared by the offline queue and the installer.
 */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

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

/**
 * Replaces a file the user owns so that readers and crashes see either the old
 * or the new bytes, never a truncated file. A symlink keeps pointing at its
 * target, and an existing file keeps its mode.
 */
export function replaceFile(target: string, data: string): void {
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
    fs.renameSync(temporary, real);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  syncDirectory(dirname(real));
}
