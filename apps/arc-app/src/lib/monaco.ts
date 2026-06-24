const EXTENSION_TO_MONACO: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mts: "typescript",
  mjs: "javascript",
  cts: "typescript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  md: "markdown",
  mdx: "markdown",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  svg: "xml",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  toml: "toml",
  ini: "ini",
  r: "r",
  lua: "lua",
  dart: "dart",
  scala: "scala",
  zig: "zig",
};

/**
 * Disable TS/JS language-service diagnostics for all models.
 * Editors in this app are read-only — they need syntax highlighting
 * (tokenizer) but not type-checking (language service).
 * Prevents "Could not find source file" errors from the TS worker
 * on inmemory:// model URIs.
 *
 * Safe to call multiple times — `setDiagnosticsOptions` is idempotent.
 */
export function disableMonacoDiagnostics(monaco: {
  languages: {
    typescript: {
      typescriptDefaults: { setDiagnosticsOptions: (opts: Record<string, boolean>) => void };
      javascriptDefaults: { setDiagnosticsOptions: (opts: Record<string, boolean>) => void };
    };
  };
}): void {
  const diagnosticsOff = {
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
  };
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(diagnosticsOff);
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(diagnosticsOff);
}

export function getMonacoLanguageFromPath(filePath: string): string {
  const fileName = filePath.split("/").pop() ?? "";
  const lower = fileName.toLowerCase();

  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile" || lower === "gnumakefile") return "plaintext";
  if (lower === ".env" || lower.startsWith(".env.")) return "shell";

  const ext = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : undefined;
  if (ext && ext in EXTENSION_TO_MONACO) return EXTENSION_TO_MONACO[ext];
  return "plaintext";
}
