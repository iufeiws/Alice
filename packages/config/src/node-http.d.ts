declare module "node:http" {
  const http: {
    createServer(handler: (request: any, response: any) => void | Promise<void>): {
      listen(port: number, host: string, callback?: () => void): void;
      close(callback?: () => void): void;
    };
  };

  export = http;
}

declare module "node:fs" {
  const fs: {
    existsSync(path: string): boolean;
    readFileSync(path: string, encoding: "utf8"): string;
    readFileSync(path: string): any;
    writeFileSync(path: string, data: string | any): void;
    mkdirSync(path: string, options: { recursive: boolean }): void;
    createReadStream(path: string): any;
    appendFileSync(path: string, data: string): void;
    readdirSync(path: string): string[];
    rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
    renameSync(oldPath: string, newPath: string): void;
    statSync(path: string): { isFile(): boolean; size: number };
  };

  export = fs;
}

declare module "node:path" {
  const path: {
    dirname(path: string): string;
    join(...parts: string[]): string;
    basename(path: string): string;
    extname(path: string): string;
    isAbsolute(path: string): boolean;
    normalize(path: string): string;
    relative(from: string, to: string): string;
    resolve(...paths: string[]): string;
  };

  export = path;
}

declare module "node:sqlite" {
  export const DatabaseSync: new (path: string) => any;
}

declare module "node:test" {
  export function test(name: string, fn: () => unknown | Promise<unknown>): void;
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    rejects(fn: () => unknown | Promise<unknown>, expectation?: unknown, message?: string): Promise<void>;
    throws(fn: () => unknown, expectation?: unknown, message?: string): void;
  };
  export default assert;
}
