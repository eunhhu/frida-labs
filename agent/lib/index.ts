// frida-labs generic library — cross-game debugging utilities.
// Import in any target: `import { modules, exports, trace, ue } from "../../lib/index.js";`
//
// NOTE: the Unity/IL2CPP helpers are intentionally NOT re-exported here — importing
// this barrel eagerly runs UE reflection discovery, and pulling in the IL2CPP bridge
// would bloat/break non-Unity targets. Unity targets import "./il2cpp.js" directly.
export * as mem from "./mem.js";
export * as ue from "./ue/index.js";
export { log, ok, warn, err } from "./log.js";
export { modules, exports, imports, symbols } from "./search.js";
export { trace, stub, detachAll } from "./hook.js";
