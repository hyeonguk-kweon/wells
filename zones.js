/*
 * 매수·매도 구간 (지수 ETF용) — python/core/zones.py 의 JS 이식. 종가만 쓴다. 그날까지의 자료만 쓴다.
 * 파이썬 원본과 상태가 100% 같아야 한다 (tests/verify_zones.js 가 실데이터로 대조).
 *
 *   const Z = require("./zones.js");         // 브라우저에서는 window.Zones
 *   const z = Z.zones(closeArray);           // {state, raw, kind, dd52, dist200, rsi14, rsi2, ret20}
 *   const today = Z.describe(z, z.state.length - 1);
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Zones = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const SELL_CONFIRM = 3, GAP_DAYS = 5;
  const PLAN = { 3: ["매수", 0.5], 2: ["매수", 0.25], 1: ["매수", 0.1], "-1": ["매도", 0.2], "-2": ["매도", 0.4] };
  const KIND = { 3: "매수3 폭락", 22: "매수2 급락 투매", 2: "매수2 깊은 눌림", 1: "매수1 얕은 눌림", 0: "중립", "-1": "매도1 과열 정체", "-2": "매도2 하락 초입" };
  const WHY = {
    3: "52주 고점 대비 -30% 이하 — 폭락 구간. 이후 60일 안에 -10% 더 빠질 확률도 높아 나눠서 매수",
    22: "20일 -10% 이상 급락 또는 RSI14 30 미만 — 투매 바닥권. 반등이 컸지만 추가 하락도 잦아 분할",
    2: "52주 고점 대비 -10% 이하, 200일선 위 — 깊은 눌림",
    1: "고점 대비 -5~-10% 또는 RSI2 10 미만, 200일선 위 — 얕은 눌림 (효과 작음, 적립 유지 수준)",
    0: "신호 없음",
    "-1": "200일선 이격 +15% 이상 & RSI14 70 초과 — 과열 정체 (이후 2~3개월 정체 경향)",
    "-2": "200일선 아래 & 고점 대비 -10~-20% & 아직 투매 전 — 하락 초입. 60일 안에 -10% 더 빠질 위험이 평소의 1.5~3배",
  };
  const isN = (x) => x !== x || x === null || x === undefined;
  const arr = (n, v = NaN) => new Array(n).fill(v);
  // pandas rolling(n).max()/mean() 기본 (창이 꽉 차야 값)
  function rollFull(s, n, fn) {
    const out = arr(s.length);
    for (let i = n - 1; i < s.length; i++) {
      let ok = true; for (let j = i - n + 1; j <= i; j++) if (isN(s[j])) { ok = false; break; }
      if (ok) out[i] = fn(s, i - n + 1, i);
    }
    return out;
  }
  const maxf = (s, a, b) => { let m = -Infinity; for (let j = a; j <= b; j++) if (s[j] > m) m = s[j]; return m; };
  const meanf = (s, a, b) => { let t = 0; for (let j = a; j <= b; j++) t += s[j]; return t / (b - a + 1); };
  function wilder(s, n) {                      // core/indicators.wilder 와 같은 규칙 (첫 값은 n개 단순평균)
    const out = arr(s.length), idx = [];
    for (let i = 0; i < s.length; i++) if (!isN(s[i])) idx.push(i);
    if (idx.length < n) return out;
    let sum = 0; for (let k = 0; k < n; k++) sum += s[idx[k]];
    let prev = sum / n; out[idx[n - 1]] = prev;
    for (let k = n; k < idx.length; k++) { prev = (prev * (n - 1) + s[idx[k]]) / n; out[idx[k]] = prev; }
    return out;
  }
  function rsi(close, n) {
    const d = close.map((v, i) => (i === 0 ? NaN : v - close[i - 1]));
    const g = d.map((v) => (isN(v) ? NaN : Math.max(v, 0))), l = d.map((v) => (isN(v) ? NaN : Math.max(-v, 0)));
    const ag = wilder(g, n), al = wilder(l, n);
    return ag.map((a, i) => (isN(a) ? NaN : al[i] === 0 ? 100 : 100 - 100 / (1 + a / al[i])));
  }

  function zones(close, confirm = SELL_CONFIRM) {
    const n = close.length;
    const ma200 = rollFull(close, 200, meanf), hi252 = rollFull(close, 252, maxf);
    const dd52 = close.map((c, i) => c / hi252[i] - 1), dist200 = close.map((c, i) => c / ma200[i] - 1);
    const rsi14 = rsi(close, 14), rsi2 = rsi(close, 2);
    const ret20 = close.map((c, i) => (i >= 20 ? (c / close[i - 20] - 1) * 100 : NaN));
    const above = close.map((c, i) => c > ma200[i]);                         // NaN → false
    const cap = close.map((_, i) => ret20[i] <= -10 || rsi14[i] < 30);
    const code = arr(n, 0);
    for (let i = 0; i < n; i++) if (above[i] && ((dd52[i] <= -0.05 && dd52[i] > -0.1) || rsi2[i] < 10)) code[i] = 1;
    for (let i = 0; i < n; i++) if (dist200[i] >= 0.15 && rsi14[i] > 70) code[i] = -1;
    let seen = false;
    for (let i = 0; i < n; i++) {                                            // 매도2: 하락 국면 안에서 투매 전
      if (isN(dd52[i]) || isN(ma200[i])) continue;
      if (above[i] || dd52[i] > -0.05) seen = false;
      if (cap[i]) seen = true;
      if (!seen && !above[i] && dd52[i] > -0.2 && dd52[i] <= -0.1) code[i] = -2;
    }
    for (let i = 0; i < n; i++) if (above[i] && dd52[i] <= -0.1) code[i] = 2;
    for (let i = 0; i < n; i++) if (cap[i] && dd52[i] <= -0.05) code[i] = 22;
    for (let i = 0; i < n; i++) if (dd52[i] <= -0.3) code[i] = 3;
    for (let i = 0; i < n; i++) if (isN(ma200[i]) || isN(dd52[i])) code[i] = 0;
    const raw = code.map((x) => (x === 22 ? 2 : x));
    const state = raw.slice(); let run = 0;                                  // 매도 확인
    for (let i = 0; i < n; i++) { run = raw[i] < 0 ? run + 1 : 0; if (raw[i] < 0 && run < confirm) state[i] = 0; }
    const kind = state.map((s, i) => (code[i] === 22 && s === 2 ? KIND[22] : KIND[s]));
    return { state, raw, kind, dd52, dist200, rsi14, rsi2, ret20 };
  }

  // 오늘 상태 + 분할 계획 한 줄 (비중은 설계값)
  function describe(z, i) {
    const s = z.state[i], plan = PLAN[s] || null, kindKey = z.kind[i] === KIND[22] ? 22 : s;
    let since = 0; while (i - since - 1 >= 0 && z.state[i - since - 1] === s) since++;
    return { state: s, kind: z.kind[i], why: WHY[kindKey], side: plan ? plan[0] : null, fraction: plan ? plan[1] : 0,
             action: plan ? (plan[0] === "매수" ? `남은 현금의 ${plan[1] * 100}% 매수` : `보유분의 ${plan[1] * 100}% 매도(방어)`) + ` (같은 방향은 ${GAP_DAYS}거래일 간격)` : "대기",
             days: since + 1, dd52: z.dd52[i], dist200: z.dist200[i], rsi14: z.rsi14[i] };
  }
  return { zones, describe, rsi, KIND, PLAN, WHY, SELL_CONFIRM, GAP_DAYS };
});
