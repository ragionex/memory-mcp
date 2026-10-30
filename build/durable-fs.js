import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
export function isMissing(error) {
    return error?.code === "ENOENT";
}
export function syncDirectory(directory) {
    if (process.platform === "win32")
        return;
    const fd = fs.openSync(directory, "r");
    try {
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
}
export function writeNewPrivateFile(file, data) {
    const fd = fs.openSync(file, "wx", 0o600);
    try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
}
const LOCK_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const LOCK_WAIT_MS = 60_000;
async function renameWaitingOutLocks(from, to) {
    const started = Date.now();
    for (let pause = 0;; pause = Math.min(pause + 10, 100)) {
        try {
            fs.renameSync(from, to);
            return;
        }
        catch (error) {
            const code = error?.code ?? "";
            if (process.platform !== "win32" || !LOCK_CODES.has(code) || Date.now() - started >= LOCK_WAIT_MS)
                throw error;
        }
        await sleep(pause);
    }
}
export async function replaceFile(target, data) {
    let real = target;
    let mode;
    try {
        real = fs.realpathSync(target);
        mode = fs.statSync(real).mode & 0o777;
    }
    catch (error) {
        if (!isMissing(error))
            throw error;
    }
    const temporary = `${real}.ragionex-tmp-${randomUUID()}`;
    try {
        const fd = fs.openSync(temporary, "wx", mode ?? 0o666);
        try {
            if (mode !== undefined)
                fs.fchmodSync(fd, mode);
            fs.writeFileSync(fd, data, "utf-8");
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        await renameWaitingOutLocks(temporary, real);
    }
    catch (error) {
        try {
            fs.rmSync(temporary, { force: true });
        }
        catch {
        }
        throw error;
    }
    syncDirectory(dirname(real));
}
