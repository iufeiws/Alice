import type { NetworkInterfaceInfo } from "node:os";

const fs = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");
const childProcess = await import("node:child_process");

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;

export function createApiHttpsOptions(input: { memoryRoot: string; appendLog: AppendLog }): { cert: Buffer; key: Buffer } {
  const explicitCertPath = process.env.API_HTTPS_CERT_PATH;
  const explicitKeyPath = process.env.API_HTTPS_KEY_PATH;
  if (explicitCertPath && explicitKeyPath) {
    return {
      cert: fs.readFileSync(explicitCertPath),
      key: fs.readFileSync(explicitKeyPath)
    };
  }

  const certDir = path.join(input.memoryRoot, "state", "api-https-cert");
  const certPath = path.join(certDir, "cert.pem");
  const keyPath = path.join(certDir, "key.pem");
  const altNames = apiHttpsCertificateAltNames(input.appendLog);
  fs.mkdirSync(certDir, { recursive: true });
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath) || !certificateMatchesAltNames(certPath, altNames)) {
    childProcess.execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey", "rsa:2048",
      "-nodes",
      "-keyout", keyPath,
      "-out", certPath,
      "-days", "30",
      "-subj", "/CN=alice-api-lan",
      "-addext", `subjectAltName=${altNames.join(",")}`
    ], { stdio: "ignore" });
  }
  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath)
  };
}

export function localLanAddress(appendLog: AppendLog): string | undefined {
  for (const entries of Object.values(safeNetworkInterfaces(appendLog))) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      return entry.address;
    }
  }
  return undefined;
}

function apiHttpsCertificateAltNames(appendLog: AppendLog): string[] {
  const names = new Set(["DNS:localhost", "IP:127.0.0.1"]);
  const hostname = os.hostname();
  if (hostname) names.add(`DNS:${hostname}`);
  for (const entries of Object.values(safeNetworkInterfaces(appendLog))) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      names.add(`IP:${entry.address}`);
    }
  }
  return [...names];
}

function certificateMatchesAltNames(certPath: string, altNames: string[]): boolean {
  try {
    const output = childProcess.execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-ext", "subjectAltName"], { encoding: "utf8" });
    return altNames.every((name) => output.includes(name.replace(/^IP:/, "IP Address:")));
  } catch {
    return false;
  }
}

function safeNetworkInterfaces(appendLog: AppendLog): NodeJS.Dict<NetworkInterfaceInfo[]> {
  try {
    return os.networkInterfaces();
  } catch (error) {
    appendLog("warn", `network interfaces unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}
