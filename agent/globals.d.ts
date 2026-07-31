// Frida runtime globals not declared by @types/frida-gum in this version.
// The agent runs inside frida-gum (not Node/DOM), which provides `console`.
declare const console: {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
