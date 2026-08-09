/// <reference path="../../globals.d.ts" />
// Windows .NET Framework host bridge. It reuses the CLR already loaded by the
// target process and invokes one static `int Method(string)` entry point in the
// default AppDomain. The managed payload returns bounded JSON through a
// process-local environment variable so Frida does not need a socket or pipe.

type Ptr = NativePointer;

export interface WindowsClrPayload {
  assemblyBase64: string;
  fileName: string;
  typeName: string;
  methodName?: string;
  resultVariable: string;
  runtimeVersion?: string;
}

export interface WindowsClrBridge {
  readonly path: string;
  execute(request: string): unknown;
  dispose(): void;
}

const CLSID_CLR_META_HOST = "9280188d-0e8e-4867-b30c-7fa83884e8de";
const IID_ICLR_META_HOST = "d332db9e-b9b3-4125-8207-a14884f53216";
const IID_ICLR_RUNTIME_INFO = "bd39d1d2-ba2f-486a-89b0-b4b0cb466891";
const CLSID_CLR_RUNTIME_HOST = "90f1a06e-7712-4762-86b5-7a5eba6bdb02";
const IID_ICLR_RUNTIME_HOST = "90f1a06c-7712-4762-86b5-7a5eba6bdb02";
const MAX_RESULT_CHARS = 32_767;

const pfn = (address: Ptr, ret: NativeFunctionReturnType, args: NativeFunctionArgumentType[]): NativeFunction<NativeFunctionReturnValue, NativeFunctionArgumentValue[]> =>
  new NativeFunction(address, ret, args) as NativeFunction<NativeFunctionReturnValue, NativeFunctionArgumentValue[]>;

function exportFunction(name: string, ret: NativeFunctionReturnType, args: NativeFunctionArgumentType[]): NativeFunction<NativeFunctionReturnValue, NativeFunctionArgumentValue[]> {
  const address = Module.findGlobalExportByName(name);
  if (address === null) throw new Error(`[clr] required Windows export not found: ${name}`);
  return pfn(address, ret, args);
}

function wide(value: string): Ptr {
  return Memory.allocUtf16String(value);
}

function guid(value: string): Ptr {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(value);
  if (!match) throw new Error(`[clr] invalid GUID ${value}`);
  const out = Memory.alloc(16);
  out.writeU32(parseInt(match[1], 16));
  out.add(4).writeU16(parseInt(match[2], 16));
  out.add(6).writeU16(parseInt(match[3], 16));
  const tail = match[4] + match[5];
  for (let i = 0; i < 8; i++) out.add(8 + i).writeU8(parseInt(tail.slice(i * 2, i * 2 + 2), 16));
  return out;
}

function failed(hr: number): boolean {
  return (hr | 0) < 0;
}

function hresult(hr: number, operation: string): void {
  if (failed(hr)) throw new Error(`[clr] ${operation} failed: HRESULT 0x${(hr >>> 0).toString(16).padStart(8, "0")}`);
}

function method(iface: Ptr, slot: number, ret: NativeFunctionReturnType, args: NativeFunctionArgumentType[]): NativeFunction<NativeFunctionReturnValue, NativeFunctionArgumentValue[]> {
  if (iface.isNull()) throw new Error("[clr] null COM interface");
  const address = iface.readPointer().add(slot * Process.pointerSize).readPointer();
  return pfn(address, ret, ["pointer", ...args]);
}

function release(iface: Ptr): void {
  if (!iface.isNull()) method(iface, 2, "uint32", [])(iface);
}

function decodeBase64(value: string): number[] {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = value.replace(/\s+/g, "");
  if (clean.length === 0 || clean.length % 4 !== 0) throw new Error("[clr] invalid payload base64 length");
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const a = alphabet.indexOf(clean[i]);
    const b = alphabet.indexOf(clean[i + 1]);
    const c = clean[i + 2] === "=" ? 0 : alphabet.indexOf(clean[i + 2]);
    const d = clean[i + 3] === "=" ? 0 : alphabet.indexOf(clean[i + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error("[clr] invalid payload base64 character");
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    out.push((bits >>> 16) & 0xff);
    if (clean[i + 2] !== "=") out.push((bits >>> 8) & 0xff);
    if (clean[i + 3] !== "=") out.push(bits & 0xff);
  }
  return out;
}

function tempPath(): string {
  const getTempPath = exportFunction("GetTempPathW", "uint32", ["uint32", "pointer"]);
  const buffer = Memory.alloc(32_768 * 2);
  const count = Number(getTempPath(32_768, buffer));
  if (count === 0 || count >= 32_768) throw new Error("[clr] GetTempPathW failed");
  return buffer.readUtf16String(count) ?? "";
}

function writePayload(path: string, bytes: number[]): void {
  const createFile = exportFunction("CreateFileW", "pointer", ["pointer", "uint32", "uint32", "pointer", "uint32", "uint32", "pointer"]);
  const writeFile = exportFunction("WriteFile", "bool", ["pointer", "pointer", "uint32", "pointer", "pointer"]);
  const closeHandle = exportFunction("CloseHandle", "bool", ["pointer"]);
  const handle = createFile(wide(path), 0x40000000, 0, NULL, 2, 0x80, NULL) as Ptr;
  if (handle.equals(ptr(-1))) throw new Error(`[clr] cannot create payload ${path}`);
  try {
    const data = Memory.alloc(bytes.length);
    data.writeByteArray(bytes);
    const written = Memory.alloc(4);
    if (!writeFile(handle, data, bytes.length, written, NULL) || written.readU32() !== bytes.length) {
      throw new Error(`[clr] short payload write ${written.readU32()}/${bytes.length}`);
    }
  } finally {
    closeHandle(handle);
  }
}

function fileExists(path: string): boolean {
  const getFileAttributes = exportFunction("GetFileAttributesW", "uint32", ["pointer"]);
  return Number(getFileAttributes(wide(path))) !== 0xffffffff;
}

function readResult(name: string): string {
  const getEnvironmentVariable = exportFunction("GetEnvironmentVariableW", "uint32", ["pointer", "pointer", "uint32"]);
  const buffer = Memory.alloc(MAX_RESULT_CHARS * 2);
  const count = Number(getEnvironmentVariable(wide(name), buffer, MAX_RESULT_CHARS));
  if (count === 0) throw new Error(`[clr] managed payload returned no ${name} result`);
  if (count >= MAX_RESULT_CHARS) throw new Error(`[clr] managed payload result exceeds ${MAX_RESULT_CHARS - 1} characters`);
  return buffer.readUtf16String(count) ?? "";
}

export function createWindowsClrBridge(payload: WindowsClrPayload): WindowsClrBridge {
  if (Process.platform !== "windows") throw new Error("[clr] Windows CLR bridge requires a Windows process");
  if (!/^[A-Za-z0-9_.-]+\.dll$/i.test(payload.fileName)) throw new Error("[clr] payload fileName must be a plain .dll name");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(payload.resultVariable)) throw new Error("[clr] invalid result environment variable");
  const path = tempPath() + payload.fileName;
  // A managed LoadFrom assembly stays file-locked for the AppDomain lifetime.
  // The content hash is part of fileName, so an existing file is already the
  // exact immutable payload and must be reused on later Frida attachments.
  if (!fileExists(path)) writePayload(path, decodeBase64(payload.assemblyBase64));

  const clrCreateInstance = exportFunction("CLRCreateInstance", "int", ["pointer", "pointer", "pointer"]);
  const metaOut = Memory.alloc(Process.pointerSize);
  metaOut.writePointer(NULL);
  hresult(Number(clrCreateInstance(guid(CLSID_CLR_META_HOST), guid(IID_ICLR_META_HOST), metaOut)), "CLRCreateInstance");
  const meta = metaOut.readPointer();

  const infoOut = Memory.alloc(Process.pointerSize);
  infoOut.writePointer(NULL);
  hresult(Number(method(meta, 3, "int", ["pointer", "pointer", "pointer"])(
    meta,
    wide(payload.runtimeVersion ?? "v4.0.30319"),
    guid(IID_ICLR_RUNTIME_INFO),
    infoOut,
  )), "ICLRMetaHost.GetRuntime");
  const info = infoOut.readPointer();

  const hostOut = Memory.alloc(Process.pointerSize);
  hostOut.writePointer(NULL);
  hresult(Number(method(info, 9, "int", ["pointer", "pointer", "pointer"])(
    info,
    guid(CLSID_CLR_RUNTIME_HOST),
    guid(IID_ICLR_RUNTIME_HOST),
    hostOut,
  )), "ICLRRuntimeInfo.GetInterface");
  const host = hostOut.readPointer();
  const execute = method(host, 11, "int", ["pointer", "pointer", "pointer", "pointer", "pointer"]);
  let disposed = false;

  return {
    path,
    execute(request: string): unknown {
      if (disposed) throw new Error("[clr] bridge is disposed");
      if (request.length > 24_000) throw new Error("[clr] managed request exceeds 24000 characters");
      const exitCode = Memory.alloc(4);
      exitCode.writeU32(0);
      const hr = Number(execute(
        host,
        wide(path),
        wide(payload.typeName),
        wide(payload.methodName ?? "Entry"),
        wide(request),
        exitCode,
      ));
      hresult(hr, "ICLRRuntimeHost.ExecuteInDefaultAppDomain");
      const raw = readResult(payload.resultVariable);
      try { return JSON.parse(raw); }
      catch { throw new Error(`[clr] managed payload returned invalid JSON: ${raw.slice(0, 256)}`); }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      release(host);
      release(info);
      release(meta);
    },
  };
}
