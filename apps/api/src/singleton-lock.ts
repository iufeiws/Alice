const fs = await import("node:fs");
const path = await import("node:path");

const freshLockMs = 5_000;

export type SingletonLock = {
  path: string;
  release(): void;
};

export function acquireSingletonLock(root: string, name: string): SingletonLock {
  const lockPath = path.join(root, "state", `${name}.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockPath, { recursive: false });
      writeLockPid(lockPath);
      return {
        path: lockPath,
        release() {
          releaseLock(lockPath);
        }
      };
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      const pid = readLockPid(lockPath);
      if (pid !== undefined && isProcessAlive(pid)) {
        throw new Error(`service_already_running pid=${pid} lock=${lockPath}`);
      }
      if (pid === undefined && isLockFresh(lockPath)) {
        throw new Error(`service_already_running lock=${lockPath}`);
      }
      releaseLock(lockPath);
    }
  }
  throw new Error(`service_lock_unavailable lock=${lockPath}`);
}

function writeLockPid(lockPath: string): void {
  fs.writeFileSync(path.join(lockPath, "pid"), `${process.pid}\n`);
}

function readLockPid(lockPath: string): number | undefined {
  try {
    const value = Number(fs.readFileSync(path.join(lockPath, "pid"), "utf8").trim());
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isLockFresh(lockPath: string): boolean {
  try {
    return Date.now() - Number((fs.statSync(lockPath) as any).mtimeMs ?? 0) < freshLockMs;
  } catch {
    return false;
  }
}

function releaseLock(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // Process shutdown should not fail because lock cleanup failed.
  }
}

function isFileExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}
