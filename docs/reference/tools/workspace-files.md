# Workspace Files 工具

Workspace Files 提供一组面向本地 workspace 文件的 LLM 工具。当前实现位于 `src/capabilities/tools/workspace-files`，属于核心可复用工具能力，而不是外部业务 channel。

## 入口

源码入口：

```text
tools/workspace-files/src/index.ts
```

对外导出：

- `createWorkspaceFilesTools(deps)`：创建工具集合。
- `formatReadOutput(content, options)`：把文本格式化为带行号的 `Read` 输出。
- `WorkspaceVirtualFile`：虚拟文件接口。
- `WorkspaceFilesToolsDeps`：创建工具时的依赖。
- `WorkspaceFilesToolPlugin`：返回的工具集合类型，额外包含 `resolveFilePath` 和 `primeRead`。

默认根目录是 `process.cwd()`。调用方也可以通过 `deps.root` 固定 workspace 根目录。

## 工具列表

### Read

读取 workspace 内的单个文件。

输入：

- `file_path`：必填，必须是 workspace 相对路径。
- `offset`：可选，1-based 起始行号。
- `limit`：可选，最大读取行数，默认 `2000`。

行为：

- 只接受相对路径；绝对路径会报错。
- 路径解析后必须仍在 workspace 根目录内；`..` 逃逸会报错。
- 目标必须是普通文件。
- 输出使用类似 `cat -n` 的行号格式。
- 空文件返回 `File is empty.`。
- 大文件按 `offset` 和 `limit` 分页，未读完时提示下一个 offset。
- 每次成功读取后，会记录该文件的内容指纹，供 `Edit` 做并发保护。

### Edit

对 workspace 内文件做精确字符串替换。

输入：

- `file_path`：必填，必须是 workspace 相对路径。
- `old_string`：必填，要替换的精确文本。
- `new_string`：必填，替换后的文本。
- `replace_all`：可选，设为 `true` 时替换全部匹配。

行为：

- 文件必须先在同一工具实例中被 `Read` 读取，或由调用方先调用 `primeRead`。
- 如果文件自上次读取后发生变化，编辑会失败，避免覆盖外部改动。
- `old_string` 默认为必须恰好匹配一次。
- 如果匹配 0 次，返回具体诊断，包含可能的换行、空白或 Unicode 归一化差异。
- 如果匹配多次且没有 `replace_all`，返回错误并要求提供更多上下文。
- 只有空文件允许使用空 `old_string` 创建内容。
- 成功写入后会刷新该文件的内容指纹。

### Glob

按 glob pattern 查找 workspace 文件。

输入：

- `pattern`：必填，例如 `**/*.ts`。
- `path`：可选，workspace 相对目录；不传时从根目录查找。

行为：

- 支持 `**` 递归匹配。
- 支持一层 brace 展开，例如 `*.{json,yaml}`。
- `path` 必须解析为 workspace 内的目录。
- 遍历时跳过 `node_modules` 和 `.git`。
- 结果按文件修改时间倒序排序。
- 最多返回 `100` 条，超出时给出截断提示。

注意：`Glob` 自身不读取 `.gitignore`。

### Grep

通过 `rg` 搜索 workspace 文件内容。

输入：

- `pattern`：必填，传给 ripgrep 的正则。
- `path`：可选，workspace 相对文件或目录；不传时搜索根目录。
- `glob`：可选，传给 ripgrep 的 glob 过滤。
- `type`：可选，传给 ripgrep 的文件类型过滤，例如 `ts` 或 `js`。
- `output_mode`：可选，支持 `files_with_matches`、`content`、`count`，默认 `files_with_matches`。
- `multiline`：可选，启用 ripgrep multiline 和 dotall。

行为：

- `path` 必须留在 workspace 根目录内。
- 搜索目录时，如果根目录存在 `.gitignore`，会作为 ignore file 传给 `rg`，并把简单 ignore pattern 转成排除 glob。
- 直接搜索单个文件时使用 `--no-ignore`，因此可搜索被 ignore 的文件。
- `files_with_matches` 返回匹配文件。
- `content` 返回带行号的匹配行。
- `count` 返回每个文件的匹配数量。
- 无匹配时返回 `No matches found`。
- `rg` 不存在或非正常退出时返回具体错误。

## 路径和安全边界

所有文件路径都会经过统一解析：

```text
workspace-relative path -> path.resolve(root, file_path) -> path.relative(root, resolved)
```

如果传入绝对路径，或解析后位于 root 外部，工具会拒绝执行。这个边界同时适用于 `Read`、`Edit`、`Glob` 和 `Grep`。

工具只提供文件读取、精确文本编辑、文件查找和文本搜索，不提供删除、重命名、shell 执行或任意路径访问能力。

## 虚拟文件

`createWorkspaceFilesTools` 支持通过 `deps.virtualFiles` 注入虚拟文件：

```ts
type WorkspaceVirtualFile = {
  read(): string;
  write(content: string): void;
  version?(): string;
};
```

虚拟文件的 key 是解析后的绝对路径。读取和写入时，如果命中虚拟文件，就调用虚拟文件的 `read` / `write`，不会访问磁盘。`version()` 可用于提供外部版本号；没有版本号时，工具会对内容计算 SHA-256 指纹。

## 调用方约定

- `core/agent/src/memory.ts` 使用这个工具给记忆归纳流程提供文件读写能力。
- 测试位于 `tests/workspace-files-tools.test.ts`。
- `primeRead(filePath)` 可让调用方在不暴露一次 `Read` 工具调用的情况下预置编辑快照。
- `resolveFilePath(filePath)` 可复用同一套 workspace 路径解析规则。
