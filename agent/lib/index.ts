// frida-labs library — cross-game debugging utilities + the shared UE toolkit
// (game-specific data stays config-driven in ue/esp.ts).
// Import in any target: `import { modules, exports, trace, assist, ue } from "../../lib/index.js";`
//
// Side-effect invariant: importing this barrel must never touch the target
// process — every module, `ue` included, defers all process access to first
// call (gameModule()/oa()/gnames() are memoized lazy accessors).
// The Unity/IL2CPP helpers are intentionally NOT re-exported here — pulling
// in the IL2CPP bridge would bloat/break non-Unity targets; Unity targets
// import "./il2cpp.js" directly. The objc/java bridges stay behind lazy
// gates: their modules export pure functions and require() the bridge only on
// first api() call, so re-exporting them is side-effect free.
export * as mem from "./mem.js";
export * as assist from "./assist.js";
export * as ue from "./ue/index.js";
export * as stalker from "./stalker.js";
export * as mam from "./mam.js";
export * as sym from "./sym.js";
export * as objc from "./objc.js";
export * as java from "./java.js";
export * as excrash from "./excrash.js";
export * as recording from "./recording.js";
export { log, ok, warn, err } from "./log.js";
export { modules, exports, imports, symbols } from "./search.js";
export {
  trace, stub, detachAll, implementation, replace,
  withVerification, type Verification, type VerificationStatus,
} from "./hook.js";
