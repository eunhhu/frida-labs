import "frida-il2cpp-bridge";
import { log, methods } from "./utils.js";

var on = true;

// 1. 원래 판정(oj)별 보정 확률 테이블 정의
// -1: MISS, 0: PERFECT, 1: GREAT, 2: GOOD, 3: BAD
const correctionTable: { [key: number]: { [key: number]: number } } = {
  // 원래 PERFECT(0) -> PERFECT(0) 100%
  0: { 0: 1.0 },
  // 0: { 2: 1.0 },

  // 원래 GREAT(1) -> PERFECT(0) 99%, GREAT(1) 1%
  1: { 0: 0.99, 1: 0.01 },
  // 1: { 0: 1.0 },

  // 원래 GOOD(2) -> PERFECT(0) 95%, GREAT(1) 3%, GOOD(2) 2%
  2: { 0: 0.95, 1: 0.04, 2: 0.01 },
  // 2: { 0: 1.0 },

  // 원래 BAD(3) -> 필요시 추가 (예: PERFECT 80%, GREAT 10%, GOOD 5%, BAD 5%)
  3: { 0: 0.8, 1: 0.15, 2: 0.03, 3: 0.02 },
  // 3: { 0: 1.0 },

  // 원래 MISS(4 또는 -1) -> 보정 없이 그대로 가거나, 원하시면 확률을 줄 수 있습니다.
  // 4: { 0: 0.6, 1: 0.2, 2: 0.15, 3: 0.0, 4: 0.05 },
  4: { 0: 1.0 },
};

// 가중치 랜덤 선택 함수
function getRandomJudgment(oj: number): number {
  // 해당 원래 판정에 대한 확률 맵이 없으면 원래 판정 그대로 반환
  const weightMap = correctionTable[oj];
  if (!weightMap) return oj;

  const roll = Math.random();
  let sum = 0;

  for (const [key, weight] of Object.entries(weightMap)) {
    sum += weight;
    if (roll < sum) {
      return Number(key);
    }
  }

  // 만약 확률 합이 1이 안 되어 안 걸렸을 경우를 대비한 방어 코드 (기본값)
  return oj;
}

Il2Cpp.perform(() => {
  log("[+] IL2CPP Bridge loaded.");
  log(`[+] on: ${on}`);

  const judgeUnit = methods("^JudgeUnit$")[0];

  judgeUnit.implementation = function (...args: any[]) {
    // -1(MISS)을 처리하기 편하게 4로 임시 치환
    const oj = +args[1] == -1 ? 4 : +args[1];

    let jud = oj;

    // 보정 기능이 켜져 있을 때만 확률 기반 보정 수행
    if (on) {
      jud = getRandomJudgment(oj);
    }

    // 인자 재구성 (보정된 jud가 4(MISS)라면 다시 -1로 돌려줌)
    const arg = on
      ? [0, jud == 4 ? -1 : jud, true, false, 1, 0, 0, true]
      : args;

    const ret = this.method(judgeUnit.name).invoke(...arg);
    return ret;
  };
});
