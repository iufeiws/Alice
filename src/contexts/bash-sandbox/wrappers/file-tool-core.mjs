import { spawnSync } from "node:child_process";
import { createReadStream, fstat } from "node:fs";
import fs from "node:fs";
import { readFile, readdir, realpath, stat as fsStat } from "node:fs/promises";
import path from "node:path";

const FAST_PATH_MAX_SIZE = 10 * 1024 * 1024;
const FILE_NOT_FOUND_CWD_NOTE = "Note: your current working directory is";
const THIN_SPACE = String.fromCharCode(8239);
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024;
const DEFAULT_HEAD_LIMIT = 250;
const MAX_BUFFER_SIZE = 20_000_000;

const LEFT_SINGLE_CURLY_QUOTE = "‘";
const RIGHT_SINGLE_CURLY_QUOTE = "’";
const LEFT_DOUBLE_CURLY_QUOTE = "“";
const RIGHT_DOUBLE_CURLY_QUOTE = "”";
const VCS_DIRECTORIES_TO_EXCLUDE = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

const BLOCKED_DEVICE_PATHS = new Set([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/full",
  "/dev/stdin",
  "/dev/tty",
  "/dev/console",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/fd/0",
  "/dev/fd/1",
  "/dev/fd/2"
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff", ".tif",
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".wmv", ".flv", ".m4v", ".mpeg", ".mpg",
  ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".wma", ".aiff", ".opus",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".xz", ".z", ".tgz", ".iso",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".obj", ".lib", ".app", ".msi", ".deb", ".rpm",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".pyc", ".pyo", ".class", ".jar", ".war", ".ear", ".node", ".wasm", ".rlib",
  ".sqlite", ".sqlite3", ".db", ".mdb", ".idx",
  ".psd", ".ai", ".eps", ".sketch", ".fig", ".xd", ".blend", ".3ds", ".max",
  ".swf", ".fla", ".lockb", ".dat", ".data"
]);

class FileTooLargeError extends Error {
  constructor(sizeInBytes, maxSizeBytes) {
    super(
      `File content (${formatFileSize(sizeInBytes)}) exceeds maximum allowed size (${formatFileSize(maxSizeBytes)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`
    );
    this.name = "FileTooLargeError";
  }
}

export async function runReadTool(payload) {
  const { filePath, offset, limit, maxSizeBytes } = validateReadInput(payload);
  if (payload.operation === "mtime") {
    return { type: "mtime", file: { filePath }, mtimeMs: await getFileModificationTimeAsync(filePath) };
  }
  if (payload.operation === "base64") {
    const bytes = await readBinaryFile(filePath, maxSizeBytes);
    return {
      type: "base64",
      file: { filePath, content: bytes.toString("base64") },
      meta: {
        mtimeMs: (await fsStat(filePath)).mtimeMs,
        totalBytes: bytes.length,
        readBytes: bytes.length
      }
    };
  }
  const lineOffset = offset === 0 ? 0 : offset - 1;
  let resolvedFilePath = filePath;
  let result;
  try {
    result = await readFileInRange(resolvedFilePath, lineOffset, limit, limit === undefined ? maxSizeBytes : undefined);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const altPath = getAlternateScreenshotPath(filePath);
    if (!altPath) throw error;
    resolvedFilePath = altPath;
    result = await readFileInRange(resolvedFilePath, lineOffset, limit, limit === undefined ? maxSizeBytes : undefined);
  }
  return {
    type: "text",
    file: {
      filePath,
      content: result.content,
      numLines: result.lineCount,
      startLine: offset,
      totalLines: result.totalLines
    },
    meta: {
      mtimeMs: result.mtimeMs,
      totalBytes: result.totalBytes,
      readBytes: result.readBytes
    }
  };
}

export function runEditTool(payload) {
  const filePath = normalizeContainerPath(payload.file_path, "file_path");
  const oldString = typeof payload.old_string === "string" ? payload.old_string : undefined;
  const newString = typeof payload.new_string === "string" ? payload.new_string : undefined;
  if (oldString === undefined) throw new Error("old_string is required");
  if (newString === undefined) throw new Error("new_string is required");
  if (oldString === newString) throw new Error("No changes to make: old_string and new_string are exactly the same.");
  if (filePath.endsWith(".ipynb")) throw new Error("File is a Jupyter Notebook. Use the NotebookEdit to edit this file.");
  assertAllowed(filePath, allowedRoots(payload));

  const { content: originalFileContents, fileExists, encoding, lineEndings } = readFileForEdit(filePath);
  if (!fileExists && oldString !== "") throw new Error(fileNotFoundMessage(filePath, typeof payload.cwd === "string" ? payload.cwd : "/"));
  if (fileExists && oldString === "" && originalFileContents.trim() !== "") throw new Error("Cannot create new file - file already exists.");
  validateReadState(filePath, payload.read_state, originalFileContents, fileExists);

  const actualOldString = findActualString(originalFileContents, oldString);
  if (oldString !== "" && !actualOldString) throw new Error(`String to replace not found in file.\nString: ${oldString}`);
  const matches = actualOldString ? originalFileContents.split(actualOldString).length - 1 : 0;
  if (matches > 1 && payload.replace_all !== true) {
    throw new Error(`Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`);
  }

  fs.mkdirSync(path.posix.dirname(filePath), { recursive: true });
  const actualNewString = preserveQuoteStyle(oldString, actualOldString || oldString, newString);
  const updatedFile = oldString === "" ? newString : applyEditToFile(originalFileContents, actualOldString || oldString, actualNewString, payload.replace_all === true);
  if (updatedFile === originalFileContents) throw new Error("Original and edited file match exactly. Failed to apply edit.");
  writeTextContent(filePath, updatedFile, encoding, lineEndings);
  return { type: "edit", file: { filePath, content: updatedFile }, meta: { mtimeMs: getFileModificationTime(filePath) }, message: "OK" };
}

export function runGlobTool(payload) {
  const startedAt = Date.now();
  const pattern = typeof payload.pattern === "string" ? payload.pattern : undefined;
  if (!pattern) throw new Error("pattern is required");
  const cwd = normalizeContainerPath(typeof payload.cwd === "string" ? payload.cwd : process.cwd(), "cwd");
  let searchDir = payload.path === undefined ? cwd : normalizeContainerPath(payload.path, "path");
  let searchPattern = pattern;

  if (path.posix.isAbsolute(pattern)) {
    const extracted = extractGlobBaseDirectory(pattern);
    if (extracted.baseDir) {
      searchDir = path.posix.normalize(extracted.baseDir);
      searchPattern = extracted.relativePattern;
    }
  }
  assertAllowed(searchDir, allowedRoots(payload));
  const stat = fs.statSync(searchDir);
  if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${searchDir}`);

  const noIgnore = isEnvTruthy(process.env.CLAUDE_CODE_GLOB_NO_IGNORE || "true");
  const hidden = isEnvTruthy(process.env.CLAUDE_CODE_GLOB_HIDDEN || "true");
  const allPaths = ripGrep([
    "--files",
    "--glob",
    searchPattern,
    "--sort=modified",
    ...(noIgnore ? ["--no-ignore"] : []),
    ...(hidden ? ["--hidden"] : [])
  ], searchDir);
  const absolutePaths = allPaths.map((entry) => path.posix.isAbsolute(entry) ? entry : path.posix.join(searchDir, entry.replace(/^\.\//, "")));
  const limit = numberValue(payload.limit) ?? 100;
  const offset = numberValue(payload.offset) ?? 0;
  const filenames = absolutePaths.slice(offset, offset + limit).map((entry) => toRelativePath(entry, cwd));
  const truncated = absolutePaths.length > offset + limit;
  const content = filenames.length === 0
    ? "No files found"
    : [...filenames, ...(truncated ? ["(Results are truncated. Consider using a more specific path or pattern.)"] : [])].join("\n");
  return { type: "glob", durationMs: Date.now() - startedAt, numFiles: filenames.length, filenames, truncated, content };
}

export function runGrepTool(payload) {
  const pattern = typeof payload.pattern === "string" ? payload.pattern : undefined;
  if (!pattern) throw new Error("pattern is required");
  const cwd = normalizeContainerPath(typeof payload.cwd === "string" ? payload.cwd : process.cwd(), "cwd");
  const absolutePath = payload.path === undefined ? cwd : normalizeContainerPathWithCwd(payload.path, cwd, "path");
  assertAllowed(absolutePath, allowedRoots(payload));
  try {
    fs.statSync(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Path does not exist: ${payload.path ?? absolutePath}. Note: your current working directory is ${cwd}.`);
    throw error;
  }

  const outputMode = typeof payload.output_mode === "string" ? payload.output_mode : "files_with_matches";
  if (!["content", "files_with_matches", "count"].includes(outputMode)) throw new Error("unsupported output_mode");
  const args = ["--hidden"];
  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) args.push("--glob", `!${dir}`);
  args.push("--max-columns", "500");
  if (booleanValue(payload.multiline, false)) args.push("-U", "--multiline-dotall");
  if (booleanValue(payload["-i"], false)) args.push("-i");
  if (outputMode === "files_with_matches") args.push("-l");
  else if (outputMode === "count") args.push("-c");
  if (booleanValue(payload["-n"], true) && outputMode === "content") args.push("-n");
  addGrepContextArgs(args, payload, outputMode);
  if (pattern.startsWith("-")) args.push("-e", pattern);
  else args.push(pattern);
  if (typeof payload.type === "string" && payload.type) args.push("--type", payload.type);
  if (typeof payload.glob === "string" && payload.glob) for (const globPattern of splitGlobPatterns(payload.glob)) args.push("--glob", globPattern);

  const results = ripGrep(args, absolutePath);
  const headLimit = numberValue(payload.head_limit);
  const offset = numberValue(payload.offset) ?? 0;
  if (outputMode === "content") return grepContentOutput(results, headLimit, offset, cwd);
  if (outputMode === "count") return grepCountOutput(results, headLimit, offset, cwd);
  return grepFilesOutput(results, headLimit, offset, cwd);
}

export async function runToolMain(run) {
  try {
    const payload = JSON.parse(process.argv[2] || "{}");
    const result = await run(payload);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    if (error?.code === "ENOENT") {
      const payload = JSON.parse(process.argv[2] || "{}");
      const cwd = typeof payload.cwd === "string" ? payload.cwd : "/";
      process.stderr.write(`${await fileNotFoundMessageAsync(String(payload.file_path || payload.path || ""), cwd)}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(1);
  }
}

async function readFileInRange(filePath, offset = 0, maxLines, maxBytes, signal, options) {
  signal?.throwIfAborted();
  const truncateOnByteLimit = options?.truncateOnByteLimit ?? false;
  const stats = await fsStat(filePath);

  if (stats.isDirectory()) {
    throw new Error(`EISDIR: illegal operation on a directory, read '${filePath}'`);
  }

  if (stats.isFile() && stats.size < FAST_PATH_MAX_SIZE) {
    if (!truncateOnByteLimit && maxBytes !== undefined && stats.size > maxBytes) {
      throw new FileTooLargeError(stats.size, maxBytes);
    }

    const text = await readFile(filePath, { encoding: "utf8", signal });
    return readFileInRangeFast(
      text,
      stats.mtimeMs,
      offset,
      maxLines,
      truncateOnByteLimit ? maxBytes : undefined
    );
  }

  return readFileInRangeStreaming(filePath, offset, maxLines, maxBytes, truncateOnByteLimit, signal);
}

async function readBinaryFile(filePath, maxBytes) {
  const stats = await fsStat(filePath);
  if (stats.isDirectory()) throw new Error(`EISDIR: illegal operation on a directory, read '${filePath}'`);
  if (maxBytes !== undefined && stats.size > maxBytes) throw new FileTooLargeError(stats.size, maxBytes);
  return await readFile(filePath);
}

function readFileInRangeFast(raw, mtimeMs, offset, maxLines, truncateAtBytes) {
  const endLine = maxLines !== undefined ? offset + maxLines : Infinity;
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const selectedLines = [];
  let lineIndex = 0;
  let startPos = 0;
  let newlinePos;
  let selectedBytes = 0;
  let truncatedByBytes = false;

  function tryPush(line) {
    if (truncateAtBytes !== undefined) {
      const sep = selectedLines.length > 0 ? 1 : 0;
      const nextBytes = selectedBytes + sep + Buffer.byteLength(line);
      if (nextBytes > truncateAtBytes) {
        truncatedByBytes = true;
        return false;
      }
      selectedBytes = nextBytes;
    }
    selectedLines.push(line);
    return true;
  }

  while ((newlinePos = text.indexOf("\n", startPos)) !== -1) {
    if (lineIndex >= offset && lineIndex < endLine && !truncatedByBytes) {
      let line = text.slice(startPos, newlinePos);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      tryPush(line);
    }
    lineIndex++;
    startPos = newlinePos + 1;
  }

  if (text.length > 0) {
    if (lineIndex >= offset && lineIndex < endLine && !truncatedByBytes) {
      let line = text.slice(startPos);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      tryPush(line);
    }
    lineIndex++;
  }

  const content = selectedLines.join("\n");
  return {
    content,
    lineCount: selectedLines.length,
    totalLines: lineIndex,
    totalBytes: Buffer.byteLength(text, "utf8"),
    readBytes: Buffer.byteLength(content, "utf8"),
    mtimeMs,
    ...(truncatedByBytes ? { truncatedByBytes: true } : {})
  };
}

function streamOnOpen(fd) {
  fstat(fd, (err, stats) => {
    this.resolveMtime(err ? 0 : stats.mtimeMs);
  });
}

function streamOnData(chunk) {
  if (this.isFirstChunk) {
    this.isFirstChunk = false;
    if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
  }

  this.totalBytesRead += Buffer.byteLength(chunk);
  if (!this.truncateOnByteLimit && this.maxBytes !== undefined && this.totalBytesRead > this.maxBytes) {
    this.stream.destroy(new FileTooLargeError(this.totalBytesRead, this.maxBytes));
    return;
  }

  const data = this.partial.length > 0 ? this.partial + chunk : chunk;
  this.partial = "";

  let startPos = 0;
  let newlinePos;
  while ((newlinePos = data.indexOf("\n", startPos)) !== -1) {
    if (this.currentLineIndex >= this.offset && this.currentLineIndex < this.endLine) {
      let line = data.slice(startPos, newlinePos);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
        const sep = this.selectedLines.length > 0 ? 1 : 0;
        const nextBytes = this.selectedBytes + sep + Buffer.byteLength(line);
        if (nextBytes > this.maxBytes) {
          this.truncatedByBytes = true;
          this.endLine = this.currentLineIndex;
        } else {
          this.selectedBytes = nextBytes;
          this.selectedLines.push(line);
        }
      } else {
        this.selectedLines.push(line);
      }
    }
    this.currentLineIndex++;
    startPos = newlinePos + 1;
  }

  if (startPos < data.length) {
    if (this.currentLineIndex >= this.offset && this.currentLineIndex < this.endLine) {
      const fragment = data.slice(startPos);
      if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
        const sep = this.selectedLines.length > 0 ? 1 : 0;
        const fragBytes = this.selectedBytes + sep + Buffer.byteLength(fragment);
        if (fragBytes > this.maxBytes) {
          this.truncatedByBytes = true;
          this.endLine = this.currentLineIndex;
          return;
        }
      }
      this.partial = fragment;
    }
  }
}

function streamOnEnd() {
  if (this.totalBytesRead > 0 || this.partial.length > 0) {
    let line = this.partial;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (this.currentLineIndex >= this.offset && this.currentLineIndex < this.endLine) {
      if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
        const sep = this.selectedLines.length > 0 ? 1 : 0;
        const nextBytes = this.selectedBytes + sep + Buffer.byteLength(line);
        if (nextBytes > this.maxBytes) {
          this.truncatedByBytes = true;
        } else {
          this.selectedLines.push(line);
        }
      } else {
        this.selectedLines.push(line);
      }
    }
    this.currentLineIndex++;
  }

  const content = this.selectedLines.join("\n");
  const truncated = this.truncatedByBytes;
  this.mtimeReady.then((mtimeMs) => {
    this.resolve({
      content,
      lineCount: this.selectedLines.length,
      totalLines: this.currentLineIndex,
      totalBytes: this.totalBytesRead,
      readBytes: Buffer.byteLength(content, "utf8"),
      mtimeMs,
      ...(truncated ? { truncatedByBytes: true } : {})
    });
  });
}

function readFileInRangeStreaming(filePath, offset, maxLines, maxBytes, truncateOnByteLimit, signal) {
  return new Promise((resolve, reject) => {
    const state = {
      stream: createReadStream(filePath, {
        encoding: "utf8",
        highWaterMark: 512 * 1024,
        ...(signal ? { signal } : undefined)
      }),
      offset,
      endLine: maxLines !== undefined ? offset + maxLines : Infinity,
      maxBytes,
      truncateOnByteLimit,
      resolve,
      totalBytesRead: 0,
      selectedBytes: 0,
      truncatedByBytes: false,
      currentLineIndex: 0,
      selectedLines: [],
      partial: "",
      isFirstChunk: true,
      resolveMtime: () => {},
      mtimeReady: null
    };
    state.mtimeReady = new Promise((r) => {
      state.resolveMtime = r;
    });

    state.stream.once("open", streamOnOpen.bind(state));
    state.stream.on("data", streamOnData.bind(state));
    state.stream.once("end", streamOnEnd.bind(state));
    state.stream.once("error", reject);
  });
}

function validateReadInput(payload) {
  const filePath = normalizeContainerPath(payload.file_path, "file_path");
  assertAllowed(filePath, allowedRoots(payload));
  if (isBlockedDevicePath(filePath)) {
    throw new Error(`Cannot read '${filePath}': this device file would block or produce infinite output.`);
  }
  const ext = path.posix.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext) && payload.operation !== "base64") {
    throw new Error(`This tool cannot read binary files. The file appears to be a binary ${ext} file. Please use appropriate tools for binary file analysis.`);
  }
  const offset = numberValue(payload.offset) ?? 1;
  const limit = numberValue(payload.limit);
  const maxSizeBytes = numberValue(payload.max_size_bytes);
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error("limit must be a positive integer");
  if (maxSizeBytes !== undefined && (!Number.isInteger(maxSizeBytes) || maxSizeBytes <= 0)) throw new Error("max_size_bytes must be a positive integer");
  return { filePath, offset, limit, maxSizeBytes };
}

function normalizeQuotes(str) {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

function findActualString(fileContent, searchString) {
  if (fileContent.includes(searchString)) return searchString;
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);
  const searchIndex = normalizedFile.indexOf(normalizedSearch);
  return searchIndex === -1 ? null : fileContent.substring(searchIndex, searchIndex + searchString.length);
}

function preserveQuoteStyle(oldString, actualOldString, newString) {
  if (oldString === actualOldString) return newString;
  let result = newString;
  if (actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) || actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE)) result = applyCurlyDoubleQuotes(result);
  if (actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) || actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE)) result = applyCurlySingleQuotes(result);
  return result;
}

function isOpeningContext(chars, index) {
  if (index === 0) return true;
  const prev = chars[index - 1];
  return prev === " " || prev === "\t" || prev === "\n" || prev === "\r" || prev === "(" || prev === "[" || prev === "{" || prev === "—" || prev === "–";
}

function applyCurlyDoubleQuotes(str) {
  const chars = [...str];
  return chars.map((char, index) => char === '"' ? (isOpeningContext(chars, index) ? LEFT_DOUBLE_CURLY_QUOTE : RIGHT_DOUBLE_CURLY_QUOTE) : char).join("");
}

function applyCurlySingleQuotes(str) {
  const chars = [...str];
  const result = [];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (char !== "'") {
      result.push(char);
      continue;
    }
    const prev = index > 0 ? chars[index - 1] : undefined;
    const next = index < chars.length - 1 ? chars[index + 1] : undefined;
    if (prev !== undefined && next !== undefined && /\p{L}/u.test(prev) && /\p{L}/u.test(next)) result.push(RIGHT_SINGLE_CURLY_QUOTE);
    else result.push(isOpeningContext(chars, index) ? LEFT_SINGLE_CURLY_QUOTE : RIGHT_SINGLE_CURLY_QUOTE);
  }
  return result.join("");
}

function applyEditToFile(originalContent, oldString, newString, replaceAll = false) {
  const f = replaceAll
    ? (content, search, replace) => content.replaceAll(search, () => replace)
    : (content, search, replace) => content.replace(search, () => replace);

  if (newString !== "") return f(originalContent, oldString, newString);

  const stripTrailingNewline = !oldString.endsWith("\n") && originalContent.includes(`${oldString}\n`);
  if (stripTrailingNewline) return f(originalContent, `${oldString}\n`, newString);
  return f(originalContent, oldString, newString);
}

function readFileForEdit(filePath) {
  const stat = statOrUndefined(filePath);
  if (!stat) return { content: "", fileExists: false, encoding: "utf8", lineEndings: "LF" };
  if (stat.size > MAX_EDIT_FILE_SIZE) throw new Error(`File is too large to edit (${formatFileSize(stat.size)}). Maximum editable file size is ${formatFileSize(MAX_EDIT_FILE_SIZE)}.`);
  const buffer = readAllBytes(filePath);
  const encoding = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe ? "utf16le" : "utf8";
  const raw = buffer.toString(encoding);
  return { content: raw.replaceAll("\r\n", "\n"), fileExists: true, encoding, lineEndings: detectLineEndings(raw) };
}

function writeTextContent(filePath, content, encoding, endings) {
  const toWrite = endings === "CRLF" ? content.replaceAll("\r\n", "\n").split("\n").join("\r\n") : content;
  const fd = fs.openSync(filePath, "w");
  try {
    fs.writeSync(fd, toWrite, 0, encoding);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function validateReadState(filePath, readState, originalFileContents, fileExists) {
  if (!fileExists) return;
  if (!readState || readState.isPartialView) throw new Error("File has not been read yet. Read it first before writing to it.");
  const lastWriteTime = getFileModificationTime(filePath);
  if (lastWriteTime <= readState.timestamp) return;
  const isFullRead = readState.offset === undefined && readState.limit === undefined;
  if (isFullRead && originalFileContents === readState.content) return;
  throw new Error("File has been unexpectedly modified. Read it again before attempting to write it.");
}

function readAllBytes(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
}

function detectLineEndings(raw) {
  let crlf = 0;
  let lf = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === "\n") {
      if (index > 0 && raw[index - 1] === "\r") crlf += 1;
      else lf += 1;
    }
  }
  return crlf > lf ? "CRLF" : "LF";
}

function extractGlobBaseDirectory(pattern) {
  const match = pattern.match(/[*?[{]/);
  if (!match || match.index === undefined) return { baseDir: path.posix.dirname(pattern), relativePattern: path.posix.basename(pattern) };
  const staticPrefix = pattern.slice(0, match.index);
  const lastSepIndex = staticPrefix.lastIndexOf("/");
  if (lastSepIndex === -1) return { baseDir: "", relativePattern: pattern };
  let baseDir = staticPrefix.slice(0, lastSepIndex);
  if (baseDir === "" && lastSepIndex === 0) baseDir = "/";
  return { baseDir, relativePattern: pattern.slice(lastSepIndex + 1) };
}

function ripGrep(args, target) {
  const result = spawnSync(rgCommand(), [...args, target], { encoding: "utf8", maxBuffer: MAX_BUFFER_SIZE });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.status}`);
  return result.stdout.trim()
    ? result.stdout.trim().split(/\r?\n/).map((line) => line.replace(/\r$/, "")).filter(Boolean)
    : [];
}

function grepContentOutput(results, headLimit, offset, cwd) {
  const limited = applyHeadLimit(results, headLimit, offset);
  const finalLines = limited.items.map((line) => {
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) return line;
    return `${toRelativePath(line.substring(0, colonIndex), cwd)}${line.substring(colonIndex)}`;
  });
  const limitInfo = formatLimitInfo(limited.appliedLimit, offset > 0 ? offset : undefined);
  const resultContent = finalLines.join("\n") || "No matches found";
  const content = limitInfo ? `${resultContent}\n\n[Showing results with pagination = ${limitInfo}]` : resultContent;
  return { type: "grep", mode: "content", numFiles: 0, filenames: [], content, numLines: finalLines.length };
}

function grepCountOutput(results, headLimit, offset, cwd) {
  const limited = applyHeadLimit(results, headLimit, offset);
  const finalLines = limited.items.map((line) => {
    const colonIndex = line.lastIndexOf(":");
    if (colonIndex <= 0) return line;
    return `${toRelativePath(line.substring(0, colonIndex), cwd)}${line.substring(colonIndex)}`;
  });
  let totalMatches = 0;
  let fileCount = 0;
  for (const line of finalLines) {
    const count = Number.parseInt(line.substring(line.lastIndexOf(":") + 1), 10);
    if (!Number.isNaN(count)) {
      totalMatches += count;
      fileCount += 1;
    }
  }
  const limitInfo = formatLimitInfo(limited.appliedLimit, offset > 0 ? offset : undefined);
  const summary = `\n\nFound ${totalMatches} total ${totalMatches === 1 ? "occurrence" : "occurrences"} across ${fileCount} ${fileCount === 1 ? "file" : "files"}.${limitInfo ? ` with pagination = ${limitInfo}` : ""}`;
  return { type: "grep", mode: "count", numFiles: fileCount, filenames: [], content: (finalLines.join("\n") || "No matches found") + summary, numMatches: totalMatches };
}

function grepFilesOutput(results, headLimit, offset, cwd) {
  const sortedMatches = results
    .map((entry) => [entry, statMtimeOrZero(entry)])
    .sort((a, b) => {
      if (process.env.NODE_ENV === "test") return a[0].localeCompare(b[0]);
      const timeComparison = b[1] - a[1];
      return timeComparison === 0 ? a[0].localeCompare(b[0]) : timeComparison;
    })
    .map((entry) => entry[0]);
  const limited = applyHeadLimit(sortedMatches, headLimit, offset);
  const filenames = limited.items.map((entry) => toRelativePath(entry, cwd));
  const limitInfo = formatLimitInfo(limited.appliedLimit, offset > 0 ? offset : undefined);
  const content = filenames.length === 0 ? "No files found" : `Found ${filenames.length} ${plural(filenames.length, "file")}${limitInfo ? ` ${limitInfo}` : ""}\n${filenames.join("\n")}`;
  return { type: "grep", mode: "files_with_matches", numFiles: filenames.length, filenames, content, ...(limited.appliedLimit !== undefined ? { appliedLimit: limited.appliedLimit } : {}), ...(offset > 0 ? { appliedOffset: offset } : {}) };
}

function addGrepContextArgs(args, payload, outputMode) {
  if (outputMode !== "content") return;
  const context = numberValue(payload.context);
  const contextC = numberValue(payload["-C"]);
  const before = numberValue(payload["-B"]);
  const after = numberValue(payload["-A"]);
  if (context !== undefined) args.push("-C", String(context));
  else if (contextC !== undefined) args.push("-C", String(contextC));
  else {
    if (before !== undefined) args.push("-B", String(before));
    if (after !== undefined) args.push("-A", String(after));
  }
}

function applyHeadLimit(items, limit, offset = 0) {
  if (limit === 0) return { items: items.slice(offset), appliedLimit: undefined };
  const effectiveLimit = limit ?? DEFAULT_HEAD_LIMIT;
  const sliced = items.slice(offset, offset + effectiveLimit);
  return { items: sliced, appliedLimit: items.length - offset > effectiveLimit ? effectiveLimit : undefined };
}

function formatLimitInfo(appliedLimit, appliedOffset) {
  const parts = [];
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`);
  if (appliedOffset) parts.push(`offset: ${appliedOffset}`);
  return parts.join(", ");
}

function splitGlobPatterns(glob) {
  const patterns = [];
  for (const raw of glob.split(/\s+/)) {
    if (!raw) continue;
    if (raw.includes("{") && raw.includes("}")) patterns.push(raw);
    else patterns.push(...raw.split(",").filter(Boolean));
  }
  return patterns;
}

function normalizeContainerPath(value, name) {
  if (typeof value !== "string" || !value.trim() || !value.startsWith("/")) throw new Error(`${name} must be an absolute sandbox path`);
  return path.posix.normalize(value);
}

function normalizeContainerPathWithCwd(value, cwd, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return path.posix.normalize(value.startsWith("/") ? value : path.posix.join(cwd, value));
}

function allowedRoots(payload) {
  return Array.isArray(payload.allowed_roots) ? payload.allowed_roots.map((root) => normalizeContainerPath(root, "root")) : [];
}

function isSameOrInside(value, root) {
  const cleanRoot = root.replace(/\/+$/, "") || "/";
  return value === cleanRoot || value.startsWith(`${cleanRoot}/`);
}

function assertAllowed(value, roots) {
  if (!roots.some((root) => isSameOrInside(value, root))) throw new Error(`path is outside configured sandbox paths: ${value}`);
}

function isBlockedDevicePath(filePath) {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true;
  return filePath.startsWith("/proc/") && (filePath.endsWith("/fd/0") || filePath.endsWith("/fd/1") || filePath.endsWith("/fd/2"));
}

function getAlternateScreenshotPath(filePath) {
  const filename = path.posix.basename(filePath);
  const match = filename.match(/^(.+)([ \u202F])(AM|PM)(\.png)$/);
  if (!match) return undefined;
  const currentSpace = match[2];
  const alternateSpace = currentSpace === " " ? THIN_SPACE : " ";
  return filePath.replace(`${currentSpace}${match[3]}${match[4]}`, `${alternateSpace}${match[3]}${match[4]}`);
}

async function fileNotFoundMessageAsync(filePath, cwd) {
  const cwdSuggestion = await suggestPathUnderCwd(filePath, cwd);
  const similarFilename = await findSimilarFile(filePath);
  let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${cwd}.`;
  if (cwdSuggestion) message += ` Did you mean ${cwdSuggestion}?`;
  else if (similarFilename) message += ` Did you mean ${similarFilename}?`;
  return message;
}

function fileNotFoundMessage(filePath, cwd) {
  const similar = findSimilarFileSync(filePath);
  return `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${cwd}.${similar ? ` Did you mean ${similar}?` : ""}`;
}

async function findSimilarFile(filePath) {
  try {
    const dir = path.posix.dirname(filePath);
    const fileBaseName = path.posix.basename(filePath, path.posix.extname(filePath));
    const files = await readdir(dir, { withFileTypes: true });
    const similar = files.find((file) =>
      path.posix.basename(file.name, path.posix.extname(file.name)) === fileBaseName &&
      path.posix.join(dir, file.name) !== filePath
    );
    return similar?.name;
  } catch {
    return undefined;
  }
}

function findSimilarFileSync(filePath) {
  const dir = path.posix.dirname(filePath);
  const base = path.posix.basename(filePath, path.posix.extname(filePath));
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .find((entry) => path.posix.basename(entry.name, path.posix.extname(entry.name)) === base && path.posix.join(dir, entry.name) !== filePath)
      ?.name;
  } catch {
    return undefined;
  }
}

async function suggestPathUnderCwd(requestedPath, cwd) {
  const cwdParent = path.posix.dirname(cwd);
  let resolvedPath = requestedPath;
  try {
    const resolvedDir = await realpath(path.posix.dirname(requestedPath));
    resolvedPath = path.posix.join(resolvedDir, path.posix.basename(requestedPath));
  } catch {
    // Parent directory does not exist, use the original path.
  }
  const cwdParentPrefix = cwdParent === "/" ? "/" : `${cwdParent}/`;
  if (!resolvedPath.startsWith(cwdParentPrefix) || resolvedPath.startsWith(`${cwd}/`) || resolvedPath === cwd) {
    return undefined;
  }
  const relFromParent = path.posix.relative(cwdParent, resolvedPath);
  const correctedPath = path.posix.join(cwd, relFromParent);
  try {
    await fsStat(correctedPath);
    return correctedPath;
  } catch {
    return undefined;
  }
}

function statOrUndefined(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function statMtimeOrZero(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs ?? 0;
  } catch {
    return 0;
  }
}

async function getFileModificationTimeAsync(filePath) {
  const stats = await fsStat(filePath);
  return Math.floor(stats.mtimeMs);
}

function getFileModificationTime(filePath) {
  return Math.floor(fs.statSync(filePath).mtimeMs);
}

function formatFileSize(size) {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)}MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

function toRelativePath(filePath, cwd) {
  const relative = path.posix.relative(cwd, filePath);
  if (!relative || relative.startsWith("..") || path.posix.isAbsolute(relative)) return filePath;
  return relative;
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function booleanValue(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(1|true|yes|on)$/i.test(value);
  return fallback;
}

function isEnvTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

function plural(count, noun) {
  return count === 1 ? noun : `${noun}s`;
}

function rgCommand() {
  return fs.existsSync("/usr/bin/rg") ? "/usr/bin/rg" : "rg";
}
