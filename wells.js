/*
 * 웅덩이 판정 로직 — 브라우저용 (core/indicators.py + core/wells.py + core/backtest.py 의 JS 이식)
 *
 * 파이썬 원본과 수치가 소수점 6자리까지 같아야 한다. tests/verify.js 가 실데이터로 대조한다.
 * 모든 계산은 그날까지의 자료만 쓴다 (look-ahead 없음).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Wells = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const NaN_ = Number.NaN;
  const isN = (x) => x !== x || x === null || x === undefined;
  const arr = (n, v = NaN_) => new Array(n).fill(v);

  // ───────────────────────── 지표 ─────────────────────────
  // Wilder 평활: NaN 은 건너뛰고, 첫 값은 n개 단순평균, 이후 (이전×(n-1)+오늘)/n
  function wilder(s, n) {
    const out = arr(s.length);
    const idx = [];
    for (let i = 0; i < s.length; i++) if (!isN(s[i])) idx.push(i);
    if (idx.length < n) return out;
    let sum = 0;
    for (let k = 0; k < n; k++) sum += s[idx[k]];
    let prev = sum / n;
    out[idx[n - 1]] = prev;
    for (let k = n; k < idx.length; k++) {
      prev = (prev * (n - 1) + s[idx[k]]) / n;
      out[idx[k]] = prev;
    }
    return out;
  }
  function ewm(s, span) {              // pandas ewm(span, adjust=False)
    const a = 2 / (span + 1);
    const out = arr(s.length);
    let prev = NaN_;
    for (let i = 0; i < s.length; i++) {
      if (isN(s[i])) { out[i] = prev; continue; }
      prev = isN(prev) ? s[i] : a * s[i] + (1 - a) * prev;
      out[i] = prev;
    }
    return out;
  }
  function rollMean(s, n, minp = n) {
    const out = arr(s.length);
    let sum = 0, cnt = 0;
    for (let i = 0; i < s.length; i++) {
      if (!isN(s[i])) { sum += s[i]; cnt++; }
      if (i >= n) { const o = s[i - n]; if (!isN(o)) { sum -= o; cnt--; } }
      if (cnt >= minp && i >= n - 1) out[i] = sum / cnt;
    }
    return out;
  }
  function rollStd0(s, n) {            // ddof=0, 2-pass 로 정확하게
    const out = arr(s.length);
    for (let i = n - 1; i < s.length; i++) {
      let m = 0, ok = true;
      for (let j = i - n + 1; j <= i; j++) { if (isN(s[j])) { ok = false; break; } m += s[j]; }
      if (!ok) continue;
      m /= n; let v = 0;
      for (let j = i - n + 1; j <= i; j++) v += (s[j] - m) ** 2;
      out[i] = Math.sqrt(v / n);
    }
    return out;
  }
  function rollMax(s, n, minp = n) {
    const out = arr(s.length);
    for (let i = 0; i < s.length; i++) {
      let m = -Infinity, cnt = 0;
      for (let j = Math.max(0, i - n + 1); j <= i; j++) if (!isN(s[j])) { cnt++; if (s[j] > m) m = s[j]; }
      if (cnt >= minp && i >= minp - 1) out[i] = m;
    }
    return out;
  }
  function rollMin(s, n) {
    const out = arr(s.length);
    for (let i = n - 1; i < s.length; i++) {
      let m = Infinity, ok = true;
      for (let j = i - n + 1; j <= i; j++) { if (isN(s[j])) { ok = false; break; } if (s[j] < m) m = s[j]; }
      if (ok) out[i] = m;
    }
    return out;
  }
  const shift = (s, k) => s.map((_, i) => (i - k >= 0 && i - k < s.length ? s[i - k] : NaN_));
  const diff = (s) => s.map((v, i) => (i === 0 || isN(s[i - 1]) || isN(v) ? NaN_ : v - s[i - 1]));

  function rsi(close, n = 14) {
    const d = diff(close);
    const gain = d.map((v) => (isN(v) ? NaN_ : Math.max(v, 0)));
    const loss = d.map((v) => (isN(v) ? NaN_ : Math.max(-v, 0)));
    const ag = wilder(gain, n), al = wilder(loss, n);
    return ag.map((g, i) => {
      if (isN(g)) return NaN_;
      if (al[i] === 0) return 100;
      return 100 - 100 / (1 + g / al[i]);
    });
  }
  function macd(close, fast = 12, slow = 26, sig = 9) {
    const ef = ewm(close, fast), es = ewm(close, slow);
    const line = ef.map((v, i) => v - es[i]);
    const signal = ewm(line, sig);
    return { line, signal, hist: line.map((v, i) => v - signal[i]) };
  }
  function trueRange(h, l, c) {
    return h.map((hv, i) => {
      if (i === 0) return hv - l[i];        // 첫날은 전일 종가가 없어 고가-저가만 (pandas max 가 NaN 을 건너뛰는 것과 동일)
      const pc = c[i - 1];
      return Math.max(hv - l[i], Math.abs(hv - pc), Math.abs(l[i] - pc));
    });
  }
  const atr = (h, l, c, n = 14) => wilder(trueRange(h, l, c), n);
  function adx(h, l, c, n = 14) {
    const up = diff(h), dn = diff(l).map((v) => -v);
    // np.where: NaN 비교는 False → 0.0 (NaN 이 아니다)
    const plus = up.map((u, i) => (u > dn[i] && u > 0 ? u : 0));
    const minus = dn.map((d, i) => (d > up[i] && d > 0 ? d : 0));
    const a = wilder(trueRange(h, l, c), n);
    const wp = wilder(plus, n), wm = wilder(minus, n);
    const pdi = wp.map((v, i) => (100 * v) / a[i]);
    const mdi = wm.map((v, i) => (100 * v) / a[i]);
    const dx = pdi.map((p, i) => { const s = p + mdi[i]; return s === 0 ? NaN_ : (100 * Math.abs(p - mdi[i])) / s; });
    return { adx: wilder(dx, n), pdi, mdi };
  }
  function bollinger(close, n = 20, k = 2) {
    const mid = rollMean(close, n), sd = rollStd0(close, n);
    const up = mid.map((m, i) => m + k * sd[i]), lo = mid.map((m, i) => m - k * sd[i]);
    return { mid, up, lo, width: up.map((u, i) => (u - lo[i]) / mid[i]) };
  }
  function keltner(h, l, c, n = 20, k = 1.5) {
    const mid = ewm(c, n), a = atr(h, l, c, n);
    return { mid, up: mid.map((m, i) => m + k * a[i]), lo: mid.map((m, i) => m - k * a[i]) };
  }
  function squeeze(h, l, c, n = 20) {
    const b = bollinger(c, n, 2), kc = keltner(h, l, c, n, 1.5);
    return b.up.map((bu, i) => bu < kc.up[i] && b.lo[i] > kc.lo[i]);   // NaN 비교 → false
  }
  function pctRank(s, lookback = 126) {
    const out = arr(s.length);
    for (let i = lookback - 1; i < s.length; i++) {
      let ok = true, cnt = 0;
      const last = s[i];
      for (let j = i - lookback + 1; j <= i; j++) { if (isN(s[j])) { ok = false; break; } if (s[j] < last) cnt++; }
      if (ok) out[i] = cnt / (lookback - 1);
    }
    return out;
  }
  // n일 고점이 찍힌 뒤 며칠 지났나 (같은 값이면 먼저 찍힌 쪽 = np.argmax 규칙)
  function daysSinceHigh(close, n = 252, minp = 20) {
    const out = arr(close.length);
    for (let i = 0; i < close.length; i++) {
      const lo = Math.max(0, i - n + 1);
      let mx = -Infinity, at = -1, cnt = 0;
      for (let j = lo; j <= i; j++) { if (isN(close[j])) continue; cnt++; if (close[j] > mx) { mx = close[j]; at = j; } }
      if (cnt >= minp && i >= minp - 1) out[i] = i - at;
    }
    return out;
  }
  function daysSinceLow(close, n = 252, minp = 20) {
    const out = arr(close.length);
    for (let i = 0; i < close.length; i++) {
      const lo = Math.max(0, i - n + 1);
      let mn = Infinity, at = -1, cnt = 0;
      for (let j = lo; j <= i; j++) { if (isN(close[j])) continue; cnt++; if (close[j] < mn) { mn = close[j]; at = j; } }
      if (cnt >= minp && i >= minp - 1) out[i] = i - at;
    }
    return out;
  }
  function drawdown(close, n = 252) {
    const peak = rollMax(close, n, 20);
    return { dd: close.map((c, i) => c / peak[i] - 1), peak };
  }
  // 지그재그 꼭지·바닥. [{i, v, t:'H'|'L', conf}] conf = 확정되는 인덱스 (i+w)
  function swings(close, w = 5) {
    const n = close.length, pts = [];
    const win = 2 * w + 1;
    const hs = [], ls = [];
    for (let i = w; i <= n - 1 - w; i++) {
      let mx = -Infinity, mn = Infinity, ok = true;
      for (let j = i - w; j <= i + w; j++) { if (isN(close[j])) { ok = false; break; } if (close[j] > mx) mx = close[j]; if (close[j] < mn) mn = close[j]; }
      if (!ok) continue;
      if (close[i] === mx) hs.push({ i, v: close[i], t: "H", conf: Math.min(i + w, n - 1) });
      if (close[i] === mn) ls.push({ i, v: close[i], t: "L", conf: Math.min(i + w, n - 1) });
    }
    const all = hs.concat(ls).sort((a, b) => a.i - b.i);   // 안정 정렬: 같은 날이면 H 가 앞
    const out = [];
    for (const p of all) {
      if (out.length && out[out.length - 1].t === p.t) {
        const q = out[out.length - 1];
        const keep = p.t === "H" ? Math.max(q.v, p.v) : Math.min(q.v, p.v);
        if (keep === p.v) out[out.length - 1] = p;
        continue;
      }
      out.push(p);
    }
    return out;
  }
  function isContracting(depths, tol = 0.02) {
    if (depths.length < 2) return false;
    for (let k = 1; k < depths.length; k++) if (!(depths[k] > depths[k - 1] - tol)) return false;
    return true;
  }
  function rollMin252(s, n = 252, minp = 20) {
    const out = arr(s.length);
    for (let i = 0; i < s.length; i++) {
      let m = Infinity, cnt = 0;
      for (let j = Math.max(0, i - n + 1); j <= i; j++) if (!isN(s[j])) { cnt++; if (s[j] < m) m = s[j]; }
      if (cnt >= minp && i >= minp - 1) out[i] = m;
    }
    return out;
  }
  function maSlope(close, n = 150, look = 20) {
    const ma = rollMean(close, n);
    return ma.map((m, i) => (i - look >= 0 ? m / ma[i - look] - 1 : NaN_));
  }

  function enrich(o) {
    const { open, high, low, close, volume } = o;
    const d = { open, high, low, close, volume };
    d.rsi14 = rsi(close, 14);
    const m = macd(close); d.macd = m.line; d.macd_sig = m.signal; d.macd_hist = m.hist;
    d.atr14 = atr(high, low, close, 14);
    d.atr_pct = d.atr14.map((a, i) => a / close[i]);
    const b = bollinger(close, 20, 2); d.bb_up = b.up; d.bb_low = b.lo; d.bb_width = b.width;
    d.bb_width_rank = pctRank(d.bb_width, 126);
    d.squeeze_on = squeeze(high, low, close, 20);
    const a = adx(high, low, close, 14); d.adx14 = a.adx; d.di_plus = a.pdi; d.di_minus = a.mdi;
    const dd = drawdown(close, 252); d.dd_52w = dd.dd; d.peak_52w = dd.peak;
    d.days_high = daysSinceHigh(close, 252); d.days_low = daysSinceLow(close, 252);
    d.low_52w = rollMin252(close); d.off_low = close.map((c, i) => c / d.low_52w[i] - 1);
    d.ma20 = rollMean(close, 20); d.ma20_slope = d.ma20.map((m, i) => (i - 10 >= 0 ? m / d.ma20[i - 10] - 1 : NaN_));
    d.ma150_slope = maSlope(close, 150, 20);
    d.ma200 = rollMean(close, 200);
    d.vol20 = rollMean(volume, 20); d.vol60 = rollMean(volume, 60);
    d.vol_ratio = d.vol20.map((v, i) => v / d.vol60[i]);
    return d;
  }

  // ───────────────────────── 웅덩이 점수 ─────────────────────────
  const P = {
    DECLINE_BELOW: -0.05, FLAT_SLOPE: 0.03, BASE_NEAR: -0.12, EXT_MIN: 0.15, EXT_ATR: 6.0,
    NEAR_HIGH: -0.03, TOP_ZONE: -0.05, BASE_MIN_DD: -0.08, GATE_LO: 0.5, GATE_HI: 2.0,
    GATE_ABS: [0.03, 0.06], TIME_GATE: [15, 45], TIME_PTS: [20, 80], RECOVER_OFF_LOW: 0.15,
    BASE_NEAR_ATR: 6.0, NEW_LOW_DAYS: 10, RECOVER_MIN_DAYS: 15,
  };
  const REGIME_MULT = { 바닥형: 1.0, 눌림형: 1.0, 고점권: 0.7, 회복형: 0.8, 하락형: 0.5, 과열형: 0.7, 판단보류: 0.8 };
  const REGIME_DESC = {
    바닥형: "떨어진 뒤 150일선이 평평 — 바닥을 다지는 중",
    눌림형: "상승 추세 안에서 쉬어가는 조정",
    고점권: "고점 코앞 — 눌린 적이 없어 웅덩이가 아님",
    회복형: "200일선 아래지만 저점에서 올라오는 중 — 바닥은 아직 미확인",
    하락형: "200일선 아래로 무너지는 중 — 떨어지는 칼날",
    과열형: "200일선 한참 위 + 신고가권 — 과열",
    판단보류: "자료 부족 또는 애매한 구간",
  };
  const clip01 = (x) => (isN(x) ? NaN_ : Math.min(1, Math.max(0, x)));
  const ramp = (x, lo, hi) => clip01((x - lo) / (hi - lo));
  const round1 = (x) => {                 // numpy 방식: 0.05 는 짝수 쪽으로 (banker's rounding)
    const y = x * 10, f = Math.floor(y), r = y - f;
    const q = r === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(y);
    return q / 10;
  };
  const band = (x, a, b, c, d) => { const p = ramp(x, a, b), q = ramp(x, d, c); return isN(p) || isN(q) ? NaN_ : Math.min(p, q); };

  function regime(above200, slope150, dd52, atrPct = 0.015, offLow = NaN_, ma20Slope = NaN_, daysLow = NaN_) {
    if (isN(above200) || isN(slope150) || isN(dd52)) return "판단보류";
    const ap = isN(atrPct) ? 0.015 : atrPct;
    if (!isN(daysLow) && daysLow < P.NEW_LOW_DAYS) return "하락형";
    if (above200 < 0 && !isN(offLow) && !isN(ma20Slope) && offLow >= P.RECOVER_OFF_LOW && ma20Slope > 0
        && (isN(daysLow) || daysLow >= P.RECOVER_MIN_DAYS)) return "회복형";
    const baseNear = -Math.max(-P.BASE_NEAR, P.BASE_NEAR_ATR * ap);
    if ((above200 < P.DECLINE_BELOW && slope150 < 0) || above200 < baseNear) return "하락형";
    const ext = Math.max(P.EXT_MIN, P.EXT_ATR * ap);
    if (above200 > ext && dd52 > P.NEAR_HIGH) return "과열형";
    if (dd52 > P.TOP_ZONE && above200 > 0) return "고점권";
    if (Math.abs(slope150) <= P.FLAT_SLOPE && dd52 <= P.BASE_MIN_DD) return "바닥형";
    if (slope150 > 0 && above200 > 0) return "눌림형";
    return "판단보류";
  }

  // 날짜별로 '그날까지 알 수 있었던' 조정 폭들 (인과적)
  function vcpFrame(close, w = 5, last = 3) {
    const pts = swings(close, w);
    const n = close.length;
    const vn = arr(n), vlast = arr(n), vfirst = arr(n), vok = arr(n, false);
    const known = [];
    let k = 0;
    // 진행 중 조정: 마지막 H 이후 최저가를 점진적으로 추적
    let runMin = Infinity, runH = -1;
    for (let i = 0; i < n; i++) {
      let added = false;
      while (k < pts.length && pts[k].conf <= i) { known.push(pts[k]); k++; added = true; }
      let depths = [];
      for (let a = 0; a + 1 < known.length; a++) {
        const p = known[a], q = known[a + 1];
        if (p.t === "H" && q.t === "L" && p.v > 0) depths.push(q.v / p.v - 1);
      }
      const lastPt = known.length ? known[known.length - 1] : null;
      if (lastPt && lastPt.t === "H") {
        if (runH !== lastPt.i) {                 // 새 꼭지: 꼭지일부터 다시 최저가 추적
          runH = lastPt.i; runMin = Infinity;
          for (let j = lastPt.i; j <= i; j++) if (close[j] < runMin) runMin = close[j];
        } else if (close[i] < runMin) runMin = close[i];
        if (i - lastPt.i + 1 > 1 && lastPt.v > 0) {
          const dep = runMin / lastPt.v - 1;
          if (dep <= -0.03) depths.push(dep);
        }
      }
      depths = depths.slice(-last);
      vn[i] = depths.length;
      vlast[i] = depths.length ? depths[depths.length - 1] : NaN_;
      vfirst[i] = depths.length ? depths[0] : NaN_;
      vok[i] = isContracting(depths);
    }
    return { vcp_n: vn, vcp_last: vlast, vcp_first: vfirst, vcp_ok: vok };
  }

  function score(d) {
    const n = d.close.length, c = d.close;
    d.above200 = c.map((v, i) => v / d.ma200[i] - 1);
    d.regime = c.map((_, i) => regime(d.above200[i], d.ma150_slope[i], d.dd_52w[i], d.atr_pct[i], d.off_low[i], d.ma20_slope[i], d.days_low[i]));
    d.regime_mult = d.regime.map((r) => REGIME_MULT[r]);
    d.depth_atr = d.dd_52w.map((dd, i) => (d.atr_pct[i] === 0 || isN(d.atr_pct[i]) ? NaN_ : -dd / d.atr_pct[i]));
    d.s_depth = d.depth_atr.map((x) => 20 * band(x, 1, 3, 15, 30));
    d.depth_gate = d.depth_atr.map((x, i) => { const p = ramp(x, P.GATE_LO, P.GATE_HI), q = ramp(-d.dd_52w[i], P.GATE_ABS[0], P.GATE_ABS[1]); return isN(p) || isN(q) ? NaN_ : Math.min(p, q); });
    const sqMean = rollMean(d.squeeze_on.map((b) => (b ? 1 : 0)), 20);
    d.s_squeeze = d.bb_width_rank.map((r, i) => 15 * ramp(r, 0.5, 0.1) + 10 * ramp(sqMean[i], 0, 0.5));
    const v = vcpFrame(c); Object.assign(d, v);
    d.s_vcp = d.vcp_ok.map((ok, i) => {
      const f = Math.abs(d.vcp_first[i]), l = Math.abs(d.vcp_last[i]);
      const shrink = f > 0 ? l / f : NaN_;
      return 12 * (ok ? 1 : 0) + 8 * ramp(shrink, 1.0, 0.4);
    });
    d.s_volume = d.vol_ratio.map((r) => 15 * ramp(r, 1.05, 0.75));
    d.s_base = d.ma150_slope.map((s) => 5 * ramp(Math.abs(s), 0.04, 0.005));
    d.s_time = d.days_high.map((x) => 5 * ramp(x, P.TIME_PTS[0], P.TIME_PTS[1]));
    d.time_gate = d.days_high.map((x) => ramp(x, P.TIME_GATE[0], P.TIME_GATE[1]));
    const rsiMin10 = rollMin(d.rsi14, 10);
    d.s_momentum = c.map((_, i) => {
      const hu = i >= 5 && d.macd_hist[i] > d.macd_hist[i - 5] ? 1 : 0;
      const ru = d.rsi14[i] > rsiMin10[i] + 3 ? 1 : 0;      // NaN 비교 → false
      return 5 * hu + 5 * ru;
    });
    const parts = ["s_depth", "s_squeeze", "s_vcp", "s_volume", "s_base", "s_time", "s_momentum"];
    d.score_raw = c.map((_, i) => parts.reduce((s, p) => s + (isN(d[p][i]) ? 0 : d[p][i]), 0)); // pandas sum 은 NaN 을 0 으로
    d.score = d.score_raw.map((r, i) => { const s = r * d.regime_mult[i] * d.depth_gate[i] * d.time_gate[i]; return isN(s) ? NaN_ : round1(s); });
    d.box_top = shift(rollMax(d.high, 20), 1);
    const sc10 = shift(rollMax(d.score, 10), 1);
    d.breakout = c.map((v, i) => v > d.box_top[i] && d.volume[i] > d.vol20[i] * 1.5 && sc10[i] >= 60);
    return d;
  }

  function explain(d, i) {
    const f = (x, k = 1) => (isN(x) ? "—" : x.toFixed(k));
    const pct = (x) => (isN(x) ? "—" : (x * 100 >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%");
    return [
      ["눌림 깊이", d.s_depth[i], 20, isN(d.depth_atr[i]) ? "—" : `고점대비 ${pct(d.dd_52w[i])} = ${f(d.depth_atr[i])} ATR` + (d.depth_gate[i] < 0.999 ? ` · 깊이 자격 ×${f(d.depth_gate[i], 2)}` : "")],
      ["변동성 압축", d.s_squeeze[i], 25, isN(d.bb_width_rank[i]) ? "—" : `밴드폭 하위 ${f(d.bb_width_rank[i] * 100, 0)}%`],
      ["조정 수축", d.s_vcp[i], 20, d.vcp_n[i] >= 2 ? `${pct(d.vcp_first[i])} → ${pct(d.vcp_last[i])}` : "조정 부족"],
      ["거래량 고갈", d.s_volume[i], 15, `20일/60일 ${f(d.vol_ratio[i], 2)}`],
      ["바닥 다지기", d.s_base[i], 5, `150일선 기울기 ${pct(d.ma150_slope[i])}`],
      ["시간 조정", d.s_time[i], 5, isN(d.days_high[i]) ? "—" : `고점 이후 ${f(d.days_high[i], 0)}일` + (d.time_gate[i] < 0.999 ? ` · 시간 자격 ×${f(d.time_gate[i], 2)}` : "")],
      ["모멘텀 전환", d.s_momentum[i], 10, `RSI ${f(d.rsi14[i], 0)} · MACD ${f(d.macd_hist[i], 2)}`],
    ];
  }


  // ───────────────────────── 저점매수 점수 (buyzone.py) ─────────────────────────
  const DIP = { MIN: 0.04, ATR: 3.0, LOOK: 20, RECENT: 10, FRESH: 3, COOL: 10 };
  function rollMedian(s, n, minp) {
    const out = arr(s.length);
    for (let i = 0; i < s.length; i++) {
      const w = []; for (let j = Math.max(0, i - n + 1); j <= i; j++) if (!isN(s[j])) w.push(s[j]);
      if (w.length >= minp && i >= minp - 1) { w.sort((a, b) => a - b); const m = w.length >> 1; out[i] = w.length % 2 ? w[m] : (w[m - 1] + w[m]) / 2; }
    }
    return out;
  }

  const BZ = { DEPTH_GATE_ATR: [1.5, 4.0], DEPTH_GATE_ABS: [0.05, 0.10], DEPTH_PTS_ATR: [3.0, 10.0],
               SLOPE_LOOK: 10, SLOPE_MIN_WIN: 60, ACCEL_MULT: 0.3, V_RSI: 40,
               TREND_UP: 1.25, TREND_DOWN: 0.70 };   // 등급 추세 보정 (상승 가점 / 하락 감점)
  function rollMinWin(s, n) {          // NaN 은 건너뛰고 창 안에 하나라도 있으면 값 (pandas rolling.min 기본 min_periods=n 이라 NaN 포함 창은 NaN)
    const out = arr(s.length);
    for (let i = n - 1; i < s.length; i++) {
      let m = Infinity, ok = true;
      for (let j = i - n + 1; j <= i; j++) { if (isN(s[j])) { ok = false; break; } if (s[j] < m) m = s[j]; }
      if (ok) out[i] = m;
    }
    return out;
  }
  function rollMinP(s, n, minp) {      // min_periods 지원
    const out = arr(s.length);
    for (let i = 0; i < s.length; i++) {
      let m = Infinity, cnt = 0;
      for (let j = Math.max(0, i - n + 1); j <= i; j++) if (!isN(s[j])) { cnt++; if (s[j] < m) m = s[j]; }
      if (cnt >= minp && i >= minp - 1) out[i] = m;
    }
    return out;
  }
  function daysSinceLowP(close, n, minp) {
    const out = arr(close.length);
    for (let i = 0; i < close.length; i++) {
      let mn = Infinity, at = -1, cnt = 0;
      for (let j = Math.max(0, i - n + 1); j <= i; j++) { if (isN(close[j])) continue; cnt++; if (close[j] < mn) { mn = close[j]; at = j; } }
      if (cnt >= minp && i >= minp - 1) out[i] = i - at;
    }
    return out;
  }
  function buyzone(d) {
    const c = d.close, n = c.length;
    const atr = d.atr_pct.map((a) => (a === 0 ? NaN_ : a));
    d.depth_atr = d.dd_52w.map((dd, i) => -dd / atr[i]);
    d.bz_depth = d.depth_atr.map((x) => 20 * ramp(x, ...BZ.DEPTH_PTS_ATR));
    d.depth_gate = d.depth_atr.map((x, i) => { const p = ramp(x, ...BZ.DEPTH_GATE_ATR), q = ramp(-d.dd_52w[i], ...BZ.DEPTH_GATE_ABS); return isN(p) || isN(q) ? NaN_ : Math.min(p, q); });
    const ma20 = rollMean(c, 20);
    const slope = ma20.map((m, i) => (i - BZ.SLOPE_LOOK >= 0 ? (m / ma20[i - BZ.SLOPE_LOOK] - 1) / atr[i] : NaN_));
    d.slope20_atr = slope;
    const smin = rollMinWin(slope, BZ.SLOPE_MIN_WIN); d.slope_min = smin;
    d.slope_recov = slope.map((s, i) => (smin[i] < -0.5 ? (s - smin[i]) / -smin[i] : NaN_));
    // 떨어진 적이 없으면(최저 기울기가 -0.5 ATR 보다 완만) '감속'이라 할 게 없다 → 0
    d.bz_decel = slope.map((s, i) => { const v = 15 * ramp(d.slope_recov[i], 0.3, 0.9) + 15 * ramp(Math.abs(s), 3.0, 0.5); return isN(v) ? 0 : v; });
    d.accel_gate = slope.map((s, i) => (!isN(s) && !isN(smin[i]) && s <= smin[i] + 1e-12 ? BZ.ACCEL_MULT : 1.0));
    const low60 = rollMinP(c, 60, 20);
    d.days_low60 = daysSinceLowP(c, 60, 20);
    d.bz_hold = d.days_low60.map((x) => 15 * ramp(x, 3, 20));
    d.off_low60_atr = c.map((v, i) => (v / low60[i] - 1) / atr[i]);
    d.bz_near = d.off_low60_atr.map((x) => 15 * ramp(x, 8.0, 2.0));
    const rsiMin20 = rollMinWin(d.rsi14, 20);
    d.bz_rsi = d.rsi14.map((r, i) => 10 * ramp(r - rsiMin20[i], 0, 8) * ramp(r, 65, 55));
    d.bz_volume = d.vol_ratio.map((r) => 10 * ramp(r, 1.10, 0.75));
    const parts = ["bz_depth", "bz_decel", "bz_hold", "bz_near", "bz_rsi", "bz_volume"];
    d.bz_raw = c.map((_, i) => parts.reduce((s, p) => s + (isN(d[p][i]) ? 0 : d[p][i]), 0));
    d.bz_base = d.bz_raw.map((r, i) => r * d.depth_gate[i] * d.accel_gate[i]);
    // V자형 경로: 과매도 뒤 첫 반등. 가속 자격 없음
    // 눌림은 52주 고점이 아니라 '최근 20일 고점' 대비. 낙폭은 날마다 잰 (종가/20일고점-1) 의 최근 10일 최저
    const hi20 = shift(rollMax(c, DIP.LOOK), 1);
    const dd20 = c.map((v, i) => v / hi20[i] - 1);
    const vDip = rollMin(dd20, 10).map((x) => -x);
    const atrMed = rollMedian(d.atr_pct, 60, 20);
    d.dip_need = atrMed.map((a) => Math.max(DIP.MIN, DIP.ATR * a));
    d.v_dip_ratio = vDip.map((x, i) => x / d.dip_need[i]);
    d.v_depth = d.v_dip_ratio.map((r) => 20 * ramp(r, 1.0, 3.0));
    d.v_gate = d.v_dip_ratio.map((r) => ramp(r, 0.8, 1.3));
    d.rsi_min5 = rollMinWin(d.rsi14, 10);
    d.v_oversold = d.rsi_min5.map((r) => 40 * ramp(BZ.V_RSI - r, 0, 10));
    const hi3 = c.map((_, i) => (i >= 3 ? Math.max(c[i - 1], c[i - 2], c[i - 3]) : NaN_));
    d.v_turn = c.map((v, i) => 15 * (i >= 1 && v > c[i - 1] ? 1 : 0) + 10 * (v > hi3[i] ? 1 : 0));
    const vr = d.volume.map((v, i) => v / d.vol20[i]);
    const climax = c.map((_, i) => { if (i < 4) return NaN_; let m = -Infinity, ok = true; for (let j = i - 4; j <= i; j++) { if (isN(vr[j])) { ok = false; break; } if (vr[j] > m) m = vr[j]; } return ok ? m : NaN_; });
    d.v_climax = climax.map((x) => 15 * ramp(x, 1.0, 1.5));
    d.bz_v_raw = c.map((_, i) => (isN(d.v_depth[i]) ? 0 : d.v_depth[i]) + (isN(d.v_oversold[i]) ? 0 : d.v_oversold[i]) + d.v_turn[i] + (isN(d.v_climax[i]) ? 0 : d.v_climax[i]));
    d.bz_v = d.bz_v_raw.map((r, i) => (isN(d.v_oversold[i]) || isN(d.v_climax[i]) || isN(d.v_gate[i]) ? NaN_ : r * d.v_gate[i]));
    d.path = c.map((_, i) => (d.bz_v[i] > d.bz_base[i] ? "V자" : "다지기"));
    // ── 추세 보정 (buyzone.py 와 동일). 상승추세 = 종가가 200일선 위 + 200일선이 20일 전보다 높음
    //    pandas 의 (c > ma200) & (ma200 > ma200.shift(20)) 는 NaN 비교가 False 이므로 여기서도 그렇게 맞춘다
    d.trend_up = c.map((x, i) => {
      const m = d.ma200[i], m20 = i >= 20 ? d.ma200[i - 20] : NaN_;
      return !isN(m) && !isN(m20) && x > m && m > m20;
    });
    d.trend_mult = d.trend_up.map((u) => (u ? BZ.TREND_UP : BZ.TREND_DOWN));
    d.bz = c.map((_, i) => { const a = d.bz_base[i], b = d.bz_v[i]; return isN(a) || isN(b) ? NaN_ : round1(Math.min(100, Math.max(a, b) * d.trend_mult[i])); });   // np.maximum: 한쪽이 NaN 이면 NaN
    return d;
  }
  function explainBZ(d, i) {
    const f = (x, k = 1) => (isN(x) ? "—" : x.toFixed(k));
    const pct = (x) => (isN(x) ? "—" : (x * 100 >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%");
    const trend = [["추세 보정", 0, 0, (d.trend_up[i] ? "상승추세 (200일선 위·상승 중)" : "하락추세 (200일선 아래이거나 하락 중)") + ` — 등급 ×${f(d.trend_mult[i], 2)}`]];
    if (d.path[i] === "V자") return trend.concat([
      ["눌림", d.v_depth[i], 20, `20일 고점 대비 낙폭이 단기 저점 조건의 ${f(d.v_dip_ratio[i])}배` + (d.v_gate[i] < 0.999 ? ` · 자격 ×${f(d.v_gate[i], 2)}` : "")],
      ["과매도 깊이", d.v_oversold[i], 40, `최근 10일 RSI 최저 ${f(d.rsi_min5[i], 0)}`],
      ["반전 확인", d.v_turn[i], 25, d.v_turn[i] > 0 ? "종가 > 어제" + (d.v_turn[i] >= 25 ? " · > 3일 고가" : "") : "아직 반등 없음"],
      ["투매 거래량", d.v_climax[i], 15, d.v_climax[i] > 0 ? "최근 5일 거래량 급증" : "거래량 평범"],
    ]);
    return trend.concat([
      ["눌림", d.bz_depth[i], 20, `고점대비 ${pct(d.dd_52w[i])} = ${f(d.depth_atr[i])} ATR` + (d.depth_gate[i] < 0.999 ? ` · 자격 ×${f(d.depth_gate[i], 2)}` : "")],
      ["감속", d.bz_decel[i], 30, `20일선 기울기 ${f(d.slope20_atr[i])} ATR (60일 최저 ${f(d.slope_min[i])}) · 회복 ${f(d.slope_recov[i] * 100, 0)}%` + (d.accel_gate[i] < 1 ? " · 가속 하락 중 ×0.3" : "")],
      ["저점 유지", d.bz_hold[i], 15, `60일 저점 이후 ${f(d.days_low60[i], 0)}일`],
      ["저점 근접", d.bz_near[i], 15, `60일 저점 위 ${f(d.off_low60_atr[i])} ATR`],
      ["과매도 해소", d.bz_rsi[i], 10, `RSI ${f(d.rsi14[i], 0)}`],
      ["거래량 고갈", d.bz_volume[i], 10, `20일/60일 ${f(d.vol_ratio[i], 2)}`],
    ]);
  }

  // ───────────────────────── 단기 저점 감지 (buyzone.swing_low) ─────────────────────────
  // 20일 고점에서 max(4%, 3×ATR) 이상 빠진 뒤, 최근 5일 저점 + 오늘 종가 > 직전 3일 종가 + 아직 낙폭 아래 절반. 10거래일 재신호 금지
  function swingLow(d) {
    const c = d.close, n = c.length;
    const hi20 = shift(rollMax(c, DIP.LOOK), 1);
    const lo5 = rollMin(c, DIP.RECENT);
    const hi3 = shift(rollMax(c, 3), 1);
    const dd20 = c.map((v, i) => v / hi20[i] - 1);
    d.dip_depth = rollMin(dd20, DIP.RECENT);
    // d.dip_need 는 buyzone() 에서 60일 중앙값 ATR 로 이미 계산
    const sinceLow = c.map((_, i) => { if (i < DIP.RECENT - 1) return NaN_; let m = Infinity, at = i; for (let j = i - DIP.RECENT + 1; j <= i; j++) if (c[j] < m) { m = c[j]; at = j; } return i - at; });
    d.swing_low = arr(n, false);
    let last = -1e9, lastLow = Infinity;
    for (let i = 0; i < n; i++) {
      const half = lo5[i] + (hi20[i] - lo5[i]) * 0.5;
      const raw = d.dip_depth[i] <= -d.dip_need[i] && c[i] > hi3[i] && (c[i] <= half || sinceLow[i] <= DIP.FRESH);
      // 재신호 금지 중이라도 이전 신호보다 낮은 저점이면 허용
      if (raw && (i - last > DIP.COOL || lo5[i] < lastLow)) { d.swing_low[i] = true; last = i; lastLow = lo5[i]; }
    }
    return d;
  }


  // ───────────────────────── 매수·매도 고려 시점 (signals.py) ─────────────────────────
  const HZ = { 단기: { key: "s", look: 20, dmin: 0.04, datr: 3.0, dmax: 0.20, confirm: 3, recent: 10, fresh: 3, cool: 10, eval: [20, 60, 120, 200], rsiW: 10 },
               중기: { key: "m", look: 60, dmin: 0.08, datr: 6.0, dmax: 1.0, confirm: 10, recent: 20, fresh: 5, cool: 20, eval: [60, 120, 200, 250], rsiW: 20 } };
  function sinceExt(c, n, isMin) {
    return c.map((_, i) => { if (i < n - 1) return NaN_; let m = isMin ? Infinity : -Infinity, at = i; for (let j = i - n + 1; j <= i; j++) if (isMin ? c[j] < m : c[j] > m) { m = c[j]; at = j; } return i - at; });
  }
  function events(raw, ext, cool, lowerBetter) {
    const sig = arr(raw.length, false); let last = -1e9, lastExt = lowerBetter ? Infinity : -Infinity;
    for (let i = 0; i < raw.length; i++) {
      const better = lowerBetter ? ext[i] < lastExt : ext[i] > lastExt;
      if (raw[i] && (i - last > cool || better)) { sig[i] = true; last = i; lastExt = ext[i]; }
    }
    return sig;
  }
  function detect(d, hz) {
    const p = HZ[hz], h = p.key, c = d.close, n = c.length;
    const atrMed = rollMedian(d.atr_pct, 60, 20);
    // 상한 20%: 변동성 큰 종목은 3×ATR 이 20% 를 넘어 깊은 눌림도 놓침 (signals.py 와 같음)
    const need = atrMed.map((a) => Math.min(p.dmax, Math.max(p.dmin, p.datr * a))); d[h + "_need"] = need;
    // 매수
    const hi = shift(rollMax(c, p.look), 1);
    const dip = rollMin(c.map((v, i) => v / hi[i] - 1), p.recent);
    const loR = rollMin(c, p.recent), upK = shift(rollMax(c, p.confirm), 1), sinceLo = sinceExt(c, p.recent, true);
    const rawB = c.map((v, i) => dip[i] <= -need[i] && v > upK[i] && (v <= loR[i] + (hi[i] - loR[i]) * 0.5 || sinceLo[i] <= p.fresh));
    d[h + "_dip"] = dip; d[h + "_buy"] = events(rawB, loR, p.cool, true);
    // 매도
    const lo = shift(rollMin(c, p.look), 1);
    const rise = rollMax(c.map((v, i) => v / lo[i] - 1), p.recent);
    const hiR = rollMax(c, p.recent), dnK = shift(rollMin(c, p.confirm), 1), sinceHi = sinceExt(c, p.recent, false);
    const rawS = c.map((v, i) => rise[i] >= need[i] && v < dnK[i] && (v >= hiR[i] - (hiR[i] - lo[i]) * 0.5 || sinceHi[i] <= p.fresh));
    d[h + "_rise"] = rise; d[h + "_sell"] = events(rawS, hiR, p.cool, false);
    // 매도 등급 (거울상)
    const rsiMax = rollMax(d.rsi14, p.rsiW), lo3 = shift(rollMin(c, 3), 1);
    const vr = d.volume.map((v, i) => v / d.vol20[i]);
    const climax = c.map((_, i) => { if (i < 4) return NaN_; let m = -Infinity, ok = true; for (let j = i - 4; j <= i; j++) { if (isN(vr[j])) { ok = false; break; } if (vr[j] > m) m = vr[j]; } return ok ? m : NaN_; });
    d[h + "_sell_grade"] = c.map((v, i) => { const r = rise[i] / need[i]; const g = (20 * ramp(r, 1, 3) + 40 * ramp(rsiMax[i] - 60, 0, 10) + 15 * (i >= 1 && v < c[i - 1] ? 1 : 0) + 10 * (v < lo3[i] ? 1 : 0) + 15 * ramp(climax[i], 1, 1.5)) * ramp(r, 0.8, 1.3); return isN(g) ? NaN_ : round1(g); });
    d[h + "_buy_grade"] = d.bz;
    return d;
  }
  function detectAll(d) { for (const hz of Object.keys(HZ)) detect(d, hz); return d; }

  // ───────────────────────── 사후 웅덩이 ZigZag (troughs.py) ─────────────────────────
  function zigzag(c, dth) {
    const n = c.length, pts = []; if (!n) return pts;
    let hi = 0, lo = 0, mode = null;
    for (let i = 1; i < n; i++) {
      if (mode === null) {
        if (c[i] > c[hi]) hi = i; if (c[i] < c[lo]) lo = i;
        if (c[i] <= c[hi] * (1 - dth)) { pts.push({ i: hi, v: c[hi], t: "H" }); mode = "down"; lo = i; }
        else if (c[i] >= c[lo] * (1 + dth)) { pts.push({ i: lo, v: c[lo], t: "L" }); mode = "up"; hi = i; }
      } else if (mode === "down") {
        if (c[i] < c[lo]) lo = i; else if (c[i] >= c[lo] * (1 + dth)) { pts.push({ i: lo, v: c[lo], t: "L" }); mode = "up"; hi = i; }
      } else {
        if (c[i] > c[hi]) hi = i; else if (c[i] <= c[hi] * (1 - dth)) { pts.push({ i: hi, v: c[hi], t: "H" }); mode = "down"; lo = i; }
      }
    }
    if (mode === "down") pts.push({ i: lo, v: c[lo], t: "L" }); else if (mode === "up") pts.push({ i: hi, v: c[hi], t: "H" });
    return pts;
  }
  function median(xs) { const v = xs.filter((x) => !isN(x)).sort((a, b) => a - b); if (!v.length) return NaN_; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; }
  function troughs(c, atrPct, minDays = 10) {
    const med = median(atrPct); const dth = Math.max(0.10, 5.0 * (isN(med) ? 0.015 : med));
    const pts = zigzag(c, dth), out = [];
    for (let k = 1; k < pts.length; k++) {
      const p = pts[k]; if (p.t !== "L" || pts[k - 1].t !== "H") continue;
      const h = pts[k - 1], confirmed = k < pts.length - 1;
      const line = p.v + (h.v - p.v) * 0.5;
      let s = h.i; while (s < p.i && c[s] > line) s++;
      let e = p.i; while (e < c.length - 1 && c[e + 1] <= line) e++;
      if (confirmed) e = Math.min(e, pts[k + 1].i);
      if (e - s + 1 < minDays && confirmed) continue;
      out.push({ peak: h.i, start: s, trough: p.i, end: e, depth: p.v / h.v - 1, days: e - s + 1, confirmed, threshold: dth });
    }
    return out;
  }
  // 실시간 점수가 사후 웅덩이를 잡았나: 몸통 안에서 점수 ≥ 문턱인 첫날
  function gradeTroughs(tr, score, thr) {
    return tr.map((w) => {
      let hit = -1, peak = -Infinity;
      for (let i = w.start; i <= w.end; i++) { if (!isN(score[i]) && score[i] > peak) peak = score[i]; if (hit < 0 && score[i] >= thr) hit = i; }
      return { ...w, hit, lag: hit >= 0 ? hit - w.trough : NaN_, peakScore: peak === -Infinity ? NaN_ : peak };
    });
  }
  // 분할매수 채점: 회차 동안 매일 같은 금액 → 평단(조화평균). 구간 끝 H일 뒤 가격 / 평단
  function tranche(c, a, b, H) {
    let inv = 0; for (let i = a; i <= b; i++) inv += 1 / c[i];
    const avg = (b - a + 1) / inv, end = b + H;
    if (end >= c.length) return { avg, ret: NaN_, mdd: NaN_ };
    let mn = Infinity; for (let i = b; i <= end; i++) if (c[i] < mn) mn = c[i];
    return { avg, ret: c[end] / avg - 1, mdd: mn / avg - 1 };
  }
  function trancheStats(c, eps, H, nIter = 1000, seed = 0) {
    const rows = eps.map(([a, b]) => ({ a, b, len: b - a + 1, ...tranche(c, a, b, H) })).filter((r) => !isN(r.ret));
    if (!rows.length) return null;
    const obs = mean(rows.map((r) => r.ret)), obsMdd = mean(rows.map((r) => r.mdd));
    let s = seed + 7; const rand = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e9) / 1e9; };
    let ge = 0, tot = 0, totM = 0;
    for (let it = 0; it < nIter; it++) {
      let v = 0, m = 0;
      for (const r of rows) { const ia = Math.floor(rand() * (c.length - r.len - H)); const t = tranche(c, ia, ia + r.len - 1, H); v += t.ret; m += t.mdd; }
      v /= rows.length; m /= rows.length; tot += v; totM += m; if (v >= obs) ge++;
    }
    return { n: rows.length, obs, obsMdd, rnd: tot / nIter, rndMdd: totM / nIter, p: ge / nIter, rows };
  }

  // ───────────────────────── 회차·검정 (backtest.py) ─────────────────────────
  function episodes(mask) {
    const out = []; let start = null;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] && start === null) start = i;
      else if (!mask[i] && start !== null) { out.push([start, i - 1]); start = null; }
    }
    if (start !== null) out.push([start, mask.length - 1]);
    return out;
  }
  function mergeEpisodes(eps, gap = 7, minLen = 15) {
    if (!eps.length) return [];
    const out = [eps[0].slice()];
    for (const [a, b] of eps.slice(1)) {
      if (a - out[out.length - 1][1] <= gap) out[out.length - 1][1] = b; else out.push([a, b]);
    }
    return out.filter(([a, b]) => b - a + 1 >= minLen);
  }
  const forward = (close, h) => close.map((c, i) => (i + h < close.length ? close[i + h] / c - 1 : NaN_));
  function mean(xs) { const v = xs.filter((x) => !isN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN_; }
  function median(xs) { const v = xs.filter((x) => !isN(x)).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : NaN_; }
  // 회차 단위 순열검정. 같은 회차 수만큼 아무 날이나 골라 2,000번 비교
  function pValue(close, starts, h, nIter = 2000, seed = 0) {
    const f = forward(close, h);
    const obsVals = starts.map((i) => f[i]).filter((x) => !isN(x));
    if (!obsVals.length) return { obs: NaN_, rnd: NaN_, p: NaN_ };
    const obs = mean(obsVals);
    const pool = f.filter((x) => !isN(x));
    if (pool.length < starts.length) return { obs, rnd: NaN_, p: NaN_ };
    let s = seed + 1;
    const rand = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e9) / 1e9; };
    const k = starts.length; let ge = 0, tot = 0;
    for (let it = 0; it < nIter; it++) {
      let sum = 0; const used = new Set();
      while (used.size < k) { const j = Math.floor(rand() * pool.length); if (!used.has(j)) { used.add(j); sum += pool[j]; } }
      const m = sum / k; tot += m; if (m >= obs) ge++;
    }
    return { obs, rnd: tot / nIter, p: ge / nIter };
  }

  // ── 지수 모드 (signals.py detect_index 와 동일) ──
  //    52주 고점 대비 10% 이상 빠져 있으면 매수 고려, 재신호 금지 20일. 반등 확인 없음.
  //    20년 walk-forward: QQQ +6.3%p(p=0.00) · SPY +4.0%p(0.00) · SOXX +2.2%p(0.13), 시기별로도 안정.
  const IDX_DD = 0.10, IDX_PRE = 0.07, IDX_COOL = 20;
  function detectIndex(d) {
    const c = d.close, n = c.length;
    const hi = new Array(n).fill(NaN_);
    // pandas rolling(252, min_periods=60).max()
    for (let i = 0; i < n; i++) {
      if (i + 1 < 60) continue;
      let m = -Infinity;
      for (let j = Math.max(0, i - 251); j <= i; j++) if (c[j] > m) m = c[j];
      hi[i] = m;
    }
    d.idx_dd = c.map((x, i) => (isN(hi[i]) ? NaN_ : x / hi[i] - 1));
    const sig = new Array(n).fill(false);
    let last = -1e9;
    for (let i = 0; i < n; i++) if (!isN(d.idx_dd[i]) && d.idx_dd[i] <= -IDX_DD && i - last > IDX_COOL) { sig[i] = true; last = i; }
    d.idx_buy = sig;
    // 예비 신호: -7% 문턱 이벤트 중 그 순간 -10% 에 못 미친 것 (signals.py 와 동일)
    const pre = new Array(n).fill(false);
    last = -1e9;
    for (let i = 0; i < n; i++) if (!isN(d.idx_dd[i]) && d.idx_dd[i] <= -IDX_PRE && i - last > IDX_COOL) { if (d.idx_dd[i] > -IDX_DD) pre[i] = true; last = i; }
    d.idx_pre = pre;
    return d;
  }

  // ── 언제부터 이익이었나: 과거 신호들을 1~200일 하루씩 따라가, 이익인 비율이 70% 이상으로
  //    5일 연속 유지되기 시작한 첫날을 찾는다. 그날의 보통 수익과, 그때까지 도중에 보통 얼마나 물렸는지를 같이 낸다.
  //    200일 창을 다 가진 신호가 10개 이상이면 그것만 써서 날짜마다 같은 표본을 비교한다.
  // ── 매수 점수 (0~100): 많이 빠졌고, 그만큼 빠졌던 과거에 많이 올랐으면 높다.
  //    깊이 50점 = 지금 52주 고점 대비 낙폭이 이 종목 전 기간 중 상위 몇 %인가 (종목마다 자기 역사 기준 — 레버리지·지수를 같은 눈금에)
  //    반등 50점 = 과거 신호 중 깊이가 지금과 가장 비슷한 8개의 120일 뒤 중앙 수익, +30% 이상이면 만점, 0% 이하면 0점
  //    저장 데이터 31종목: 더 깊은 신호일수록 120일 뒤 더 올랐던 종목 22/31 (미국 14/17 · 국내 8/14)
  function buyScore(d, idx, H = 120, K = 8, full = 0.30) {
    const n = d.close.length, now = n - 1, dd = d.dd_52w;
    const hist = dd.filter((x) => !isN(x)).sort((a, b) => a - b);
    const pct = (v) => { if (isN(v) || !hist.length) return NaN_; let k = 0; while (k < hist.length && hist[k] < v) k++; return 1 - k / hist.length; };
    const depthPct = pct(dd[now]);
    const past = idx.filter((i) => i + H < n && !isN(dd[i])).map((i) => ({ p: pct(dd[i]), r: d.close[i + H] / d.close[i] - 1 }));
    let expRet = NaN_, k = 0;
    if (past.length >= 5 && !isN(depthPct)) {
      const near = past.sort((a, b) => Math.abs(a.p - depthPct) - Math.abs(b.p - depthPct)).slice(0, K);
      expRet = median(near.map((x) => x.r)); k = near.length;
    }
    const clip = (x) => Math.max(0, Math.min(1, x));
    const sDepth = isN(depthPct) ? 0 : 50 * depthPct, sRise = isN(expRet) ? 0 : 50 * clip(expRet / full);
    return { score: Math.round(sDepth + sRise), sDepth: Math.round(sDepth), sRise: Math.round(sRise), depthPct, expRet, k, dd: dd[now] };
  }

  // ── 신뢰도용 통계 (종목 단독 — 경고용)
  //    ③ 비교 기준 = 신호 '이후' 6개월(126일) 동안 아무 날에 산 120일 수익의 중앙값 (시기 보정).
  //       앞뒤 양쪽을 쓰면 하락 직전 비싸게 산 날이 섞여 무작위 가격에서도 +4.6%p 가 나오는 편향 → 이후만 쓰면 +0.04%p.
  //    ④ 20일 안에 연달아 난 신호는 한 번의 하락(에피소드)으로 묶어 평균 → 표본 수 = 하락 횟수.
  //    ② 에피소드를 시간순 앞뒤 절반으로 나눠 각각의 우위도 낸다 (역효과는 둘 다 마이너스일 때만).
  function trustStats(close, idx, H = 120, W = 126, gap = 20, R = 1000) {
    const c = close, n = c.length;
    const fr = c.map((v, i) => (i + H < n ? c[i + H] / v - 1 : NaN_));
    const last = n - H - 1;
    const diff = arr(n, NaN_);
    for (let i = 0; i <= last; i++) {
      const w = []; for (let j = i + 1; j <= Math.min(last, i + W); j++) w.push(fr[j]);
      if (w.length >= 20) diff[i] = fr[i] - median(w);
    }
    const sig = idx.filter((i) => !isN(diff[i]));
    const eps = []; let cur = null, prev = -1e9;
    for (const i of sig) { if (i - prev > gap) { cur = []; eps.push(cur); } cur.push(diff[i]); prev = i; }
    const ev = eps.map((e) => e.reduce((a, b) => a + b, 0) / e.length);
    const k = ev.length;
    if (k < 4) return { k, edge: NaN_, p: NaN_, e1: NaN_, e2: NaN_ };
    const edge = median(ev), h = k >> 1, e1 = median(ev.slice(0, h)), e2 = median(ev.slice(h));
    const pool = diff.filter((x) => !isN(x)); let ge = 0, seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let r = 0; r < R; r++) { const pk = []; for (let m = 0; m < k; m++) pk.push(pool[Math.floor(rnd() * pool.length)]); if (median(pk) >= edge) ge++; }
    return { k, edge, p: ge / R, e1, e2 };
  }

  function profitDay(close, idx, maxH = 200, need = 0.7, run = 5) {
    const n = close.length;
    const full = idx.filter((i) => i + maxH < n);
    const use = full.length >= 10 ? full : idx;
    let streak = 0, best = 0, bestDay = 0;
    for (let dd = 1; dd <= maxH; dd++) {
      const mem = use.filter((i) => i + dd < n);
      if (mem.length < 5) break;
      const rets = mem.map((i) => close[i + dd] / close[i] - 1);
      const frac = rets.filter((x) => x > 0).length / rets.length;
      if (frac > best) { best = frac; bestDay = dd; }
      streak = frac >= need ? streak + 1 : 0;
      if (streak === run) {
        const day = dd - run + 1;
        const m2 = use.filter((i) => i + day < n);
        const r2 = m2.map((i) => close[i + day] / close[i] - 1);
        const dips = m2.map((i) => { let lo = Infinity; for (let j = i; j <= i + day; j++) if (close[j] < lo) lo = close[j]; return lo / close[i] - 1; });
        return { day, frac: r2.filter((x) => x > 0).length / r2.length, med: median(r2), dip: median(dips), n: use.length };
      }
    }
    return { day: null, best, bestDay, n: use.length };
  }

  function analyze(ohlcv, threshold = 60, horizon = "단기", indexMode = false) {
    const d = detectIndex(detectAll(swingLow(buyzone(score(enrich(ohlcv))))));
    const n = d.close.length, p = HZ[horizon], h = p.key;
    const mask = d.bz.map((s) => !isN(s) && s >= threshold);
    const eps = mergeEpisodes(episodes(mask), 7, 10);
    const tr = gradeTroughs(troughs(d.close, d.atr_pct), d.bz, threshold);
    const st = { 60: trancheStats(d.close, eps, 60), 120: trancheStats(d.close, eps, 120) };
    // 시점 목록. 중기 매수에는 다지기(점수 60 돌파, 20일 금지)도 포함
    // 매수는 '저점반전'만 쓴다. 예전엔 '다지기'(점수가 60 위로 올라선 날)도 넣었는데,
    // 14종목 검증에서 절반이 아무 날보다 나빴다 — 120일 중앙값으로 현대차 -7.2%(아무 날 +3.1%) ·
    // SK하이닉스 -2.7%(+18.3%) · 삼성전자 -1.4%(+6.6%) · TSLA -1.1%(+10.9%). 그래서 뺐다.
    const buys = [], sells = [], kind = {}, pres = [];
    if (indexMode) {
      // 지수 모드: 52주 고점 -10% 규칙. 등급 문턱을 안 거친다 — 규칙 자체를 20년 walk-forward 로 검증했다
      for (let i = 0; i < n; i++) if (d.idx_buy[i]) { buys.push(i); kind[i] = "지수 -10%"; }
      for (let i = 0; i < n; i++) if (d.idx_pre[i]) { pres.push(i); kind[i] = "예비 -7%"; }
    } else {
      for (let i = 0; i < n; i++)
        if (d[h + "_buy"][i] && !isN(d.bz[i]) && d.bz[i] >= threshold) { buys.push(i); kind[i] = "저점반전"; }
    }
    // 매도 신호는 내지 않는다 — 이 도구는 저점매수 판독기다. 39종목 검증에서 매도 고려는 대부분 종목에서
    // 아무 날보다 나빴다(강한 추세에서 첫 꺾임마다 팔게 만든다). 매도 감지(detect)는 지표 대조용으로만 남겨 둔다.
    d.sig_kind = kind;
    const fw = {}; for (const H of p.eval) fw[H] = forward(d.close, H);
    const mkRows = (idx, H2) => idx.map((i) => { let mn = Infinity, mx = -Infinity; for (let j = i; j <= Math.min(n - 1, i + H2); j++) { if (d.close[j] < mn) mn = d.close[j]; if (d.close[j] > mx) mx = d.close[j]; }
      return { i, px: d.close[i], f1: fw[p.eval[0]][i], f2: fw[p.eval[1]][i], mdd: mn / d.close[i] - 1, mup: mx / d.close[i] - 1, done: i + H2 < n }; });
    const buyRows = mkRows(buys, p.eval[1]), sellRows = mkRows(sells, p.eval[1]);
    // 한 번의 순열로 평균·중앙값 p 를 같이 낸다.
    //   수익률 분포는 한쪽으로 쏠려 있어 평균은 대박 몇 번에 끌려다닌다. 중앙값이 '보통 어떻게 됐나'를 말해 준다.
    //   (META 는 평균 기준 p=0.58 로 무의미해 보이지만 중앙값 기준으로는 0.02 였다)
    const stat = (idx, H, sell) => {   // H·n·d 는 바깥 스코프
      const f = fw[H];
      const vals = idx.map((i) => f[i]).filter((x) => !isN(x));
      const pool = f.filter((x) => !isN(x));
      const base = mean(pool), baseMed = median(pool);
      if (!vals.length || pool.length < vals.length)
        return { obs: mean(vals), med: median(vals), base, baseMed, p: NaN_, pMed: NaN_, hit: NaN_, n: vals.length };
      const obs = mean(vals), obsMed = median(vals);
      let s2 = sell ? 11 : 1;
      const rand = () => { s2 ^= s2 << 13; s2 ^= s2 >>> 17; s2 ^= s2 << 5; return ((s2 >>> 0) % 1e9) / 1e9; };
      const ITER = 1500;
      let a = 0, b = 0;
      const pick = new Array(vals.length);
      for (let it = 0; it < ITER; it++) {
        const used = new Set(); let k = 0;
        while (k < vals.length) { const j = Math.floor(rand() * pool.length); if (!used.has(j)) { used.add(j); pick[k++] = pool[j]; } }
        const m = mean(pick), md = median(pick);
        if (sell ? m <= obs : m >= obs) a++;
        if (sell ? md <= obsMed : md >= obsMed) b++;
      }
      // 분포: 나쁠 때(하위 25%) · 보통(중앙값) · 좋을 때(상위 25%)
      const q = (xs, t) => { const v = [...xs].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.floor(t * v.length))]; };
      // 도중에 얼마나 물렸나(사고 나서 H일 안의 최저) / 얼마나 떴나(최고)
      const dips = [], ups = [];
      for (const i of idx) {
        if (i + H >= n) continue;
        let lo = Infinity, hi = -Infinity;
        for (let j = i; j <= i + H; j++) { if (d.close[j] < lo) lo = d.close[j]; if (d.close[j] > hi) hi = d.close[j]; }
        dips.push(lo / d.close[i] - 1); ups.push(hi / d.close[i] - 1);
      }
      return { obs, med: obsMed, base, baseMed, p: a / ITER, pMed: b / ITER,
               q25: q(vals, 0.25), q75: q(vals, 0.75), baseQ25: q(pool, 0.25), baseQ75: q(pool, 0.75),
               dip: dips.length ? median(dips) : NaN_, dipWorst: dips.length ? Math.min(...dips) : NaN_,
               up: ups.length ? median(ups) : NaN_,
               hit: sell ? vals.filter((x) => x < 0).length / vals.length : vals.filter((x) => x > 0).length / vals.length,
               n: vals.length };
    };
    const bs = {}, ss = {}, ps = {}; for (const H of p.eval) { bs[H] = stat(buys, H, false); ss[H] = stat(sells, H, true); if (pres.length) ps[H] = stat(pres, H, false); }
    const last = n - 1;
    const lastBuy = buys.length ? buys[buys.length - 1] : -1, lastSell = sells.length ? sells[sells.length - 1] : -1;
    const cur = { i: last, score: d.bz[last], sellGrade: d[h + "_sell_grade"][last], regime: d.regime[last], inZone: mask[last],
                  buyToday: lastBuy === last, sellToday: lastSell === last, lastBuy, lastSell, path: d.path[last],
                  setup: d.score[last], breakout: d.breakout[last], recentBreakout: d.breakout.slice(Math.max(0, n - 10)).some(Boolean),
                  accel: d.accel_gate[last] < 1, daysLow60: d.days_low60[last], dip: d[h + "_dip"][last], rise: d[h + "_rise"][last], need: d[h + "_need"][last] };
    // ── 상태와 비중. 상태는 둘: 매수 고려 / 관망 (매도 신호는 내지 않는다)
    //   매수 고려 = 마지막 신호가 매수이고, 신호 10일 안이거나 아직 점수가 문턱 위
    //   매도 고려 = 마지막 신호가 매도이고, 신호 10일 안
    //   비중(계획 물량 대비 %) = 등급 50 + 폭(조건의 몇 배나 움직였나) 25 + 신선도(신호 뒤 며칠) 25,
    //                          신호가보다 조건의 절반 이상 멀어졌으면 ×0.5
    const sinceB = lastBuy >= 0 ? last - lastBuy : 1e9, sinceS = lastSell >= 0 ? last - lastSell : 1e9;
    let state = "관망", size = 0;
    if (indexMode) {
      // 깊이가 깊을수록 비중을 늘린다: -10% → 30, -20% 이상 → 100. 이 배분 자체는 검증치가 아니라 설계다.
      const ddNow = d.idx_dd[last];
      if (!isN(ddNow) && ddNow <= -IDX_DD) { state = "매수 고려"; size = 30 + 70 * clip01((-ddNow - IDX_DD) / IDX_DD); cur.tier = "main"; }
      else if (!isN(ddNow) && ddNow <= -IDX_PRE) { state = "매수 고려"; size = 20; cur.tier = "pre"; }   // 예비: 소량 선취매
      cur.idxDD = ddNow; cur.indexMode = true;
    } else if (lastBuy >= 0 && lastBuy > lastSell && (sinceB <= 10 || mask[last])) {
      state = "매수 고려";
      const drift = d.close[last] / d.close[lastBuy] - 1;
      size = (50 * clip01(d.bz[last] / 100) + 25 * ramp(-d[h + "_dip"][last] / d[h + "_need"][last], 1, 2.5) + 25 * ramp(sinceB, 10, 0)) * (drift > d[h + "_need"][last] / 2 ? 0.5 : 1);
    } else if (lastSell >= 0 && lastSell > lastBuy && sinceS <= 10) {
      state = "매도 고려";
      const drift = d.close[lastSell] / d.close[last] - 1;
      size = (50 * clip01(d[h + "_sell_grade"][last] / 100) + 25 * ramp(d[h + "_rise"][last] / d[h + "_need"][last], 1, 2.5) + 25 * ramp(sinceS, 10, 0)) * (drift > d[h + "_need"][last] / 2 ? 0.5 : 1);
    }
    // ── 신뢰도 보정. 등급이 높아도 '이 종목에서 그 신호가 통했는지'는 별개다.
    //    39종목 검증에서 미국 주식·ETF 는 아무 날보다 중앙값 +1.2%p 나았지만 국내는 -2.1%p 였다.
    //    그러니 이 종목의 과거 우위(120일 중앙값 차이)와 그 우위가 우연일 확률(p)로 비중을 깎는다.
    const HREL = p.eval[2] || p.eval[1];                 // 120일 기준
    const rs = state === "매도 고려" ? ss[HREL] : (cur.tier === "pre" ? ps[HREL] : bs[HREL]);
    let rel = 0.7, relWhy = "과거 사례가 적어 보수적으로 잡았습니다";
    if (rs && rs.n >= 20 && !isN(rs.pMed)) {
      const gap = state === "매도 고려" ? rs.baseMed - rs.med : rs.med - rs.baseMed;   // 클수록 좋다
      if (gap <= 0) { rel = 0.3; relWhy = "이 종목에서는 과거 이 신호가 아무 날보다 오히려 나빴습니다"; }
      else if (rs.pMed < 0.1) { rel = 1.0; relWhy = "이 종목에서 과거 이 신호는 아무 날보다 확실히 나았습니다"; }
      else if (rs.pMed < 0.3) { rel = 0.85; relWhy = "우위가 있었지만 우연일 가능성을 배제하지 못합니다"; }
      else { rel = 0.6; relWhy = "우위가 아무 날과 구분되지 않아 절반 넘게 깎았습니다"; }
      cur.edge = gap; cur.edgeP = rs.pMed; cur.edgeN = rs.n;
    }
    // 비중을 숫자로 내놓을 자격이 있는지. 근거가 없으면 수치를 보여 주는 것 자체가 오해를 부른다.
    //   역효과 = 과거에 아무 날보다 나빴다 / 구분 안 됨 = 우위가 우연과 구분되지 않는다
    cur.trust = rel >= 1 ? "good" : rel >= 0.85 ? "weak" : rel >= 0.7 ? "unknown" : rel > 0.3 ? "none" : "bad";
    cur.trustTag = { good: "", weak: "약함", unknown: "사례 부족", none: "구분 안 됨", bad: "역효과" }[cur.trust];
    // 숫자를 지우는 것은 '역효과'(과거에 아무 날보다 나빴다)일 때만.
    //   39종목 검증에서 우위가 +1%p 수준이라, 정상 종목도 한 종목만 보면 대부분 p 0.2~0.5 가 나온다.
    //   그걸 전부 지우면 화면에서 숫자가 거의 사라진다 — 대신 흐리게 표시해 근거가 약함을 알린다.
    cur.showSize = cur.trust !== "bad";
    cur.dimSize = cur.trust === "none" || cur.trust === "unknown";
    cur.rel = rel; cur.relWhy = relWhy; cur.sizeRaw = Math.round(isN(size) ? 0 : size / 5) * 5;
    size *= rel;
    cur.state = state; cur.size = Math.round(isN(size) ? 0 : size / 5) * 5; cur.sinceB = sinceB; cur.sinceS = sinceS;
    cur.when = profitDay(d.close, cur.tier === "pre" ? pres : buys);
    cur.buy = buyScore(d, cur.tier === "pre" ? pres : buys);
    cur.tstat = trustStats(d.close, cur.tier === "pre" ? pres : buys);
    return { d, eps, tr, st, cur, threshold, horizon, hz: p, buys, sells, pres, ps, buyRows, sellRows, bs, ss,
             signals: buys, sigRows: buyRows.map((r) => ({ ...r, f60: r.f1, f120: r.f2 })), sig: { 60: bs[p.eval[0]], 120: bs[p.eval[1]] } };
  }

  return { wilder, ewm, rsi, macd, atr, adx, bollinger, keltner, squeeze, pctRank, drawdown, swings,
           enrich, regime, vcpFrame, score, explain, episodes, mergeEpisodes, forward, pValue, analyze,
           buyzone, explainBZ, swingLow, detect, detectAll, detectIndex, HZ, zigzag, troughs, gradeTroughs, tranche, trancheStats,
           REGIME_DESC, REGIME_MULT, PARAMS: P };
});
