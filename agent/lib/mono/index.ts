/// <reference path="../../globals.d.ts" />
// Generic Mono runtime toolkit — reusable across ANY Mono-backed game (Unity
// mono-2.0-bdwgc/sgen, FNA monokickstart with statically-linked Mono, …).
// Enumerate assemblies, classes, methods and fields via the Mono embedding
// API, resolve JIT-compiled native addresses, read/write primitive and
// reference fields, and trace managed methods. IL2CPP games use
// ../il2cpp.js instead.
//
//   import { mono, createMono } from "../../lib/mono/index.js";
//   mono.assemblies();                        // default runtime, Assembly-CSharp
//   mono.find(/Controller/);
//   mono.trace(mono.method("", "scrController", "Update"));
//
//   const t = createMono({ moduleName: "Terraria.bin.osx", imageName: "Terraria" });
//   const Main = t.klass("Terraria", "Main");
//   const life = t.field(t.klass("Terraria", "Player"), "statLife");
//
// Module resolution lives in ./runtime.js (baked → candidate → scan → error).
// Everything is LAZY: creating a surface performs no process introspection;
// the runtime module and embedding API bind on the first actual call, so
// importing this module never produces side effects.

import { resolveMonoModule, BAKED_MODULES } from "./runtime.js";
import { withVerification, type Verification } from "../hook.js";
import { log } from "../log.js";

type Ptr = NativePointer;

export interface MonoOptions {
  /** Baked/explicit module name(s) tried before candidate names and the export scan. */
  moduleName?: string | readonly string[];
  /** Known target key — consults BAKED_MODULES[target] when moduleName is absent. */
  target?: string;
  /** Default image (assembly) used by image()/classByName()/klass(). */
  imageName?: string;
}

// Lazily-built, cached binding table. `as never` keeps NativeFunction's heavy
// generics out of the call sites while the surface below stays fully typed.
interface Api {
  root(): Ptr;
  attach(d: Ptr): Ptr;
  foreach(cb: NativeCallback<"void", ["pointer", "pointer"]>, ud: Ptr): void;
  image(asm: Ptr): Ptr;
  imageName(img: Ptr): Ptr;
  imageLoaded(name: Ptr): Ptr;
  rows(img: Ptr, table: number): number;
  classGet(img: Ptr, token: number): Ptr;
  classFromName(img: Ptr, ns: Ptr, name: Ptr): Ptr;
  className(k: Ptr): Ptr;
  classNamespace(k: Ptr): Ptr;
  classMethods(k: Ptr, iter: Ptr): Ptr;
  classFields(k: Ptr, iter: Ptr): Ptr;
  fieldFromName(k: Ptr, name: Ptr): Ptr;
  fieldType(f: Ptr): Ptr;
  typeCode(t: Ptr): number;
  methodFromName(k: Ptr, name: Ptr, argc: number): Ptr;
  methodName(mth: Ptr): Ptr;
  methodFullName(mth: Ptr, sig: number): Ptr;
  fieldName(f: Ptr): Ptr;
  fieldOffset(f: Ptr): number;
  compile(mth: Ptr): Ptr;
  invoke(mth: Ptr, obj: Ptr, argv: Ptr, exc: Ptr): Ptr;
  classVtable(d: Ptr, k: Ptr): Ptr;
  staticGet(vt: Ptr, f: Ptr, buf: Ptr): void;
  staticSet(vt: Ptr, f: Ptr, buf: Ptr): void;
  stringNew(d: Ptr, s: Ptr): Ptr;
  stringLength(s: Ptr): number;
  stringChars(s: Ptr): Ptr;
  objectGetClass(o: Ptr): Ptr;
}

const MONO_TABLE_TYPEDEF = 2;

// MonoArray on 64-bit: MonoObject header (0x10) + bounds ptr (0x8) +
// max_length (0x8) => element vector at 0x20, max_length at 0x18.
const ARRAY_DATA = 0x20;
const ARRAY_LEN = 0x18;

const enum TypeCode {
  Boolean = 0x02,
  I1 = 0x04,
  U1 = 0x05,
  I2 = 0x06,
  U2 = 0x07,
  I4 = 0x08,
  U4 = 0x09,
  I8 = 0x0a,
  U8 = 0x0b,
  R4 = 0x0c,
  R8 = 0x0d,
}

export interface ClassInfo { name: string; ns: string; ptr: Ptr; }
export interface MethodInfo { name: string; full: string; ptr: Ptr; }
export interface FieldInfo { name: string; offset: number; ptr: Ptr; }

export interface FieldAccessor {
  readonly exists: boolean;
  readonly offset: number;
  read(obj: Ptr): number;
  write(obj: Ptr, value: number): void;
}

export interface RefFieldAccessor {
  readonly exists: boolean;
  readonly offset: number;
  read(obj: Ptr): Ptr;
}

export interface StaticAccessor {
  readonly exists: boolean;
  get(): number;
  set(value: number): void;
}

const cstr = (p: Ptr): string | null => {
  try { return p.isNull() ? null : p.readCString(); } catch { return null; }
};
const u = (s: string): Ptr => Memory.allocUtf8String(s);

interface PrimitiveRW {
  read(p: Ptr): number;
  write(p: Ptr, v: number): void;
}

function primitiveRW(code: TypeCode): PrimitiveRW {
  switch (code) {
    case TypeCode.Boolean:
    case TypeCode.U1: return { read: (p) => p.readU8(), write: (p, v) => { p.writeU8(v); } };
    case TypeCode.I1: return { read: (p) => p.readS8(), write: (p, v) => { p.writeS8(v); } };
    case TypeCode.I2: return { read: (p) => p.readS16(), write: (p, v) => { p.writeS16(v); } };
    case TypeCode.U2: return { read: (p) => p.readU16(), write: (p, v) => { p.writeU16(v); } };
    case TypeCode.I4: return { read: (p) => p.readS32(), write: (p, v) => { p.writeS32(v); } };
    case TypeCode.U4: return { read: (p) => p.readU32(), write: (p, v) => { p.writeU32(v); } };
    case TypeCode.I8: return { read: (p) => p.readS64().valueOf(), write: (p, v) => { p.writeS64(v); } };
    case TypeCode.U8: return { read: (p) => p.readU64().valueOf(), write: (p, v) => { p.writeU64(v); } };
    case TypeCode.R4: return { read: (p) => p.readFloat(), write: (p, v) => { p.writeFloat(v); } };
    case TypeCode.R8: return { read: (p) => p.readDouble(), write: (p, v) => { p.writeDouble(v); } };
    default: return { read: (p) => p.readS32(), write: (p, v) => { p.writeS32(v); } };
  }
}

const MISSING_FIELD: FieldAccessor = { exists: false, offset: -1, read: () => 0, write: () => {} };
const MISSING_REF_FIELD: RefFieldAccessor = { exists: false, offset: -1, read: () => NULL };
const MISSING_STATIC: StaticAccessor = { exists: false, get: () => 0, set: () => {} };

export type MonoSurface = ReturnType<typeof createMono>;

/**
 * Create a Mono toolkit surface bound to one runtime. Pure factory — no
 * process introspection happens until the first method call.
 */
export function createMono(opts: MonoOptions = {}) {
  const imageName = opts.imageName ?? "Assembly-CSharp";

  let api: Api | null = null;
  let defaultImage: Ptr | null = null;
  const classCache = new Map<string, Ptr>();

  function init(): Api {
    if (api) return api;
    const preferred = opts.moduleName ?? (opts.target ? BAKED_MODULES[opts.target] : undefined);
    const { module: mod } = resolveMonoModule(preferred);
    const P = (n: string, ret: string, args: string[]): never =>
      new NativeFunction(mod.getExportByName(n), ret as NativeFunctionReturnType, args as NativeFunctionArgumentType[]) as never;
    api = {
      root: P("mono_get_root_domain", "pointer", []),
      attach: P("mono_thread_attach", "pointer", ["pointer"]),
      foreach: P("mono_assembly_foreach", "void", ["pointer", "pointer"]),
      image: P("mono_assembly_get_image", "pointer", ["pointer"]),
      imageName: P("mono_image_get_name", "pointer", ["pointer"]),
      imageLoaded: P("mono_image_loaded", "pointer", ["pointer"]),
      rows: P("mono_image_get_table_rows", "int", ["pointer", "int"]),
      classGet: P("mono_class_get", "pointer", ["pointer", "uint32"]),
      classFromName: P("mono_class_from_name", "pointer", ["pointer", "pointer", "pointer"]),
      className: P("mono_class_get_name", "pointer", ["pointer"]),
      classNamespace: P("mono_class_get_namespace", "pointer", ["pointer"]),
      classMethods: P("mono_class_get_methods", "pointer", ["pointer", "pointer"]),
      classFields: P("mono_class_get_fields", "pointer", ["pointer", "pointer"]),
      fieldFromName: P("mono_class_get_field_from_name", "pointer", ["pointer", "pointer"]),
      fieldType: P("mono_field_get_type", "pointer", ["pointer"]),
      typeCode: P("mono_type_get_type", "int", ["pointer"]),
      methodFromName: P("mono_class_get_method_from_name", "pointer", ["pointer", "pointer", "int"]),
      methodName: P("mono_method_get_name", "pointer", ["pointer"]),
      methodFullName: P("mono_method_full_name", "pointer", ["pointer", "int"]),
      fieldName: P("mono_field_get_name", "pointer", ["pointer"]),
      fieldOffset: P("mono_field_get_offset", "int", ["pointer"]),
      compile: P("mono_compile_method", "pointer", ["pointer"]),
      invoke: P("mono_runtime_invoke", "pointer", ["pointer", "pointer", "pointer", "pointer"]),
      classVtable: P("mono_class_vtable", "pointer", ["pointer", "pointer"]),
      staticGet: P("mono_field_static_get_value", "void", ["pointer", "pointer", "pointer"]),
      staticSet: P("mono_field_static_set_value", "void", ["pointer", "pointer", "pointer"]),
      stringNew: P("mono_string_new", "pointer", ["pointer", "pointer"]),
      stringLength: P("mono_string_length", "int", ["pointer"]),
      stringChars: P("mono_string_chars", "pointer", ["pointer"]),
      objectGetClass: P("mono_object_get_class", "pointer", ["pointer"]),
    };
    api.attach(api.root()); // attach the Frida thread so managed calls are safe
    // Rosetta heuristic gate (best effort): on darwin an x64 process on Apple
    // Silicon runs translated, and Mono's JIT output can break Interceptor
    // there — warn once so unverified hooks are read correctly.
    if (Process.platform === "darwin" && Process.arch === "x64") {
      log(
        "[mono] x64 process on darwin (heuristic: likely Rosetta) — Mono JIT code may evade " +
          "Interceptor on translated processes; treat verified:false hooks accordingly",
      );
    }
    return api;
  }

  const surface = {
    /** Names of every loaded assembly image. */
    assemblies(): string[] {
      const a = init();
      const out: string[] = [];
      const cb = new NativeCallback((asm: Ptr) => { const n = cstr(a.imageName(a.image(asm))); if (n) out.push(n); }, "void", ["pointer", "pointer"]);
      a.foreach(cb, ptr(0));
      return out;
    },

    /** A loaded image by assembly name (default: the surface's imageName), or null. */
    image(name: string = imageName): Ptr | null {
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

    /** Default image for this surface (mono_image_loaded first, enumeration fallback). */
    defaultImage(): Ptr | null {
      if (defaultImage) return defaultImage;
      const a = init();
      const loaded: Ptr = a.imageLoaded(u(imageName));
      defaultImage = loaded.isNull() ? surface.image(imageName) : loaded;
      return defaultImage;
    },

    /** Every class defined in an image (walks the TypeDef metadata table). */
    classes(image: Ptr | null = surface.defaultImage()): ClassInfo[] {
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
    find(re: RegExp, image: Ptr | null = surface.defaultImage()): ClassInfo[] {
      return surface.classes(image).filter((c) => re.test(c.name) || re.test(`${c.ns}.${c.name}`));
    },

    classByName(ns: string, name: string, image: Ptr | null = surface.defaultImage()): Ptr | null {
      const a = init();
      if (!image) return null;
      const k = a.classFromName(image, u(ns), u(name));
      return k.isNull() ? null : k;
    },

    /** Class pointer by namespace + name in the default image (cached; throws-free NULL on miss). */
    klass(ns: string, name: string): Ptr {
      const key = ns + "." + name;
      const cached = classCache.get(key);
      if (cached !== undefined) return cached;
      const k = surface.classByName(ns, name) ?? NULL;
      classCache.set(key, k);
      return k;
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
    method(ns: string, className: string, methodName: string, image: Ptr | null = surface.defaultImage()): Ptr | null {
      const k = surface.classByName(ns, className, image);
      return surface.methods(k).find((m) => m.name === methodName)?.ptr ?? null;
    },

    /** A MonoMethod* by class pointer + name + parameter count (-1 for any). */
    methodFromName(klass: Ptr, name: string, argc: number): Ptr {
      const a = init();
      return a.methodFromName(klass, u(name), argc);
    },

    /** JIT-compiled native entry address of a managed method (for hooking/disasm). */
    addressOf(method: Ptr | null): Ptr | null {
      if (!method) return null;
      const a = init();
      const p = a.compile(method);
      return p.isNull() ? null : p;
    },

    /**
     * Attach a logging tracer to a managed method (enter/leave), firing-verified
     * via the shared hook core (#3752-safe: distinguish silent attach from an
     * unhit trigger). Truthy on success so `mono.trace(m) ? …` keeps working.
     */
    trace(method: Ptr | null, label?: string): Verification | null {
      const addr = surface.addressOf(method);
      if (!addr) return null;
      const a = init();
      const name = label ?? cstr(a.methodFullName(method as Ptr, 1)) ?? addr.toString();
      const listener = Interceptor.attach(addr, {
        onEnter() { v.note(); console.log(`[mono] -> ${name}`); },
        onLeave(ret) { console.log(`[mono] <- ${name} = ${ret}`); },
      });
      const v = withVerification(listener, `mono.trace ${name}`);
      return v;
    },

    /**
     * Call a managed method. obj NULL for static. For a value-type parameter
     * pass a pointer to its value buffer; for a reference-type parameter pass
     * the object pointer directly. Throws if the call raised a managed exception.
     */
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

    /** Primitive instance field accessor (typed read/write baked once). */
    field(klass: Ptr, name: string): FieldAccessor {
      const a = init();
      const fld = a.fieldFromName(klass, u(name));
      if (fld.isNull()) return MISSING_FIELD;
      const offset: number = a.fieldOffset(fld);
      const rw = primitiveRW(a.typeCode(a.fieldType(fld)));
      return {
        exists: true,
        offset,
        read: (obj) => rw.read(obj.add(offset)),
        write: (obj, v) => rw.write(obj.add(offset), v),
      };
    },

    /** Reference-type instance field accessor (read as raw pointer). */
    refField(klass: Ptr, name: string): RefFieldAccessor {
      const a = init();
      const fld = a.fieldFromName(klass, u(name));
      if (fld.isNull()) return MISSING_REF_FIELD;
      const offset: number = a.fieldOffset(fld);
      return { exists: true, offset, read: (obj) => obj.add(offset).readPointer() };
    },

    fieldOffsetOf(klass: Ptr, name: string): number {
      const a = init();
      const fld = a.fieldFromName(klass, u(name));
      return fld.isNull() ? -1 : a.fieldOffset(fld);
    },

    /** Primitive static field accessor (get/set via the class vtable). */
    staticField(klass: Ptr, name: string): StaticAccessor {
      const a = init();
      const fld = a.fieldFromName(klass, u(name));
      if (fld.isNull()) return MISSING_STATIC;
      const rw = primitiveRW(a.typeCode(a.fieldType(fld)));
      const vtable = a.classVtable(a.root(), klass);
      const buf = Memory.alloc(8);
      return {
        exists: true,
        get: () => { a.staticGet(vtable, fld, buf); return rw.read(buf); },
        set: (v) => { rw.write(buf, v); a.staticSet(vtable, fld, buf); },
      };
    },

    /** Static reference field read as a pointer getter. */
    staticRef(klass: Ptr, name: string): () => Ptr {
      const a = init();
      const fld = a.fieldFromName(klass, u(name));
      if (fld.isNull()) return () => NULL;
      const vtable = a.classVtable(a.root(), klass);
      const buf = Memory.alloc(8);
      return () => { a.staticGet(vtable, fld, buf); return buf.readPointer(); };
    },

    /** Static reference field accessor with get/set. */
    staticRefAccessor(klass: Ptr, name: string): { exists: boolean; get(): Ptr; set(v: Ptr): void } {
      const a = init();
      const fld = a.fieldFromName(klass, u(name));
      if (fld.isNull()) return { exists: false, get: () => NULL, set: () => {} };
      const vtable = a.classVtable(a.root(), klass);
      const buf = Memory.alloc(Process.pointerSize);
      return {
        exists: true,
        get: () => { a.staticGet(vtable, fld, buf); return buf.readPointer(); },
        set: (v) => { buf.writePointer(v); a.staticSet(vtable, fld, buf); },
      };
    },

    /** Value-type static field (e.g. Vector2): copies raw bytes into a buffer. */
    staticValue(klass: Ptr, name: string, size: number): { exists: boolean; get(): Ptr } {
      const a = init();
      const fld = a.fieldFromName(klass, u(name));
      if (fld.isNull()) return { exists: false, get: () => NULL };
      const vtable = a.classVtable(a.root(), klass);
      const buf = Memory.alloc(size);
      return { exists: true, get: () => { a.staticGet(vtable, fld, buf); return buf; } };
    },

    arrayLength(arr: Ptr): number {
      return arr.add(ARRAY_LEN).readS32();
    },

    refElement(arr: Ptr, i: number): Ptr {
      return arr.add(ARRAY_DATA + i * Process.pointerSize).readPointer();
    },

    valueElementAddr(arr: Ptr, i: number, elemSize: number): Ptr {
      return arr.add(ARRAY_DATA + i * elemSize);
    },

    /** New managed System.String from a JS string. */
    newString(s: string): Ptr {
      const a = init();
      return a.stringNew(a.root(), u(s));
    },

    /** Read a managed System.String back to a JS string. */
    readString(s: Ptr): string {
      if (s.isNull()) return "";
      const a = init();
      const len: number = a.stringLength(s);
      if (len <= 0) return "";
      try { return a.stringChars(s).readUtf16String(len) ?? ""; } catch { return ""; }
    },

    /** Class name of a live managed object (follows its MonoObject header). */
    objectClass(obj: Ptr): string | null {
      const a = init();
      const k: Ptr = a.objectGetClass(obj);
      if (k.isNull()) return null;
      return cstr(a.className(k));
    },
  };

  return surface;
}

/**
 * Compat singleton: the generic surface for the process's default Mono
 * runtime (Assembly-CSharp). Lazy — the first method call resolves the module.
 */
export const mono = createMono();

export { BAKED_MODULES };
