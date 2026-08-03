// Frida runtime globals not declared by @types/frida-gum in this version.
// The agent runs inside frida-gum (not Node/DOM), which provides `console`.
declare const console: {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
// frida-compile provides a CommonJS require at runtime; used for lazy bridge
// gates (objc/java) so module-eval stays side-effect free.
declare function require(id: string): unknown;
