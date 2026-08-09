// Public programmatic interface for frida-labs — the single import surface.
// The CLI (src/cli) and TUI (src/tui) are thin frontends over this barrel;
// embedding agents should import from here rather than reaching into
// individual core modules. Import-safe: no module below performs work at
// import time.

export * from "./manifest.js";
export * from "./devices.js";
export * from "./machine.js";
export * from "./projects.js";
export * from "./actions.js";
export * from "./compile.js";
export * from "./lifecycle.js";
export * from "./session.js";
export * from "./commands.js";
export * from "./depcheck.js";
export * from "./scaffold.js";
export * from "./libref.js";
export * from "./protocol.js";
export * from "./processes.js";
export * from "./control.js";
export * from "./packages.js";
export * from "./instruments.js";
export * from "./acp.js";
export * from "./mcp.js";
export * from "./records.js";
