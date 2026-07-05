export function log(...args: any[]): void {
  console.log(...args);
}

export function modules(q: string): Module[] {
  const results = Process.enumerateModules().filter((m) =>
    m.name.match(new RegExp(q, "i")),
  );
  log(`[+] 검색 결과: ${results.length}개`);
  results.forEach((m, index) => {
    log(`[${index}] ${m.name} ${m.version ?? ""}`);
  });
  return results;
}

export function exports(q: string): ModuleExportDetails[] {
  const modules = Process.enumerateModules();
  const results = modules.flatMap((m) =>
    m
      .enumerateExports()
      .filter((e) => e.name.match(new RegExp(q, "i")))
      .map((e) => ({ ...e, module: m })),
  );
  log(`[+] 검색 결과: ${results.length}개`);
  results.forEach((e, index) => {
    log(`[${index}] ${e.name} - ${e.module.name}`);
  });
  return results;
}

export function clazz(q: string): Il2Cpp.Class[] {
  const AssemblyCSharp = Il2Cpp.domain.assembly("Assembly-CSharp");
  const results = AssemblyCSharp.image.classes.filter((cls) =>
    cls.fullName.match(new RegExp(q, "i")),
  );
  log(`[+] 검색 결과: ${results.length}개`);
  results.forEach((cls, index) => {
    log(`[${index}] ${cls.fullName} ${cls.toString()}`);
  });
  return results;
}

export function methods(q: string): Il2Cpp.Method[] {
  const AssemblyCSharp = Il2Cpp.domain.assembly("Assembly-CSharp");
  const results = AssemblyCSharp.image.classes.flatMap((c) =>
    c.methods.filter((m) => m.name.match(new RegExp(q, "i"))),
  );
  log(`[+] 검색 결과: ${results.length}개`);
  results.forEach((m, index) => {
    log(`[${index}] ${m.class.fullName} - ${m.name}`);
  });
  return results;
}

export function hooki(
  m: Il2Cpp.Method | Il2Cpp.Method[],
  aargs?: any[],
  retu?: any,
) {
  if (Array.isArray(m)) {
    m.forEach((m) => hooki(m, aargs, retu));
    return;
  }
  log(`[+] ${m.name} hook 시작`);
  m.implementation = function (...args: any[]) {
    const ret = this.method(m.name).invoke(...(aargs ?? args));
    log(`[+] ${m.name} 호출됨!`);
    log(`  - arg: ${JSON.stringify(args)}`);
    log(`  - ret: ${ret}`);
    return retu ?? ret;
  };
}
