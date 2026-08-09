import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

async function windowsCompiler(root: string, source: string, executable: string): Promise<string[]> {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const vswhere = join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  let installation = "";
  if (existsSync(vswhere)) {
    const discovery = Bun.spawn([
      vswhere,
      "-latest",
      "-products", "*",
      "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property", "installationPath",
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (await discovery.exited === 0) installation = (await new Response(discovery.stdout).text()).trim();
  }
  const fallbacks = [
    installation,
    ...["Community", "BuildTools", "Professional", "Enterprise"].map((edition) =>
      join(programFiles, "Microsoft Visual Studio", "2022", edition)),
  ].filter(Boolean);
  const vsDevCmd = fallbacks
    .map((candidate) => join(candidate, "Common7", "Tools", "VsDevCmd.bat"))
    .find(existsSync);
  if (!vsDevCmd) throw new Error("Visual Studio C++ build tools not found (VsDevCmd.bat missing)");
  const quote = (value: string): string => value.replaceAll("'", "''");
  const powershell = [
    `$vs='${quote(vsDevCmd)}'`,
    `$source='${quote(source)}'`,
    `$out='${quote(executable)}'`,
    "$command='call \"' + $vs + '\" -no_logo -arch=x64 -host_arch=x64 >nul && cl.exe /nologo /Od /Z7 /W4 /WX \"' + $source + '\" /Fe:\"' + $out + '\"'",
    "& cmd.exe /d /s /c $command",
    "exit $LASTEXITCODE",
  ].join(";");
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(powershell, "utf16le").toString("base64")];
}

/** Compile one owned native test fixture on Unix or a Visual Studio Windows host. */
export async function compileNativeFixture(root: string, sourceValue: string, executable: string): Promise<void> {
  const source = isAbsolute(sourceValue) ? sourceValue : join(root, sourceValue);
  const command = process.platform === "win32"
    ? await windowsCompiler(root, source, executable)
    : ["cc", "-O0", "-g", "-Wall", "-Wextra", "-Werror", source, "-o", executable];
  const compiler = Bun.spawn(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const compileExit = await compiler.exited;
  if (compileExit !== 0) {
    const [stdout, stderr] = await Promise.all([
      new Response(compiler.stdout).text(),
      new Response(compiler.stderr).text(),
    ]);
    throw new Error(`fixture compile failed (${command[0]}): ${stderr || stdout}`);
  }
}
