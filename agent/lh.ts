import "frida-il2cpp-bridge";
import { log, modules, exports } from "./utils.js";
log("- Loaded");

const lh = modules(".exe")[0];
exports("story");
