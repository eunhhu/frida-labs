// Thin bridge over the Mono runtime statically linked into Terraria.bin.osx
// (the FNA "monokickstart" launcher). Every embedding-API symbol is exported
// from the main module, so we resolve them there.
//
// Classes, fields and methods are resolved by NAME at create() time. Primitive
// field/static accessors detect the field's MonoType once and bake a typed
// read/write closure, so the per-frame hot path is plain native memory access
// with no further reflection. Reference fields and managed arrays are read as
// raw pointers; managed methods (e.g. Item.SetDefaults, Main.NewText) are driven
// through mono_runtime_invoke.

const MODULE = "Terraria.bin.osx";

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

export interface FieldAccessor {
  readonly exists: boolean;
  readonly offset: number;
  read(obj: NativePointer): number;
  write(obj: NativePointer, value: number): void;
}

export interface RefFieldAccessor {
  readonly exists: boolean;
  readonly offset: number;
  read(obj: NativePointer): NativePointer;
}

export interface StaticAccessor {
  readonly exists: boolean;
  get(): number;
  set(value: number): void;
}

export class Mono {
  readonly domain: NativePointer;
  readonly image: NativePointer;

  private readonly mod = Process.getModuleByName(MODULE);
  private readonly api = {
    rootDomain: this.fn("mono_get_root_domain", "pointer", []),
    threadAttach: this.fn("mono_thread_attach", "pointer", ["pointer"]),
    imageLoaded: this.fn("mono_image_loaded", "pointer", ["pointer"]),
    classFromName: this.fn("mono_class_from_name", "pointer", ["pointer", "pointer", "pointer"]),
    fieldFromName: this.fn("mono_class_get_field_from_name", "pointer", ["pointer", "pointer"]),
    fieldOffset: this.fn("mono_field_get_offset", "uint32", ["pointer"]),
    fieldType: this.fn("mono_field_get_type", "pointer", ["pointer"]),
    typeCode: this.fn("mono_type_get_type", "int", ["pointer"]),
    methodFromName: this.fn("mono_class_get_method_from_name", "pointer", ["pointer", "pointer", "int"]),
    runtimeInvoke: this.fn("mono_runtime_invoke", "pointer", ["pointer", "pointer", "pointer", "pointer"]),
    classVtable: this.fn("mono_class_vtable", "pointer", ["pointer", "pointer"]),
    staticGet: this.fn("mono_field_static_get_value", "void", ["pointer", "pointer", "pointer"]),
    staticSet: this.fn("mono_field_static_set_value", "void", ["pointer", "pointer", "pointer"]),
    stringNew: this.fn("mono_string_new", "pointer", ["pointer", "pointer"]),
    stringLength: this.fn("mono_string_length", "int", ["pointer"]),
    stringChars: this.fn("mono_string_chars", "pointer", ["pointer"]),
  };

  private readonly classCache = new Map<string, NativePointer>();

  constructor() {
    this.domain = this.api.rootDomain();
    this.api.threadAttach(this.domain);
    this.image = this.api.imageLoaded(Memory.allocUtf8String("Terraria"));
  }

  klass(ns: string, name: string): NativePointer {
    const key = ns + "." + name;
    const cached = this.classCache.get(key);
    if (cached !== undefined) return cached;
    const c: NativePointer = this.api.classFromName(this.image, Memory.allocUtf8String(ns), Memory.allocUtf8String(name));
    this.classCache.set(key, c);
    return c;
  }

  field(klass: NativePointer, name: string): FieldAccessor {
    const fld = this.api.fieldFromName(klass, Memory.allocUtf8String(name));
    if (fld.isNull()) return MISSING_FIELD;
    const offset: number = this.api.fieldOffset(fld);
    const rw = primitiveRW(this.api.typeCode(this.api.fieldType(fld)));
    return {
      exists: true,
      offset,
      read: (obj) => rw.read(obj.add(offset)),
      write: (obj, v) => rw.write(obj.add(offset), v),
    };
  }

  refField(klass: NativePointer, name: string): RefFieldAccessor {
    const fld = this.api.fieldFromName(klass, Memory.allocUtf8String(name));
    if (fld.isNull()) return MISSING_REF_FIELD;
    const offset: number = this.api.fieldOffset(fld);
    return { exists: true, offset, read: (obj) => obj.add(offset).readPointer() };
  }

  fieldOffsetOf(klass: NativePointer, name: string): number {
    const fld = this.api.fieldFromName(klass, Memory.allocUtf8String(name));
    return fld.isNull() ? -1 : this.api.fieldOffset(fld);
  }

  staticField(klass: NativePointer, name: string): StaticAccessor {
    const fld = this.api.fieldFromName(klass, Memory.allocUtf8String(name));
    if (fld.isNull()) return MISSING_STATIC;
    const rw = primitiveRW(this.api.typeCode(this.api.fieldType(fld)));
    const vtable = this.api.classVtable(this.domain, klass);
    const buf = Memory.alloc(8);
    return {
      exists: true,
      get: () => { this.api.staticGet(vtable, fld, buf); return rw.read(buf); },
      set: (v) => { rw.write(buf, v); this.api.staticSet(vtable, fld, buf); },
    };
  }

  staticRef(klass: NativePointer, name: string): () => NativePointer {
    const fld = this.api.fieldFromName(klass, Memory.allocUtf8String(name));
    if (fld.isNull()) return () => NULL;
    const vtable = this.api.classVtable(this.domain, klass);
    const buf = Memory.alloc(8);
    return () => { this.api.staticGet(vtable, fld, buf); return buf.readPointer(); };
  }

  // Value-type static field (e.g. Vector2): copies the raw bytes into a buffer.
  // Use .readFloat()/.readS32() on the returned pointer to access fields.
  staticValue(klass: NativePointer, name: string, size: number): { exists: boolean; get(): NativePointer } {
    const fld = this.api.fieldFromName(klass, Memory.allocUtf8String(name));
    if (fld.isNull()) return { exists: false, get: () => NULL };
    const vtable = this.api.classVtable(this.domain, klass);
    const buf = Memory.alloc(size);
    return { exists: true, get: () => { this.api.staticGet(vtable, fld, buf); return buf; } };
  }

  staticRefAccessor(klass: NativePointer, name: string): { exists: boolean; get(): NativePointer; set(v: NativePointer): void } {
    const fld = this.api.fieldFromName(klass, Memory.allocUtf8String(name));
    if (fld.isNull()) return { exists: false, get: () => NULL, set: () => {} };
    const vtable = this.api.classVtable(this.domain, klass);
    const buf = Memory.alloc(Process.pointerSize);
    return {
      exists: true,
      get: () => { this.api.staticGet(vtable, fld, buf); return buf.readPointer(); },
      set: (v) => { buf.writePointer(v); this.api.staticSet(vtable, fld, buf); },
    };
  }

  method(klass: NativePointer, name: string, argc: number): NativePointer {
    return this.api.methodFromName(klass, Memory.allocUtf8String(name), argc);
  }

  // argPtrs: for a value-type parameter pass a pointer to its value buffer; for
  // a reference-type parameter pass the object pointer directly. obj is NULL for
  // static methods. Throws if the call raised a managed exception.
  invoke(method: NativePointer, obj: NativePointer, argPtrs: NativePointer[]): NativePointer {
    const argv = Memory.alloc(Math.max(1, argPtrs.length) * Process.pointerSize);
    argPtrs.forEach((p, i) => argv.add(i * Process.pointerSize).writePointer(p));
    const excSlot = Memory.alloc(Process.pointerSize);
    excSlot.writePointer(NULL);
    const ret: NativePointer = this.api.runtimeInvoke(method, obj, argv, excSlot);
    if (!excSlot.readPointer().isNull()) throw new Error("managed exception during invoke");
    return ret;
  }

  arrayLength(arr: NativePointer): number {
    return arr.add(ARRAY_LEN).readS32();
  }

  refElement(arr: NativePointer, i: number): NativePointer {
    return arr.add(ARRAY_DATA + i * Process.pointerSize).readPointer();
  }

  valueElementAddr(arr: NativePointer, i: number, elemSize: number): NativePointer {
    return arr.add(ARRAY_DATA + i * elemSize);
  }

  newString(s: string): NativePointer {
    return this.api.stringNew(this.domain, Memory.allocUtf8String(s));
  }

  readString(s: NativePointer): string {
    if (s.isNull()) return "";
    const len: number = this.api.stringLength(s);
    if (len <= 0) return "";
    return this.api.stringChars(s).readUtf16String(len)!;
  }

  private fn(name: string, ret: NativeFunctionReturnType, args: NativeFunctionArgumentType[]): any {
    return new NativeFunction(this.mod.getExportByName(name), ret, args);
  }
}

const MISSING_FIELD: FieldAccessor = { exists: false, offset: -1, read: () => 0, write: () => {} };
const MISSING_REF_FIELD: RefFieldAccessor = { exists: false, offset: -1, read: () => NULL };
const MISSING_STATIC: StaticAccessor = { exists: false, get: () => 0, set: () => {} };

interface PrimitiveRW {
  read(p: NativePointer): number;
  write(p: NativePointer, v: number): void;
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
