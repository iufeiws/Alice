const childProcess = await import("node:child_process");

export type ProcessExecResult = {
  stdout: string;
  stderr: string;
};

export function execFile(command: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv = {}): Promise<ProcessExecResult> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      child.kill("SIGTERM");
      const detail = [
        `process timed out after ${timeoutMs}ms: ${command}`,
        stderr.trim() ? `stderr: ${stderr.trim()}` : "",
        stdout.trim() ? `stdout/events: ${stdout.trim()}` : ""
      ].filter(Boolean).join("\n");
      reject(new Error(detail));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        const detail = [`process exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}: ${command}`, stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
        reject(new Error(detail || "process execution failed"));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end();
  });
}
