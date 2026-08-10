# Analysis playbooks — offline triage and unpacking

Techniques distilled from public reverse-engineering skill sets
(`SimoneAvogadro/android-reverse-engineering-skill`, `P4nda0s/reverse-skills`,
`yaklang/hack-skills`) adapted to this workspace's authorization model. These
playbooks assume an owned offline build or a fully isolated private lab; that
scope is a precondition, not a formality.

Runtime (live-process) techniques are implemented natively in `agent/lib/`:

| Technique | Module | Probe RPC |
|---|---|---|
| Loader-aware module hooking (`dlopen` / `android_dlopen_ext`, base-address dedup) | `loader.ts` | `hookModuleLoad(modName, exportName?)` |
| Protection primitive scan (anti-debug / root-detect / SSL-pinning / crypto surfaces) | `protections.ts` | `protectionsScan()` |
| Java class method tracing (all overloads) | `jtrace.ts` | `javaTraceClass(className)` |
| Crypto key/plaintext observation (Cipher, MessageDigest) | `jtrace.ts` | `javaWatchCrypto()` |
| WebView URL + bridge observation | `jtrace.ts` | `javaWatchWebViews()` |
| SharedPreferences dump | `jtrace.ts` | `javaDumpPrefs()` |
| Intent sniffing | `jtrace.ts` | `javaWatchIntents()` |

Everything below runs *offline* against app packages, before or alongside a
live session.

## 1. APK/XAPK fingerprinting (triage before decompile)

Decompiling Java is mostly useless for Flutter / React Native / Cordova /
Xamarin apps — different tools are needed. Fingerprint first:

| Marker in zip listing / dex strings | Framework | Next step |
|---|---|---|
| `lib/<abi>/libflutter.so` (+ `libapp.so`) | Flutter | Dart AOT in `libapp.so`: reFlutter / blutter; `strings` on `libapp.so` |
| `libhermes.so` / `assets/index.android.bundle` / `libreactnativejni.so` | React Native | Hermes: hbctool disasm; JSC: beautify bundle, grep `fetch(`/`axios` |
| `assets/www/index.html` / `cordova.js` | Cordova / Capacitor | Unzip; app code is plain HTML/JS |
| `libmonodroid.so` / `assemblies/` / `libmaui.so` | Xamarin / MAUI | Logic in .NET DLLs: ILSpy/dotPeek |
| `androidx.compose` / `META-INF/*.kotlin_module` | Native Kotlin | jadx path (below) |

HTTP-stack hints from dex type strings: `retrofit2`, `okhttp3`, `io/ktor/`,
`com/apollographql/`, `com/android/volley`. DI: `dagger/hilt/`, `org/koin/`.
Serialization: `kotlinx/serialization/`, `gson`, `moshi`, `jackson`.

Obfuscation heuristic: count single/double-letter root packages in the dex
listing — >30 short dirs ≈ heavy R8. R8 cannot strip Kotlin `@Metadata`
strings; `@DebugMetadata` source names recover most `*Repository` /
`*ViewModel` / `*UseCase` names from jadx output.

## 2. Unity IL2CPP symbol recovery

C# names are stripped from the native binary but preserved in
`global-metadata.dat`.

- Files: Android `lib/<arch>/libil2cpp.so` + `assets/bin/Data/Managed/Metadata/global-metadata.dat`;
  iOS `UnityFramework` + `Data/Managed/Metadata/global-metadata.dat`.
- Metadata version: first 8 bytes = magic `af 1b b1 fa` + LE version.
  v≤29 → original Il2CppDumper; v39 (Unity 6) → the roytu/Il2CppDumper `v39`
  fork. Cpp2IL is the alternative for source reconstruction.
- Output: `script.json` (addresses + names) imports into IDA via the bundled
  `ida_py3.py` or into Ghidra; `dump.cs` gives RVA offsets per method; field
  offsets in `dump.cs` are object-relative and pair directly with live
  `peek`/`hexdump` in a flab session.
- Live-side counterpart: attach with flab and use `agent/lib/il2cpp.ts`
  (`classes()`, `methods()`, verified `hook()`) — the dumped offsets validate
  that the runtime metadata matches the build you analyzed offline.

## 3. DEX dumping from a packed app (concept)

Packers decrypt the real DEX only after their class loader runs. The classic
flow (ptrace-based dumper such as panda-dex-dumper over adb, root required):
push the dumper to `/data/local/tmp`, resolve the package PID, dump to
`/data/local/tmp/panda/`, pull, then clean up device artifacts. Two rules that
transfer to any tool:

1. Navigate past the splash/decryption point before dumping — an early dump
   yields only the packer stub.
2. Multiple DEX files are normal; pull all of them.

In a flab session the equivalent live evidence is `protectionsScan()` (does
the app even have a protector surface?) plus `hookModuleLoad()` on the
packer's native library to observe the decryption boundary.

## 4. Anti-debug / anti-tamper orientation

The cross-OS matrices (Linux: ptrace self-attach, `/proc/self/status`
TracerPid, maps scanning, timing checks, fork+ptrace watchdogs; Windows:
PEB.BeingDebugged/NtGlobalFlag, NtQueryInformationProcess classes, heap
flags, TLS callbacks, hardware-register checks) are lookup tables for what a
target *might* do. `protectionsScan()` reports which of those primitives are
actually present in the attached process, so analysis planning starts from
evidence instead of the full matrix.

When constructor-time anti-debug is suspected, do not hook `.init` /
`.init_array` / `JNI_OnLoad` blindly: those hooks are fragile, shift timing,
and can hide the behavior under study. Trace the linker-side constructor
dispatcher first, identify the exact offending routine, and only then decide
how to handle it within the authorized scope.
