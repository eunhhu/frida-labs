/// <reference path="../../globals.d.ts" />
// Generic Mono runtime toolkit — reusable across ANY Mono-backed Unity game
// (mono-2.0-bdwgc/sgen). Enumerate assemblies, classes, methods and fields via
// the Mono embedding API, resolve JIT-compiled native addresses, and trace
// managed methods. IL2CPP games use ../il2cpp.js instead.
//
//   import { mono } from "../../lib/mono/index.js";
//   mono.assemblies();
//   mono.find(/Controller/);                 // classes in Assembly-CSharp
//   mono.methods(mono.classByName("", "scrController"));
//   mono.trace(mono.method("", "scrController", "Update"));

type Ptr = NativePointer;

function findMonoModule(): Module {
  const m = Process.enumerateModules().find((x) =>
    /^mono\.dll$/i.test(x.name) || /mono-2\.0(-bdwgc|-sgen)?\.dll$/i.test(x.name),
  );
  if (!m) throw new Error("[mono] mono runtime not found — is this a Mono Unity game?");
  return m;
}

// Lazily-built, cached binding table. `as never` keeps NativeFunction's heavy
// generics out of the call sites while the interface below stays fully typed.
interface Api {
  root(): Ptr;
  attach(d: Ptr): Ptr;
  foreach(cb: NativeCallback<"void", ["pointer", "pointer"]>, ud: Ptr): void;
  image(asm: Ptr): Ptr;
  imageName(img: Ptr): Ptr;
  rows(img: Ptr, table: number): number;
  classGet(img: Ptr, token: number): Ptr;
  classFromName(img: Ptr, ns: Ptr, name: Ptr): Ptr;
  className(k: Ptr): Ptr;
  classNamespace(k: Ptr): Ptr;
  classMethods(k: Ptr, iter: Ptr): Ptr;
  classFields(k: Ptr, iter: Ptr): Ptr;
  methodName(mth: Ptr): Ptr;
  methodFullName(mth: Ptr, sig: number): Ptr;
  fieldName(f: Ptr): Ptr;
  fieldOffset(f: Ptr): number;
  compile(mth: Ptr): Ptr;
  invoke(mth: Ptr, obj: Ptr, argv: Ptr, exc: Ptr): Ptr;
  stringNew(d: Ptr, s: Ptr): Ptr;
  stringChars(s: Ptr): Ptr;
  objectGetClass(o: Ptr): Ptr;
}

let api: Api | null = null;
const MONO_TABLE_TYPEDEF = 2;

function init(): Api {
  if (api) return api;
  const mod = findMonoModule();
  const P = (n: string, ret: string, args: string[]): never =>
    new NativeFunction(mod.getExportByName(n), ret as NativeFunctionReturnType, args as NativeFunctionArgumentType[]) as never;
  api = {
    root: P("mono_get_root_domain", "pointer", []),
    attach: P("mono_thread_attach", "pointer", ["pointer"]),
    foreach: P("mono_assembly_foreach", "void", ["pointer", "pointer"]),
    image: P("mono_assembly_get_image", "pointer", ["pointer"]),
    imageName: P("mono_image_get_name", "pointer", ["pointer"]),
    rows: P("mono_image_get_table_rows", "int", ["pointer", "int"]),
    classGet: P("mono_class_get", "pointer", ["pointer", "uint32"]),
    classFromName: P("mono_class_from_name", "pointer", ["pointer", "pointer", "pointer"]),
    className: P("mono_class_get_name", "pointer", ["pointer"]),
    classNamespace: P("mono_class_get_namespace", "pointer", ["pointer"]),
    classMethods: P("mono_class_get_methods", "pointer", ["pointer", "pointer"]),
    classFields: P("mono_class_get_fields", "pointer", ["pointer", "pointer"]),
    methodName: P("mono_method_get_name", "pointer", ["pointer"]),
    methodFullName: P("mono_method_full_name", "pointer", ["pointer", "int"]),
    fieldName: P("mono_field_get_name", "pointer", ["pointer"]),
    fieldOffset: P("mono_field_get_offset", "int", ["pointer"]),
    compile: P("mono_compile_method", "pointer", ["pointer"]),
    invoke: P("mono_runtime_invoke", "pointer", ["pointer", "pointer", "pointer", "pointer"]),
    stringNew: P("mono_string_new", "pointer", ["pointer", "pointer"]),
    stringChars: P("mono_string_chars", "pointer", ["pointer"]),
    objectGetClass: P("mono_object_get_class", "pointer", ["pointer"]),
  };
  api.attach(api.root()); // attach the Frida thread so managed calls are safe
  return api;
}

const cstr = (p: Ptr): string | null => {
  try { return p.isNull() ? null : p.readCString(); } catch { return null; }
};
const u = (s: string): Ptr => Memory.allocUtf8String(s);

export interface ClassInfo { name: string; ns: string; ptr: Ptr; }
export interface MethodInfo { name: string; full: string; ptr: Ptr; }
export interface FieldInfo { name: string; offset: number; ptr: Ptr; }

export const mono = {
  /** Names of every loaded assembly image. */
  assemblies(): string[] {
    const a = init();
    const out: string[] = [];
    const cb = new NativeCallback((asm: Ptr) => { const n = cstr(a.imageName(a.image(asm))); if (n) out.push(n); }, "void", ["pointer", "pointer"]);
    a.foreach(cb, ptr(0));
    return out;
  },

  /** A loaded image by assembly name (default Assembly-CSharp), or null. */
  image(name = "Assembly-CSharp"): Ptr | null {
    const a = init();
    let found: Ptr | null = null;
    const cb = new NativeCallback((asm: Ptr) => {
      if (found) return;
      const img = a.image(asm);
      if (cstr(a.imageName(img)) === name) found = img;
    }, "void", ["pointer", "pointer"]);
    a.foreach(cb, ptr(0));
    return found;
  },

  /** Every class defined in an image (walks the TypeDef metadata table). */
  classes(image: Ptr | null = mono.image()): ClassInfo[] {
    const a = init();
    if (!image) return [];
    const rows = a.rows(image, MONO_TABLE_TYPEDEF);
    const out: ClassInfo[] = [];
    for (let rid = 2; rid <= rows; rid++) { // rid 1 is <Module>
      const k = a.classGet(image, 0x02000000 | rid);
      if (k.isNull()) continue;
      const name = cstr(a.className(k));
      if (name) out.push({ name, ns: cstr(a.classNamespace(k)) ?? "", ptr: k });
    }
    return out;
  },

  /** Classes whose name (or namespace.name) matches a regex. */
  find(re: RegExp, image: Ptr | null = mono.image()): ClassInfo[] {
    return mono.classes(image).filter((c) => re.test(c.name) || re.test(`${c.ns}.${c.name}`));
  },

  classByName(ns: string, name: string, image: Ptr | null = mono.image()): Ptr | null {
    const a = init();
    if (!image) return null;
    const k = a.classFromName(image, u(ns), u(name));
    return k.isNull() ? null : k;
  },

  methods(klass: Ptr | null): MethodInfo[] {
    const a = init();
    if (!klass) return [];
    const out: MethodInfo[] = [];
    const iter = Memory.alloc(Process.pointerSize);
    iter.writePointer(ptr(0));
    for (;;) {
      const mth = a.classMethods(klass, iter);
      if (mth.isNull()) break;
      out.push({ name: cstr(a.methodName(mth)) ?? "?", full: cstr(a.methodFullName(mth, 1)) ?? "?", ptr: mth });
    }
    return out;
  },

  fields(klass: Ptr | null): FieldInfo[] {
    const a = init();
    if (!klass) return [];
    const out: FieldInfo[] = [];
    const iter = Memory.alloc(Process.pointerSize);
    iter.writePointer(ptr(0));
    for (;;) {
      const f = a.classFields(klass, iter);
      if (f.isNull()) break;
      out.push({ name: cstr(a.fieldName(f)) ?? "?", offset: a.fieldOffset(f), ptr: f });
    }
    return out;
  },

  /** A MonoMethod* by class + method name (first overload). */
  method(ns: string, className: string, methodName: string, image: Ptr | null = mono.image()): Ptr | null {
    const k = mono.classByName(ns, className, image);
    return mono.methods(k).find((m) => m.name === methodName)?.ptr ?? null;
  },

  /** JIT-compiled native entry address of a managed method (for hooking/disasm). */
  addressOf(method: Ptr | null): Ptr | null {
    if (!method) return null;
    const a = init();
    const p = a.compile(method);
    return p.isNull() ? null : p;
  },

  /** Attach a logging tracer to a managed method (enter/leave). Returns the listener. */
  trace(method: Ptr | null, label?: string): InvocationListener | null {
    const addr = mono.addressOf(method);
    if (!addr) return null;
    const a = init();
    const name = label ?? cstr(a.methodFullName(method as Ptr, 1)) ?? addr.toString();
    return Interceptor.attach(addr, {
      onEnter() { console.log(`[mono] -> ${name}`); },
      onLeave(ret) { console.log(`[mono] <- ${name} = ${ret}`); },
    });
  },

  /** Call a managed method. obj NULL for static; value-type args by pointer. */
  invoke(method: Ptr, obj: Ptr | null, argPtrs: Ptr[] = []): Ptr {
    const a = init();
    const argv = Memory.alloc(Math.max(1, argPtrs.length) * Process.pointerSize);
    argPtrs.forEach((p, i) => argv.add(i * Process.pointerSize).writePointer(p));
    const exc = Memory.alloc(Process.pointerSize);
    exc.writePointer(ptr(0));
    const ret: Ptr = a.invoke(method, obj ?? ptr(0), argv, exc);
    if (!exc.readPointer().isNull()) throw new Error("[mono] managed exception during invoke");
    return ret;
  },

  /** New managed System.String from a JS string. */
  string(s: string): Ptr {
    const a = init();
    return a.stringNew(a.root(), u(s));
  },

  /** Read a managed System.String back to a JS string. */
  readString(s: Ptr): string {
    if (s.isNull()) return "";
    const a = init();
    const chars: Ptr = a.stringChars(s);
    try { return chars.readUtf16String() ?? ""; } catch { return ""; }
  },

  /** Class name of a live managed object (follows its MonoObject header). */
  objectClass(obj: Ptr): string | null {
    const a = init();
    const k: Ptr = a.objectGetClass(obj);
    if (k.isNull()) return null;
    return cstr(a.className(k));
  },
};
