"use strict";
var MoraCore = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // apps/ios/core-entry.ts
  var core_entry_exports = {};
  __export(core_entry_exports, {
    ANALYZER_VERSION: () => ANALYZER_VERSION,
    DEFAULT_AUTOMIX_SETTINGS: () => DEFAULT_AUTOMIX_SETTINGS,
    PLANNER_VERSION: () => PLANNER_VERSION,
    planJSON: () => planJSON
  });

  // packages/core/src/types.ts
  var ANALYZER_VERSION = "am-analyzer-14";
  var PLANNER_VERSION = "am-planner-v13-length-1";
  var VOICE_LIFT_MAX = 2.5;
  var DEFAULT_AUTOMIX_SETTINGS = {
    enabled: true,
    maxStretchPercent: 12,
    maxBlendSeconds: 32,
    eqHandoff: true,
    respectAlbums: true,
    loudnessTarget: -16,
    style: "auto",
    fallbackSeconds: 6,
    entryMode: "smart",
    maxEntrySkipSeconds: 45,
    mixOnNext: true,
    stemMixing: true,
    loopBridges: true,
    masterTempo: true,
    djPhrasing: true
  };

  // packages/core/src/mir/key.ts
  function parseCamelot(code) {
    const m = /^(\d{1,2})([AB])$/.exec(code);
    if (!m) return null;
    return { n: Number(m[1]), letter: m[2] };
  }
  function camelotCompatibility(a, b) {
    const pa = parseCamelot(a);
    const pb = parseCamelot(b);
    if (!pa || !pb) return { score: 0.5, label: "\u0442\u043E\u043D\u0430\u043B\u044C\u043D\u043E\u0441\u0442\u044C \u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430" };
    const diff = Math.min((pa.n - pb.n + 12) % 12, (pb.n - pa.n + 12) % 12);
    if (pa.letter === pb.letter) {
      if (diff === 0) return { score: 1, label: "\u0442\u0430 \u0436\u0435 \u0442\u043E\u043D\u0430\u043B\u044C\u043D\u043E\u0441\u0442\u044C" };
      if (diff === 1) return { score: 0.85, label: "\u0441\u043E\u0441\u0435\u0434\u043D\u044F\u044F \u0442\u043E\u043D\u0430\u043B\u044C\u043D\u043E\u0441\u0442\u044C" };
      if (diff === 2) return { score: 0.55, label: "\u0431\u043B\u0438\u0437\u043A\u0430\u044F \u0442\u043E\u043D\u0430\u043B\u044C\u043D\u043E\u0441\u0442\u044C" };
      if (diff === 7) return { score: 0.45, label: "\u044D\u043D\u0435\u0440\u0433\u0435\u0442\u0438\u0447\u0435\u0441\u043A\u0438\u0439 \u0441\u0434\u0432\u0438\u0433" };
      return { score: Math.max(0.05, 0.4 - diff * 0.06), label: "\u043A\u043E\u043D\u0444\u043B\u0438\u043A\u0442 \u0442\u043E\u043D\u0430\u043B\u044C\u043D\u043E\u0441\u0442\u0435\u0439" };
    }
    if (diff === 0) return { score: 0.85, label: "\u043F\u0430\u0440\u0430\u043B\u043B\u0435\u043B\u044C\u043D\u044B\u0439 \u043C\u0430\u0436\u043E\u0440/\u043C\u0438\u043D\u043E\u0440" };
    if (diff === 1) return { score: 0.55, label: "\u0434\u0438\u0430\u0433\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0439 \u043F\u0435\u0440\u0435\u0445\u043E\u0434" };
    return { score: Math.max(0.05, 0.35 - diff * 0.05), label: "\u043A\u043E\u043D\u0444\u043B\u0438\u043A\u0442 \u0442\u043E\u043D\u0430\u043B\u044C\u043D\u043E\u0441\u0442\u0435\u0439" };
  }

  // packages/core/src/mir/repetition.ts
  function closureAt(st, t, tolerance = 1.5) {
    for (let k = 0; k < st.segments.length; k++) {
      const seg = st.segments[k];
      if (Math.abs(seg.end - t) <= tolerance) return seg.endClosure;
      if (k === 0 && Math.abs(seg.start - t) <= tolerance) return 0.5;
    }
    const inside = st.segments.find((seg) => t > seg.start && t < seg.end);
    return inside ? 0.15 * (1 - inside.chorusLikelihood) : 0;
  }

  // packages/core/src/plan/timing.ts
  function drain(g) {
    for (; ; ) {
      const r5 = g.next();
      if (r5.done) return r5.value;
    }
  }
  var linear = /* @__PURE__ */ new WeakMap();
  function linearPower(curve) {
    let v = linear.get(curve);
    if (!v) {
      v = new Float64Array(curve.length);
      for (let i = 0; i < curve.length; i++) v[i] = Math.pow(10, curve[i] / 10);
      linear.set(curve, v);
    }
    return v;
  }
  function pointValue(points, time) {
    if (!points.length) return 1;
    if (time <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) if (time <= points[i][0]) {
      const [a, x] = points[i - 1], [b, y] = points[i];
      return b > a ? x + (y - x) * (time - a) / (b - a) : y;
    }
    return points[points.length - 1][1];
  }
  function integrateTempo(points, time) {
    if (time <= 0) return time;
    const map = (points == null ? void 0 : points.length) ? points : [[0, 1]];
    const knots = [0, ...map.map(([t]) => t).filter((t) => t > 0 && t < time), time];
    let total = 0;
    for (let i = 1; i < knots.length; i++) total += (knots[i] - knots[i - 1]) * (pointValue(map, knots[i]) + pointValue(map, knots[i - 1])) / 2;
    return total;
  }
  function outputTimeAt(points, sourceDelta, limit) {
    let lo = 0, hi = limit;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      if (integrateTempo(points, mid) < sourceDelta) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // packages/core/src/plan/range-maximum.ts
  var RangeMaximum = class {
    constructor(weights) {
      __publicField(this, "weights", weights);
      __publicField(this, "size");
      __publicField(this, "tree");
      let size = 1;
      while (size < weights.length) size *= 2;
      this.size = size;
      this.tree = new Int32Array(size * 2).fill(-1);
      for (let i = 0; i < weights.length; i++) this.tree[size + i] = Number.isFinite(weights[i]) ? i : -1;
      for (let i = size - 1; i > 0; i--) this.tree[i] = this.better(this.tree[i * 2], this.tree[i * 2 + 1]);
    }
    better(a, b) {
      if (a < 0) return b;
      if (b < 0) return a;
      return this.weights[a] > this.weights[b] ? a : this.weights[a] < this.weights[b] ? b : Math.min(a, b);
    }
    /** Half-open candidate index range. */
    best(from, to) {
      let l = Math.max(0, Math.ceil(from)) + this.size, r5 = Math.min(this.weights.length, Math.floor(to)) + this.size, result = -1;
      while (l < r5) {
        if (l & 1) result = this.better(result, this.tree[l++]);
        if (r5 & 1) result = this.better(result, this.tree[--r5]);
        l >>= 1;
        r5 >>= 1;
      }
      return result;
    }
  };

  // packages/core/src/plan/vocals.ts
  var clamp = (x) => Math.max(0, Math.min(1, x));
  var rounded = (x) => Math.round(x * 1e3) / 1e3;
  function vocalPhrases(analysis) {
    var _a;
    const v = analysis.vocalActivity;
    if (!v || !Number.isFinite(v.rate) || v.rate <= 0) return [];
    if (((_a = v.phrases) == null ? void 0 : _a.length) && v.phrases.every((p, i) => Number.isFinite(p.start) && Number.isFinite(p.end) && Number.isFinite(p.confidence) && p.start >= 0 && p.end > p.start && p.end <= analysis.duration + 1 / v.rate && p.confidence >= 0 && p.confidence <= 1 && (!i || p.start >= v.phrases[i - 1].end))) return v.phrases;
    const result = [];
    let start = -1, last = -1, sum = 0, count = 0;
    const finish = () => {
      if (start >= 0 && (last + 1 - start) / v.rate >= 0.18) result.push({ start: start / v.rate, end: (last + 1) / v.rate, confidence: clamp(sum / Math.max(1, count)) });
      start = last = -1;
      sum = count = 0;
    };
    for (let i = 0; i < v.values.length; i++) {
      const x = Number.isFinite(v.values[i]) ? clamp(v.values[i]) : 0;
      if (start < 0) {
        if (x < 0.52) continue;
        start = i;
      }
      if (x >= 0.28) {
        last = i;
        sum += x;
        count++;
      }
      if ((i - last) / v.rate > 0.2 + 1e-9) finish();
    }
    finish();
    return result;
  }
  var VERIFIED_TIMING = "stem-verified-1";
  function lyricTiming(analysis) {
    var _a;
    const l = (_a = analysis.vocalActivity) == null ? void 0 : _a.lyrics;
    if (!l || !Number.isFinite(l.confidence) || l.confidence < 0.6 || l.confidence > 1 || !Array.isArray(l.words) || l.words.length < 10 || !Array.isArray(l.lines)) return null;
    const ok = (x) => x.every((w, i) => Array.isArray(w) && Number.isFinite(w[0]) && Number.isFinite(w[1]) && w[0] >= 0 && w[1] > w[0] && w[1] <= analysis.duration + 0.1 && (!i || w[0] >= x[i - 1][1]));
    if (!ok(l.words) || !ok(l.lines)) return null;
    if (l.timing === VERIFIED_TIMING && Array.isArray(l.voiced) && l.voiced.length && ok(l.voiced))
      return { words: l.words, lines: l.lines, edit: l.voiced, verified: true };
    const words = trimToActivity(analysis, l.words);
    const measured = vocalPhrases(analysis).filter((p) => p.confidence >= 0.35).map((p) => [p.start, p.end]);
    return { words, lines: l.lines, edit: mergeSpans([...words, ...measured]), verified: false };
  }
  function trimToActivity(analysis, words) {
    const v = analysis.vocalActivity;
    if (!(v.rate > 0)) return words;
    return words.map(([a, b]) => {
      if (b - a <= 1) return [a, b];
      let first = -1, last = -1;
      for (let i = Math.floor(a * v.rate); i < Math.min(v.values.length, Math.ceil(b * v.rate)); i++) if (v.values[i] >= 0.28) {
        if (first < 0) first = i;
        last = i;
      }
      if (first < 0) return [a, b];
      const start = Math.max(a, first / v.rate - 0.05), end = Math.min(b, (last + 1) / v.rate + 0.05);
      return end - start >= 0.05 ? [start, end] : [a, b];
    });
  }
  function mergeSpans(spans) {
    const out = [];
    for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
      const last = out.at(-1);
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  }
  function betweenLines(t, x) {
    var _a, _b;
    for (let i = 0; i < t.lines.length; i++) {
      const [, end] = t.lines[i], next = (_b = (_a = t.lines[i + 1]) == null ? void 0 : _a[0]) != null ? _b : Infinity;
      if (x >= end - 0.02 && x <= next + 0.02) return 1;
      if (x < end) return 0;
    }
    return 1;
  }
  function wordsIn(t, start, end) {
    return t.words.filter(([a, b]) => (a + b) / 2 >= start && (a + b) / 2 < end).length;
  }
  function phraseGap(phrases, start, end) {
    return phrases.some((p) => p.confidence >= 0.35 && end > p.start && start < p.end) ? 0 : 1;
  }
  function fitFadeInBreath(at, duration, direction, phrases, lyrics, cue, tempo, limit) {
    var _a;
    const source = cue + integrateTempo(tempo, at);
    const spans = (_a = lyrics == null ? void 0 : lyrics.edit) != null ? _a : phrases.filter((p) => p.confidence >= 0.35).map((p) => [p.start, p.end]);
    if (spans.some(([start, end]) => source > start && source < end)) return duration;
    if (direction === "out") {
      const previous = spans.filter(([, end]) => end <= source).at(-1);
      if (!previous || previous[1] < cue) return duration;
      const boundary2 = outputTimeAt(tempo, previous[1] - cue, limit);
      const available2 = at - boundary2 - 0.015;
      return available2 >= 0.02 ? Math.min(duration, available2) : duration;
    }
    const next = spans.find(([start]) => start >= source);
    if (!next || next[0] > cue + integrateTempo(tempo, limit)) return duration;
    const boundary = outputTimeAt(tempo, next[0] - cue, limit);
    const available = boundary - at - 0.035;
    return available >= 0.02 ? Math.min(duration, available) : duration;
  }
  function breathCandidates(phrases, lyrics, cue, tempo, limit, direction) {
    var _a;
    const spans = (_a = lyrics == null ? void 0 : lyrics.edit) != null ? _a : phrases.filter((p) => p.confidence >= 0.35).map((p) => [p.start, p.end]);
    const sourceEnd = cue + integrateTempo(tempo, limit), result = [];
    for (let i = 0; i < spans.length; i++) {
      const start = Math.max(cue, i ? spans[i - 1][1] : cue), end = Math.min(sourceEnd, spans[i][0]);
      if (end <= start) continue;
      const from = outputTimeAt(tempo, start - cue, limit), to = outputTimeAt(tempo, end - cue, limit);
      const room = to - from - (direction === "out" ? 0.015 : 0.035) - 5e-3;
      if (room < 0.02) continue;
      result.push(direction === "out" ? from + 0.015 + Math.min(0.08, room) : from + 5e-3);
    }
    return result;
  }
  function vocalMean(analysis, start, end) {
    const v = analysis.vocalActivity;
    if (!v) return 0;
    const lo = Math.max(0, Math.floor(start * v.rate)), hi = Math.min(v.values.length, Math.ceil(end * v.rate));
    let sum = 0;
    for (let i = lo; i < hi; i++) sum += v.values[i];
    return hi > lo ? sum / (hi - lo) : 0;
  }
  function vocalPowerRetained(analysis, start, end, gain) {
    if (gain >= 1) return 1;
    const v = analysis.vocalActivity, voice = v == null ? void 0 : v.vocalRmsDb, band = v == null ? void 0 : v.accompanimentRmsDb;
    if (!v || !(voice == null ? void 0 : voice.length) || !(band == null ? void 0 : band.length) || !(v.rate > 0)) return 1;
    const lo = Math.max(0, Math.floor(start * v.rate)), hi = Math.min(voice.length, band.length, Math.ceil(end * v.rate));
    let vp = 0, ip = 0, n = 0;
    for (let i = lo; i < hi; i++) {
      if (!Number.isFinite(voice[i]) || !Number.isFinite(band[i])) continue;
      vp += 10 ** (Math.max(-120, Math.min(12, voice[i])) / 10);
      ip += 10 ** (Math.max(-120, Math.min(12, band[i])) / 10);
      n++;
    }
    return n ? clamp((ip + clamp(gain) ** 2 * vp) / Math.max(1e-12, ip + vp)) : 1;
  }
  function vocalStarts(analysis, limit = 75) {
    const v = analysis.vocalActivity;
    if (!v) return [];
    const phrases = vocalPhrases(analysis);
    return phrases.filter((p, i) => {
      var _a, _b;
      return p.start < analysis.audibleStart + limit && p.confidence >= 0.5 && p.start - ((_b = (_a = phrases[i - 1]) == null ? void 0 : _a.end) != null ? _b : 0) >= 0.7 - 1e-9;
    }).map((p) => p.start);
  }
  function vocalEntryScore(A, B, aSwap, bSwap) {
    if (!A.vocalActivity || !B.vocalActivity) return 0;
    const aGap = 1 - vocalMean(A, aSwap - 0.25, aSwap + 0.2);
    const before = vocalMean(B, bSwap - 0.9, bSwap - 0.1), after = vocalMean(B, bSwap + 0.1, bSwap + 0.9);
    const arrival = clamp((after - before + 0.15) / 0.65);
    return 0.45 * aGap + 0.55 * arrival;
  }
  function lastAudible(g, D) {
    for (let t = D; t > 0; t -= 0.05) if (pointValue(g, t) > 0.1) return t;
    return 0;
  }
  var BLEED_MID = 0.35;
  var BLEED_HIGH = 0.5;
  function guardLanes(lanes, from, to, D, gains) {
    var _a, _b;
    const ramp = (t, g) => t <= from ? 1 : t >= to ? g : 1 - (1 - g) * (0.5 - 0.5 * Math.cos(Math.PI * (t - from) / (to - from)));
    const out = lanes.filter((l) => !(l.deck === "A" && (l.lane === "mid" || l.lane === "high")));
    for (const band of ["mid", "high"]) {
      const old = (_b = (_a = lanes.find((l) => l.deck === "A" && l.lane === band)) == null ? void 0 : _a.points) != null ? _b : [[0, 1]];
      const knots = [.../* @__PURE__ */ new Set([...old.map(([t]) => t).filter((t) => t <= D), ...Array.from({ length: 9 }, (_, i) => from + (to - from) * i / 8), D])].filter((t) => t >= 0).sort((x, y) => x - y);
      out.push({ deck: "A", lane: band, points: knots.map((t) => [rounded(t), rounded(Math.min(pointValue(old, t), ramp(t, gains[band])))]) });
    }
    return out;
  }
  function partialVocalHandoff(p, A, B, s) {
    var _a, _b, _c, _d;
    if (!["crossfade", "beatmatch_blend"].includes(p.method) || p.voiceEcho || p.loopA) return p;
    const D = p.duration;
    const covered = (an, from, to) => {
      const v = an.vocalActivity;
      if (!v || !Number.isFinite(v.rate) || v.rate <= 0 || from < 0 || to <= from || to * v.rate > v.values.length) return false;
      for (let i = Math.floor(from * v.rate); i < Math.ceil(to * v.rate); i++) if (!Number.isFinite(v.values[i]) || v.values[i] < 0 || v.values[i] > 1) return false;
      return true;
    };
    if ((A == null ? void 0 : A.vocalActivity) && !(B == null ? void 0 : B.vocalActivity)) {
      const gB = (_b = (_a = p.automation.find((l) => l.deck === "B" && l.lane === "gain")) == null ? void 0 : _a.points) != null ? _b : [[0, 1]];
      let deadline = 0;
      while (deadline < Math.min(1, D * 0.35) && pointValue(gB, deadline) < 0.12) deadline += 0.02;
      deadline = Math.max(0, deadline - 0.04);
      if (deadline < 0.1) return p;
      const src = (t) => p.aExit + integrateTempo(p.tempoA, t), words = lyricTiming(A);
      if (!covered(A, src(0), src(deadline + 0.08))) return p;
      let end = -1;
      for (let t = 0.08; t <= deadline; t += 0.02) {
        if (vocalMean(A, src(t - 0.06), src(t + 0.08)) > 0.12) continue;
        if (words == null ? void 0 : words.edit.some(([a, b]) => src(t) > a && src(t - 0.06) < b)) continue;
        end = t;
      }
      if (end < 0) return p;
      end = rounded(end);
      const from = rounded(Math.max(0, end - 0.06));
      const automation = s.eqHandoff ? guardLanes(p.automation, from, end, D, { mid: BLEED_MID, high: BLEED_HIGH }) : p.automation;
      return {
        ...p,
        vocalA: [[0, 1], [from, 1], [end, 0], [D, 0]],
        vocalB: void 0,
        automation,
        reasons: [...p.reasons, "\u0433\u043E\u0442\u043E\u0432 \u0442\u043E\u043B\u044C\u043A\u043E \u0442\u0435\u043A\u0443\u0449\u0438\u0439 \u0432\u043E\u043A\u0430\u043B: \u043E\u043D \u0443\u0445\u043E\u0434\u0438\u0442 \u0432 \u0438\u0437\u043C\u0435\u0440\u0435\u043D\u043D\u043E\u0439 \u043F\u0430\u0443\u0437\u0435 \u0434\u043E \u0437\u0430\u043C\u0435\u0442\u043D\u043E\u0433\u043E \u0432\u0445\u043E\u0434\u0430 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430; \u043D\u043E\u0432\u044B\u0439 \u0433\u043E\u043B\u043E\u0441 \u043D\u0435 \u0437\u0430\u0433\u043B\u0443\u0448\u0430\u0435\u0442\u0441\u044F"],
        debug: { ...p.debug, stems: {
          policy: "one-sided-a-1",
          model: A.vocalActivity.model,
          source: "demucs",
          vocalHandoff: end,
          incomingUnknown: true,
          lostB: 0,
          bleedGuard: s.eqHandoff ? { from, to: end, mid: BLEED_MID, high: BLEED_HIGH } : null
        } }
      };
    }
    if ((B == null ? void 0 : B.vocalActivity) && !(A == null ? void 0 : A.vocalActivity)) {
      const src = (t) => p.bEntry + integrateTempo(p.tempoB, t);
      if (!covered(B, src(0), src(D))) return p;
      const v = B.vocalActivity;
      let first = Infinity;
      for (let i = Math.floor(p.bEntry * v.rate); i < Math.ceil(src(D) * v.rate); i++) if (v.values[i] >= 0.28) {
        first = Math.max(p.bEntry, i / v.rate);
        break;
      }
      if (!Number.isFinite(first) || first <= p.bEntry) return p;
      const attack = outputTimeAt(p.tempoB, first - p.bEntry, D), end = rounded(attack - 0.15);
      if (end < 0.8 || end > D * 0.85) return p;
      if (vocalMean(B, p.bEntry, first) > 0.12) return p;
      const fade = Math.min(4, Math.max(0.6, end * 0.8)), from = rounded(end - fade);
      const gain = (_d = (_c = p.automation.find((l) => l.deck === "A" && l.lane === "gain")) == null ? void 0 : _c.points) != null ? _d : [[0, 1]];
      const knots = [.../* @__PURE__ */ new Set([0, ...gain.map(([t]) => t), ...Array.from({ length: 13 }, (_, i) => from + fade * i / 12), end, D])].filter((t) => t >= 0 && t <= D).sort((a, b) => a - b);
      const envelope = (t) => t <= from ? 1 : t >= end ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * (t - from) / fade);
      const incoming = p.automation.map((l) => {
        if (l.deck !== "B" || !["gain", "low", "mid", "high"].includes(l.lane)) return l;
        const times = [.../* @__PURE__ */ new Set([...l.points.map(([t]) => t), ...knots])].sort((a, b) => a - b);
        return { ...l, points: times.map((t) => {
          const outgoing = envelope(t), floor = l.lane === "gain" ? Math.sqrt(Math.max(0, 1 - outgoing * outgoing)) : 1 - outgoing;
          return [rounded(t), rounded(Math.max(pointValue(l.points, t), floor))];
        }) };
      });
      const automation = [
        ...incoming.filter((l) => !(l.deck === "A" && (l.lane === "gain" || l.lane === "echo"))),
        { deck: "A", lane: "gain", points: knots.map((t) => [rounded(t), rounded(Math.min(pointValue(gain, t), envelope(t)))]) }
      ];
      return {
        ...p,
        automation,
        echo: automation.some((l) => l.lane === "echo") ? p.echo : void 0,
        vocalA: void 0,
        vocalB: void 0,
        reasons: [...p.reasons, "\u0433\u043E\u0442\u043E\u0432 \u0442\u043E\u043B\u044C\u043A\u043E \u0430\u043D\u0430\u043B\u0438\u0437 \u043D\u043E\u0432\u043E\u0433\u043E \u0433\u043E\u043B\u043E\u0441\u0430: \u0442\u0435\u043A\u0443\u0449\u0438\u0439 \u0442\u0440\u0435\u043A \u043F\u043B\u0430\u0432\u043D\u043E \u0443\u0445\u043E\u0434\u0438\u0442 \u0434\u043E \u0435\u0433\u043E \u043F\u0435\u0440\u0432\u043E\u0433\u043E \u0438\u0437\u043C\u0435\u0440\u0435\u043D\u043D\u043E\u0433\u043E \u0432\u0441\u0442\u0443\u043F\u043B\u0435\u043D\u0438\u044F; \u0433\u043E\u043B\u043E\u0441 \u043F\u043E\u0441\u043B\u0435 \u0432\u044B\u0431\u0440\u0430\u043D\u043D\u043E\u0439 \u0442\u043E\u0447\u043A\u0438 \u0432\u0445\u043E\u0434\u0430 \u043D\u0435 \u0437\u0430\u0433\u043B\u0443\u0448\u0430\u0435\u0442\u0441\u044F"],
        debug: { ...p.debug, stems: {
          policy: "one-sided-b-2",
          model: v.model,
          source: "demucs",
          outgoingUnknown: true,
          vocalHandoff: end,
          bVoiceStart: rounded(attack),
          lostB: 0,
          wholeDeckFade: { from, to: end }
        } }
      };
    }
    return p;
  }
  function applyVocalHandoff(plan, A, B, s) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i;
    if (plan.debug.processingAllowed === false) return {
      ...plan,
      vocalA: void 0,
      vocalB: void 0,
      voiceEcho: void 0,
      automation: plan.automation.filter((l) => l.lane !== "voiceEcho")
    };
    if (!s.enabled || s.stemMixing === false || plan.duration < 0.7 || ["skip_fade", "gapless"].includes(plan.method)) return plan;
    if (!(A == null ? void 0 : A.vocalActivity) || !(B == null ? void 0 : B.vocalActivity)) return partialVocalHandoff(plan, A, B, s);
    const covered = (an, from, to) => {
      const v = an.vocalActivity;
      if (!Number.isFinite(v.rate) || v.rate <= 0 || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || Math.ceil((to - 1e-8) * v.rate) > v.values.length) return false;
      for (let i = Math.floor(from * v.rate); i < Math.ceil((to - 1e-8) * v.rate); i++) if (!Number.isFinite(v.values[i]) || v.values[i] < 0 || v.values[i] > 1) return false;
      return true;
    };
    const validA = covered(A, plan.aExit, Math.min(A.duration, plan.aExit + integrateTempo(plan.tempoA, plan.duration)));
    const validB = covered(B, plan.bEntry, plan.bEntry + integrateTempo(plan.tempoB, plan.duration));
    if (!validA || !validB) {
      const clean = plan.vocalA || plan.vocalB || plan.voiceEcho || plan.automation.some((l) => l.lane === "voiceEcho") ? { ...plan, vocalA: void 0, vocalB: void 0, voiceEcho: void 0, automation: plan.automation.filter((l) => l.lane !== "voiceEcho") } : plan;
      return partialVocalHandoff(clean, validA ? A : { ...A, vocalActivity: void 0 }, validB ? B : { ...B, vocalActivity: void 0 }, s);
    }
    const D = plan.duration, drop = plan.method === "drop_mix";
    const phrasesA = vocalPhrases(A), phrasesB = vocalPhrases(B), lyricsA = lyricTiming(A), lyricsB = lyricTiming(B);
    const region = (_b = (_a = plan.beatAlign) == null ? void 0 : _a.regions) == null ? void 0 : _b.A;
    const beat = (_e = (_d = region == null ? void 0 : region.period) != null ? _d : plan.beatAlign ? 60 / plan.beatAlign.bpmA : (_c = A.beat) == null ? void 0 : _c.period) != null ? _e : 0.5;
    const srcA = (t) => plan.aExit + integrateTempo(plan.tempoA, t);
    const srcB = (t) => plan.bEntry + integrateTempo(plan.tempoB, t);
    const gainOf = (deck) => {
      var _a2, _b2;
      return (_b2 = (_a2 = plan.automation.find((l) => l.deck === deck && l.lane === "gain")) == null ? void 0 : _a2.points) != null ? _b2 : [[0, 1]];
    };
    const gA = gainOf("A"), gB = gainOf("B");
    const power = (an, t) => {
      const c = an.curves;
      let sum = 0, n = 0;
      for (let i = Math.max(0, Math.floor((t - 0.75) * c.rate)); i < Math.min(c.rmsDb.length, Math.ceil((t + 0.75) * c.rate)); i++) {
        sum += 10 ** (c.rmsDb[i] / 10);
        n++;
      }
      return n ? sum / n : 0;
    };
    let takeover = plan.swapAt;
    if (!drop && plan.swapAt < D * 0.3) for (let t = 0; t < D; t += 0.1) {
      const a = pointValue(gA, t) ** 2 * power(A, srcA(t)) * 10 ** (plan.gainA / 10), b = pointValue(gB, t) ** 2 * power(B, srcB(t)) * 10 ** (plan.gainB / 10);
      if (b >= a) {
        takeover = Math.max(plan.swapAt, t);
        break;
      }
    }
    const swap = Math.max(0.2, Math.min(D - 0.35, takeover));
    const STEP = 0.05, SHORT = 0.08, LOST = 0.4, WORD_A = 0.06, WORD_B = 0.12, N = Math.ceil(D / STEP);
    const heard = (an, src, g) => {
      const sum = [0];
      for (let i = 0; i < N; i++) {
        const t = i * STEP;
        sum.push(sum[i] + clamp((vocalMean(an, src(t), src(t + STEP)) - 0.15) / 0.7) * pointValue(g, t) * STEP);
      }
      return (t) => sum[Math.max(0, Math.min(N, Math.round(t / STEP)))];
    };
    const heardA = heard(A, srcA, gA), heardB = heard(B, srcB, gB);
    const window = Math.max(beat * 8, 1);
    const locked = plan.method === "beatmatch_blend";
    const lo = drop ? swap : locked ? Math.min(swap, D * 0.1 + SHORT) : Math.max(Math.min(swap, D * 0.1 + SHORT), Math.min(swap - beat * 8, swap * 0.5));
    const fadeB = 0.12;
    let best = { score: -Infinity, aEnd: swap, aGap: 0, bStart: swap, bGap: 0 };
    const incomingAt = (b) => {
      const x = srcB(b);
      const testedFade = fitFadeInBreath(b, fadeB, "in", phrasesB, lyricsB, plan.bEntry, plan.tempoB, D);
      let bGap = (1 - vocalMean(B, x - 0.15, x + 0.1)) * phraseGap(phrasesB, srcB(b), srcB(b + testedFade + 0.035));
      let arrival = clamp((vocalMean(B, x + 0.1, x + 0.9) - 0.25) / 0.4);
      let wordSafeBonus = 0;
      if (lyricsB) {
        const open = srcB(b + testedFade), from = srcB(b);
        const chopped = lyricsB.words.some(([w0, w1]) => open > w0 + 0.08 && from < w1 - 0.05);
        const clear = !lyricsB.edit.some(([w0, w1]) => open > w0 + 1e-3 && from < w1 - 1e-3);
        if (clear) wordSafeBonus = 0.1;
        if (chopped) bGap = Math.min(bGap, 0.3);
        else if (clear) {
          const next = lyricsB.lines.find(([s0]) => s0 >= open), lineStart = !!next && next[0] - open < 1 && !!betweenLines(lyricsB, from);
          bGap = Math.max(bGap, lineStart ? 1 : 0.75);
          arrival = Math.max(arrival * 0.5, lineStart ? 1 : 0);
        }
      }
      const lostWords = lyricsB ? wordsIn(lyricsB, srcB(0), srcB(b)) : 0;
      return { b, bGap, score: bGap + 0.2 * bGap * arrival + wordSafeBonus - LOST * heardB(b) - WORD_B * lostWords };
    };
    const incoming = [.../* @__PURE__ */ new Set([
      ...Array.from({ length: N + 1 }, (_, i) => i * STEP),
      ...breathCandidates(phrasesB, lyricsB, plan.bEntry, plan.tempoB, D, "in")
    ])].sort((a, b) => a - b).map(incomingAt);
    const maxima = drop ? null : new RangeMaximum(incoming.map((c) => c.score + 0.1 * c.b / window));
    const outgoing = [.../* @__PURE__ */ new Set([
      ...Array.from({ length: Math.max(0, Math.floor((swap - lo + 1e-9) / STEP)) + 1 }, (_, i) => swap - i * STEP),
      ...breathCandidates(phrasesA, lyricsA, plan.aExit, plan.tempoA, D, "out").filter((t) => t >= lo && t <= swap)
    ])].sort((a, b) => b - a);
    for (const e of outgoing) {
      const t = srcA(e);
      const testedFade = fitFadeInBreath(e, SHORT, "out", phrasesA, lyricsA, plan.aExit, plan.tempoA, D);
      let aGap = (1 - vocalMean(A, t - SHORT - 0.05, t + 0.35)) * phraseGap(phrasesA, srcA(Math.max(0, e - testedFade)), t);
      let phraseEnd = clamp((vocalMean(A, t - 1.6, t - 0.2) - 0.25) / 0.4);
      let split = false;
      if (lyricsA) {
        const from = srcA(Math.max(0, e - testedFade));
        split = lyricsA.edit.some(([w0, w1]) => t > w0 + 1e-3 && from < w1 - 1e-3);
        const line = betweenLines(lyricsA, t);
        aGap = split ? 0 : Math.max(aGap, line ? 1 : 0.75);
        phraseEnd = Math.max(phraseEnd * 0.5, line);
      }
      const aScore = aGap + 0.15 * phraseEnd - LOST * (heardA(swap) - heardA(e)) - (split ? 0.4 : 0) - (lyricsA ? WORD_A * wordsIn(lyricsA, t, srcA(swap)) : 0);
      const hi = Math.min(D - fadeB, e + (drop ? 0 : window));
      let first = 0, last = incoming.length;
      while (first < last) {
        const middle = first + last >>> 1;
        if (incoming[middle].b < e - 1e-9) first = middle + 1;
        else last = middle;
      }
      let upper = first, right = incoming.length;
      while (upper < right) {
        const middle = upper + right >>> 1;
        if (incoming[middle].b <= hi + 1e-9) upper = middle + 1;
        else right = middle;
      }
      const index = (_f = maxima == null ? void 0 : maxima.best(first, upper)) != null ? _f : -1;
      if (drop || index >= 0) {
        const candidate = drop ? incomingAt(e) : incoming[index];
        const { b, bGap, score: bScore } = candidate;
        if (b > hi + 1e-9) continue;
        const score = aScore + bScore + 0.1 * clamp((b - e) / window);
        if (score > best.score) best = { score, aEnd: e, aGap, bStart: b, bGap };
      }
    }
    const { aEnd, bStart } = best;
    const breath = best.aGap >= 0.75, softB = best.bGap < 0.75 && !drop;
    const fadeA = fitFadeInBreath(
      aEnd,
      breath || drop ? Math.min(SHORT, aEnd) : Math.min(0.45, Math.max(SHORT, aEnd * 0.5)),
      "out",
      phrasesA,
      lyricsA,
      plan.aExit,
      plan.tempoA,
      D
    );
    const appliedFadeB = fitFadeInBreath(bStart, softB ? 0.3 : fadeB, "in", phrasesB, lyricsB, plan.bEntry, plan.tempoB, D);
    const bOpen = Math.min(D, bStart + appliedFadeB);
    const clearOf = (spans, from, to) => !spans.some(([a, b]) => to > a + 1e-3 && from < b - 1e-3);
    const editA = (_g = lyricsA == null ? void 0 : lyricsA.edit) != null ? _g : phrasesA.filter((p) => p.confidence >= 0.35).map((p) => [p.start, p.end]);
    const editB = (_h = lyricsB == null ? void 0 : lyricsB.edit) != null ? _h : phrasesB.filter((p) => p.confidence >= 0.35).map((p) => [p.start, p.end]);
    const cleanA = clearOf(editA, srcA(Math.max(0, aEnd - fadeA)), srcA(aEnd)), cleanB = clearOf(editB, srcB(bStart), srcB(bOpen));
    const reasons = [
      ...plan.reasons,
      "\u0432\u044B\u0434\u0435\u043B\u0435\u043D\u043D\u044B\u0435 \u0432\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0435 \u043F\u0430\u0440\u0442\u0438\u0438 \u043F\u0435\u0440\u0435\u0434\u0430\u044E\u0442\u0441\u044F \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u043E \u043E\u0442 \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430\u043B\u0430, \u0431\u0435\u0437 \u043D\u0430\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u043E\u0441\u043D\u043E\u0432\u043D\u044B\u0445 \u0433\u043E\u043B\u043E\u0441\u043E\u0432",
      breath ? "\u0433\u043E\u043B\u043E\u0441 \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430 \u0437\u0430\u043A\u0430\u043D\u0447\u0438\u0432\u0430\u0435\u0442\u0441\u044F \u0432 \u043F\u0430\u0443\u0437\u0435 \u0434\u043E \u0441\u043C\u0435\u043D\u044B \u043E\u0441\u043D\u043E\u0432\u044B" : "\u043F\u0430\u0443\u0437\u0430 \u0432 \u0433\u043E\u043B\u043E\u0441\u0435 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430: \u0433\u043E\u043B\u043E\u0441 \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430 \u043F\u043B\u0430\u0432\u043D\u043E \u0443\u0432\u043E\u0434\u0438\u0442\u0441\u044F \u043A \u043C\u043E\u043C\u0435\u043D\u0442\u0443 \u0441\u043C\u0435\u043D\u044B",
      best.bGap >= 0.75 ? "\u0433\u043E\u043B\u043E\u0441 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430 \u043E\u0442\u043A\u0440\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u0432 \u043D\u0430\u0447\u0430\u043B\u0435 \u0441\u0432\u043E\u0435\u0439 \u0444\u0440\u0430\u0437\u044B" : "\u0433\u043E\u043B\u043E\u0441 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430 \u043C\u044F\u0433\u043A\u043E \u043E\u0442\u043A\u0440\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u0441\u0440\u0430\u0437\u0443 \u043F\u043E\u0441\u043B\u0435 \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E"
    ];
    let voiceEcho;
    let throwLane;
    let delay = beat / Math.max(0.5, pointValue((_i = plan.tempoA) != null ? _i : [], aEnd));
    while (delay < 0.3) delay *= 2;
    while (delay > 0.8) delay /= 2;
    let lastWord = null;
    for (let t = aEnd; t >= Math.max(STEP, aEnd - 1.5); t -= STEP) if (vocalMean(A, srcA(t - STEP), srcA(t)) > 0.35) {
      lastWord = t;
      break;
    }
    const repeatsBefore = Math.ceil((bStart - aEnd) / delay - 1e-9);
    if (lastWord !== null && !drop && repeatsBefore >= 2) {
      const level2 = Math.max(0.2, 0.55 * pointValue(gA, lastWord));
      let feedback = Math.min(0.5, Math.pow(0.01 / level2, 1 / (repeatsBefore - 1)));
      if (feedback < 0.12) feedback = 0;
      const from = Math.max(0.02, lastWord - Math.min(delay, 0.5));
      voiceEcho = { delay: rounded(delay), feedback: rounded(feedback) };
      throwLane = { deck: "A", lane: "voiceEcho", points: [[0, 0], [rounded(from), 0], [rounded(from + 0.04), rounded(level2)], [rounded(aEnd), rounded(level2)], [rounded(aEnd + 0.03), 0]] };
      reasons.push("\u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0435\u0435 \u0441\u043B\u043E\u0432\u043E \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0433\u043E\u043B\u043E\u0441\u0430 \u043F\u043E\u0432\u0442\u043E\u0440\u044F\u0435\u0442\u0441\u044F \u044D\u0445\u043E\u043C \u0438 \u0437\u0430\u0442\u0438\u0445\u0430\u0435\u0442 \u0434\u043E \u0432\u0445\u043E\u0434\u0430 \u043D\u043E\u0432\u043E\u0433\u043E \u0433\u043E\u043B\u043E\u0441\u0430");
    }
    const aWouldSing = vocalMean(A, srcA(aEnd), srcA(D)) > 0.2, bSings = vocalMean(B, srcB(bStart), srcB(D)) > 0.2;
    let automation = [...plan.automation.filter((l) => l.lane !== "voiceEcho"), ...throwLane ? [throwLane] : []];
    let bleedGuard = null;
    if (aWouldSing && bSings && !drop && s.eqHandoff !== false) {
      const from = rounded(Math.max(0, aEnd - fadeA)), to = rounded(bStart);
      bleedGuard = { from, to, mid: BLEED_MID, high: BLEED_HIGH };
      automation = guardLanes(automation, from, to, D, { mid: BLEED_MID, high: BLEED_HIGH });
      reasons.push("\u043E\u0441\u0442\u0430\u0442\u043E\u043A \u0441\u0442\u0430\u0440\u043E\u0433\u043E \u0433\u043E\u043B\u043E\u0441\u0430 \u0432 \u0430\u043A\u043A\u043E\u043C\u043F\u0430\u043D\u0435\u043C\u0435\u043D\u0442\u0435 \u043F\u0440\u0438\u0433\u043B\u0443\u0448\u0430\u0435\u0442\u0441\u044F: \u0432\u043E\u043A\u0430\u043B\u044C\u043D\u0430\u044F \u043F\u043E\u043B\u043E\u0441\u0430 \u0443\u0445\u043E\u0434\u044F\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430 \u0443\u0431\u0438\u0440\u0430\u0435\u0442\u0441\u044F \u043A \u0432\u0445\u043E\u0434\u0443 \u043D\u043E\u0432\u043E\u0433\u043E \u0433\u043E\u043B\u043E\u0441\u0430");
    }
    return {
      ...plan,
      vocalA: [[0, 1], [rounded(Math.max(0, aEnd - fadeA)), 1], [rounded(aEnd), 0], [rounded(D), 0]],
      vocalB: [[0, 0], [rounded(bStart), 0], [rounded(bOpen), 1], [rounded(D), 1]],
      automation,
      voiceEcho,
      reasons,
      debug: { ...plan.debug, stems: {
        model: A.vocalActivity.model,
        source: "demucs",
        policy: "phrase-safe-v3",
        vocalHandoff: rounded(aEnd),
        bVoiceStart: rounded(bStart),
        aBreath: breath,
        bBreath: best.bGap >= 0.75,
        lostA: rounded(heardA(swap) - heardA(aEnd)),
        lostB: rounded(heardB(bStart)),
        phrasesA: phrasesA.length,
        phrasesB: phrasesB.length,
        bleedGuard,
        fadeA: rounded(fadeA),
        fadeB: rounded(bOpen - bStart),
        cleanA,
        cleanB,
        ...lyricsA || lyricsB ? { lyrics: {
          a: !!lyricsA,
          b: !!lyricsB,
          verifiedA: !!(lyricsA == null ? void 0 : lyricsA.verified),
          verifiedB: !!(lyricsB == null ? void 0 : lyricsB.verified),
          // words a listener loses: A's still unsung words after its voice leaves (until A's gain is gone), B's words before it opens
          lostWordsA: lyricsA ? wordsIn(lyricsA, srcA(aEnd), srcA(Math.min(D, lastAudible(gA, D)))) : null,
          lostWordsB: lyricsB ? wordsIn(lyricsB, srcB(0), srcB(bStart)) : null
        } } : {},
        voiceEcho: voiceEcho != null ? voiceEcho : null,
        entryScore: rounded(vocalEntryScore(A, B, srcA(aEnd), srcB(bStart)))
      } }
    };
  }

  // packages/core/src/plan/loop.ts
  function withInstrumentalLoop(p, A, B, s, requestedAt) {
    var _a, _b, _c, _d;
    const g = A == null ? void 0 : A.beat, v = A == null ? void 0 : A.vocalActivity, arrival = (_a = p.entrySelection) == null ? void 0 : _a.arrivalTime;
    if (!A || !B || !g || !(v == null ? void 0 : v.vocalRmsDb) || !v.accompanimentRmsDb || !v.rate || requestedAt !== void 0 || !s.enabled || !s.eqHandoff || s.loopBridges === false || s.stemMixing === false || s.style === "tight" || p.debug.processingAllowed === false || p.method !== "crossfade" || p.duration < 4 || p.duration > 24 || p.voiceEcho || p.echo || ((_b = p.tempoA) == null ? void 0 : _b.some(([, r5]) => Math.abs(r5 - 1) > 1e-4)) || p.tempoB.some(([, r5]) => Math.abs(r5 - 1) > 1e-4) || !g.stable || g.confidence < 0.8 || g.downbeatConfidence < 0.75 || g.jitterMs > 12 || ((_d = (_c = A.structure) == null ? void 0 : _c.gridCheck) == null ? void 0 : _d.periodHint) || arrival === void 0) return p;
    const until = p.aExit + p.duration;
    if (until > A.audibleEnd + 1e-3 || until > A.duration || arrival - p.bEntry < p.duration * 0.4 || arrival - p.bEntry > p.duration) return p;
    const startIndex = g.downbeats.findIndex((t) => t >= p.aExit && t <= p.aExit + Math.min(1.5, p.duration / 4));
    if (startIndex < 0) return p;
    const start = g.downbeats[startIndex], crossfade = 6e-3;
    const lo = Math.max(0, Math.floor((p.aExit - crossfade) * v.rate)), hi = Math.ceil(A.audibleEnd * v.rate);
    if (hi > v.vocalRmsDb.length || hi > v.accompanimentRmsDb.length) return p;
    for (let i = lo; i < hi; i++) {
      const voice = v.vocalRmsDb[i], bed = v.accompanimentRmsDb[i];
      if (!Number.isFinite(voice) || !Number.isFinite(bed) || voice + p.gainA > -42 || voice > bed - 25) return p;
    }
    const mean = (from, to) => {
      const a = Math.max(0, Math.floor(from * A.curves.rate)), b = Math.ceil(to * A.curves.rate);
      if (b <= a || b > A.curves.rmsDb.length) return NaN;
      let power = 0;
      for (let i = a; i < b; i++) {
        const x = A.curves.rmsDb[i];
        if (!Number.isFinite(x)) return NaN;
        power += 10 ** (x / 10);
      }
      return 10 * Math.log10(Math.max(1e-12, power / (b - a)));
    };
    for (const bars of [1, 2]) {
      const end = g.downbeats[startIndex + bars], length = end - start;
      if (!Number.isFinite(end) || length < 1.2 || length > 8 || Math.abs(length - g.period * 4 * bars) > 0.015 || until - start < length * 1.4 || until - start > length * 3.5 || start < crossfade) continue;
      const level2 = mean(start, end), tail = mean(Math.max(end, until - 1), until);
      if (!Number.isFinite(level2) || !Number.isFinite(tail) || level2 < A.bodyRmsDb - 5 || level2 - tail < 5 || Math.abs(mean(start, start + length / 2) - mean(start + length / 2, end)) > 2) continue;
      const roll = s.djPhrasing !== false && s.style === "auto" && length >= 1.6 && until - start >= length * 1.875 ? [{ at: end, length: length / 2 }, { at: end + length / 2, length: length / 4 }] : void 0;
      return {
        ...p,
        id: `${p.id}_loop`,
        loopA: { start, end, until, crossfade, roll },
        reasons: [...p.reasons, "\u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430\u043B\u044C\u043D\u044B\u0439 \u0442\u0430\u043A\u0442 \u0443\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442 \u043F\u0443\u043B\u044C\u0441 \u0437\u0430\u0442\u0443\u0445\u0430\u044E\u0449\u0435\u0433\u043E \u0444\u0438\u043D\u0430\u043B\u0430 \u0434\u043E \u043F\u0440\u0438\u0445\u043E\u0434\u0430 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0439 \u043C\u0443\u0437\u044B\u043A\u0430\u043B\u044C\u043D\u043E\u0439 \u0447\u0430\u0441\u0442\u0438; \u0443\u0440\u043E\u0432\u0435\u043D\u044C \u0432\u043E\u043A\u0430\u043B\u0430 \u043F\u0440\u043E\u0432\u0435\u0440\u0435\u043D \u043F\u043E \u043E\u0442\u0434\u0435\u043B\u0451\u043D\u043D\u043E\u0439 \u043F\u0430\u0440\u0442\u0438\u0438"],
        debug: { ...p.debug, loopBridge: { bars, cycles: (until - start) / length, originalDropDb: level2 - tail, measuredVoice: true, roll: !!roll } }
      };
    }
    return p;
  }

  // packages/core/src/plan/master-tempo.ts
  var round = (x) => Math.round(x * 1e3) / 1e3;
  function withMasterTempo(p, A, B, s, requestedAt) {
    var _a, _b, _c, _d, _e, _f, _g;
    if (!s.enabled || s.masterTempo === false || s.stemMixing === false || requestedAt !== void 0 || !A || !B || p.debug.processingAllowed === false || p.method !== "beatmatch_blend" || !((_a = p.tempoA) == null ? void 0 : _a.length) || !p.beatAlign || p.duration < 6 || p.loopA || p.vocalA || p.vocalB || p.voiceEcho || p.beatAlign.bridge || p.beatAlign.regions || !((_b = A.beat) == null ? void 0 : _b.stable) || !((_c = B.beat) == null ? void 0 : _c.stable) || A.beat.confidence < 0.8 || B.beat.confidence < 0.8 || A.beat.jitterMs > 12 || B.beat.jitterMs > 12 || ((_e = (_d = A.structure) == null ? void 0 : _d.gridCheck) == null ? void 0 : _e.periodHint) || ((_g = (_f = B.structure) == null ? void 0 : _f.gridCheck) == null ? void 0 : _g.periodHint)) return p;
    const ratio = pointValue(p.tempoB, 0) / pointValue(p.tempoA, 0);
    const stretch = Math.max(Math.abs(ratio - 1), Math.abs(1 / ratio - 1)) * 100;
    if (!Number.isFinite(ratio) || stretch < 0.2 || stretch > Math.min(3, s.maxStretchPercent) + 1e-6) return p;
    for (const [t] of [...p.tempoA, ...p.tempoB]) {
      if (t > p.duration) return p;
      if (Math.abs(pointValue(p.tempoB, t) / pointValue(p.tempoA, t) - ratio) > 2e-6) return p;
    }
    const aEnd = p.aExit + integrateTempo(p.tempoA, p.duration);
    const bEnd = p.bEntry + integrateTempo(p.tempoB, p.duration);
    const covered = (an, from, to) => {
      const v = an.vocalActivity;
      return !!v && Number.isFinite(v.rate) && v.rate > 0 && from >= 0 && to > from && to * v.rate <= v.values.length && v.values.slice(Math.floor(from * v.rate), Math.ceil(to * v.rate)).every((x) => Number.isFinite(x) && x >= 0 && x <= 1);
    };
    const aVoiceEnd = p.aExit + (aEnd - p.aExit) * 0.6;
    const bIntroEnd = p.bEntry + Math.min(3, (bEnd - p.bEntry) * 0.3);
    if (!covered(A, p.aExit, aVoiceEnd) || vocalMean(A, p.aExit, aVoiceEnd) < 0.5 || !covered(B, p.bEntry, bIntroEnd) || vocalMean(B, p.bEntry, bIntroEnd) > 0.2) return p;
    const duration = round(aEnd - p.aExit);
    if (duration > s.maxBlendSeconds || duration <= 0) return p;
    const recovery = round(Math.max(4, Math.min(8, A.beat.period * 8)));
    if (bEnd + recovery * Math.max(1, ratio) + 2 > B.audibleEnd) return p;
    const time = (t) => round(integrateTempo(p.tempoA, t));
    const tempoB = [[0, ratio], [duration, ratio]];
    for (let i = 1; i <= 12; i++) {
      const x = i / 12, smooth = x * x * (3 - 2 * x);
      tempoB.push([round(duration + recovery * x), i === 12 ? 1 : ratio + (1 - ratio) * smooth]);
    }
    let echo = p.echo;
    if (echo) {
      let delay = A.beat.period;
      while (delay < 0.3) delay *= 2;
      while (delay > 0.8) delay /= 2;
      echo = { ...echo, delay: round(delay) };
    }
    return {
      ...p,
      duration,
      swapAt: time(p.swapAt),
      tempoA: void 0,
      tempoB,
      echo,
      automation: p.automation.map((l) => ({ ...l, points: l.points.map(([t, gain]) => [time(t), gain]) })),
      beatAlign: { ...p.beatAlign, glide: false, masterDeck: "A", recoverySeconds: recovery },
      reasons: [
        ...p.reasons.filter((r5) => !r5.startsWith("\u043E\u0431\u0449\u0438\u0439 \u0442\u0435\u043C\u043F \u043F\u043B\u0430\u0432\u043D\u043E \u043F\u0435\u0440\u0435\u0445\u043E\u0434\u0438\u0442")),
        `\u0442\u0435\u043C\u043F \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0432\u043E\u043A\u0430\u043B\u0430 \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u0435\u0442\u0441\u044F: \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u0442\u0440\u0435\u043A \u043F\u043E\u0434\u0441\u0442\u0440\u0430\u0438\u0432\u0430\u0435\u0442\u0441\u044F, \u0437\u0430\u0442\u0435\u043C \u0437\u0430 ${recovery} \u0441 \u0432\u043E\u0437\u0432\u0440\u0430\u0449\u0430\u0435\u0442\u0441\u044F \u043A \u0441\u0432\u043E\u0435\u043C\u0443 \u0442\u0435\u043C\u043F\u0443`
      ],
      debug: {
        ...p.debug,
        ...typeof p.debug.holdUntil === "number" ? { holdUntil: time(p.debug.holdUntil) } : {},
        masterTempo: { policy: "vocal-master-1", deck: "A", ratio, recoverySeconds: recovery, previousDuration: p.duration }
      }
    };
  }

  // packages/core/src/plan/dj-phrasing.ts
  var r = (x) => Math.round(x * 1e3) / 1e3;
  function withDjPhrasing(p, A, B, s, requestedAt) {
    var _a, _b, _c, _d, _e, _f;
    if (!s.enabled || s.djPhrasing === false || !s.eqHandoff || s.stemMixing === false || s.style === "tight" || requestedAt !== void 0 || p.debug.processingAllowed === false || !A || !B || !["crossfade", "beatmatch_blend"].includes(p.method) || p.duration < 6 || p.duration > 32 || p.loopA || p.voiceEcho || ((_a = p.beatAlign) == null ? void 0 : _a.regions) || !p.vocalA || !B.vocalActivity || !A.vocalActivity || p.automation.some((l) => l.lane === "filter") || !((_b = B.beat) == null ? void 0 : _b.stable) || B.beat.confidence < 0.8 || B.beat.downbeatConfidence < 0.7 || B.beat.jitterMs > 12 || ((_d = (_c = B.structure) == null ? void 0 : _c.gridCheck) == null ? void 0 : _d.periodHint)) return p;
    const D = p.duration, ba = B.beat;
    const value = (deck, name, t) => {
      var _a2, _b2;
      return pointValue((_b2 = (_a2 = p.automation.find((l) => l.deck === deck && l.lane === name)) == null ? void 0 : _a2.points) != null ? _b2 : [[0, name === "echo" ? 0 : 1]], t);
    };
    const mean = (an, c, from, to) => {
      const rate = an.curves.rate, lo = Math.floor(from * rate), hi = Math.ceil(to * rate);
      if (!(rate > 0) || lo < 0 || hi > c.length || hi <= lo) return NaN;
      let power = 0;
      for (let i = lo; i < hi; i++) {
        if (!Number.isFinite(c[i])) return NaN;
        power += 10 ** (c[i] / 10);
      }
      return 10 * Math.log10(Math.max(1e-12, power / (hi - lo)));
    };
    const candidates = [.../* @__PURE__ */ new Set([...(_e = B.sectionBoundaries) != null ? _e : [], ...((_f = p.entrySelection) == null ? void 0 : _f.arrivalTime) !== void 0 ? [p.entrySelection.arrivalTime] : []])].map((source) => ({ source, t: outputTimeAt(p.tempoB, source - p.bEntry, D) })).filter((c) => c.source > p.bEntry && c.t >= Math.max(3, D * 0.35) && c.t <= D * 0.85 && ba.downbeats.some((t) => Math.abs(t - c.source) < 0.035)).slice(0, 16);
    for (const { source, t: arrival } of candidates) {
      const speed = pointValue(p.tempoB, arrival), beat = ba.period / speed, bar = beat * 4, start = r(Math.max(0, arrival - bar));
      if (arrival - start < 1.2 || arrival - start > 5 || start < 0.5) continue;
      if ([start, arrival, ...p.vocalA.map(([t]) => t).filter((t) => t > start && t < arrival)].some((t) => pointValue(p.vocalA, t) > 1e-3)) continue;
      if (p.vocalB && [arrival, D, ...p.vocalB.map(([t]) => t).filter((t) => t > arrival)].some((t) => pointValue(p.vocalB, t) < 0.999)) continue;
      const bFrom = p.bEntry + integrateTempo(p.tempoB, start), bTo = p.bEntry + integrateTempo(p.tempoB, arrival - 0.04), v = B.vocalActivity;
      if (!(v.rate > 0) || bFrom < 0 || bTo <= bFrom || Math.ceil(bTo * v.rate) > v.values.length) continue;
      const bins = v.values.slice(Math.floor(bFrom * v.rate), Math.ceil(bTo * v.rate));
      if (bins.some((x) => !Number.isFinite(x) || x < 0 || x > 0.28) || vocalMean(B, bFrom, bTo) > 0.12) continue;
      const beforeLow = mean(B, B.curves.lowDb, Math.max(B.audibleStart, source - ba.period * 4), source - 0.08);
      const afterLow = mean(B, B.curves.lowDb, source, Math.min(B.audibleEnd, source + ba.period * 4));
      const before = mean(B, B.curves.rmsDb, Math.max(B.audibleStart, source - ba.period * 4), source - 0.08);
      const after = mean(B, B.curves.rmsDb, source, Math.min(B.audibleEnd, source + ba.period * 4));
      const locked = !!p.beatAlign;
      if (![beforeLow, afterLow, before, after].every(Number.isFinite) || after - before < 2 || afterLow - beforeLow < (locked ? 3 : 9) || after < B.bodyRmsDb - 5) continue;
      const end = r(arrival), cut = r(Math.max(start + 0.3, arrival - 0.12)), close = r(Math.min(start + 0.3, cut - 0.2));
      const lane2 = (deck, name, points) => ({ deck, lane: name, points });
      const prefix = (deck, name) => {
        var _a2, _b2;
        return ((_b2 = (_a2 = p.automation.find((l) => l.deck === deck && l.lane === name)) == null ? void 0 : _a2.points) != null ? _b2 : [[0, value(deck, name, 0)]]).filter(([t]) => t < start);
      };
      const automation = p.automation.filter((l) => !(l.lane === "echo" && l.deck === "A") && !["gain", "low"].includes(l.lane));
      automation.push(
        lane2("A", "gain", [...prefix("A", "gain"), [start, value("A", "gain", start)], [cut, value("A", "gain", cut)], [end, 0], [D, 0]]),
        lane2("B", "gain", [...prefix("B", "gain"), [start, value("B", "gain", start)], [end, 1], [D, 1]]),
        lane2("A", "low", [...prefix("A", "low"), [start, value("A", "low", start)], [r(end - beat * 0.5), 0], [D, 0]]),
        lane2("B", "low", [...prefix("B", "low"), [start, value("B", "low", start)], [close, 0], [r(end - 0.06), 0], [r(end + 0.04), 1], [D, 1]]),
        lane2("A", "filter", [[0, 0], [start, 0], [cut, 0.68], [D, 0.68]]),
        lane2("B", "filter", [[0, 0], [start, 0], [close, -0.55], [r(end - 0.22), -0.55], [r(end - 0.04), 0], [D, 0]]),
        lane2("A", "echo", [[0, 0], [r(Math.max(start, end - beat)), 0], [r(Math.max(start + 0.04, end - beat + 0.06)), 0.18], [cut, 0.18], [end, 0], [D, 0]])
      );
      let delay = beat;
      while (delay < 0.3) delay *= 2;
      while (delay > 0.8) delay /= 2;
      return {
        ...p,
        automation,
        echo: { delay: r(delay), feedback: 0.22 },
        reasons: [...p.reasons, "\u043F\u043E\u0434\u0432\u043E\u0434\u043A\u0430 \u043A \u0438\u0437\u043C\u0435\u0440\u0435\u043D\u043D\u043E\u043C\u0443 \u0432\u0441\u0442\u0443\u043F\u043B\u0435\u043D\u0438\u044E: \u0444\u0438\u043B\u044C\u0442\u0440\u044B \u0441\u043E\u0437\u0434\u0430\u044E\u0442 \u043D\u0430\u043F\u0440\u044F\u0436\u0435\u043D\u0438\u0435, \u0431\u0430\u0441 \u043E\u0442\u043A\u0440\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u043D\u0430 \u0441\u0438\u043B\u044C\u043D\u043E\u0439 \u0434\u043E\u043B\u0435, \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430\u043B \u0443\u0445\u043E\u0434\u044F\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430 \u043E\u0441\u0442\u0430\u0451\u0442\u0441\u044F \u043A\u043E\u0440\u043E\u0442\u043A\u0438\u043C \u044D\u0445\u043E\u043C"],
        debug: { ...p.debug, djFilterRelease: { policy: "filter-release-1", from: start, arrival: end, sourceB: source, bassRiseDb: r(afterLow - beforeLow), energyRiseDb: r(after - before), locked, echoDelay: r(delay) } }
      };
    }
    return p;
  }

  // packages/core/src/plan/first-words.ts
  var r2 = (x) => Math.round(x * 1e3) / 1e3;
  function firstVoice(an, from, to) {
    const v = an.vocalActivity;
    if (!v || !(v.rate > 0) || !Number.isFinite(v.rate) || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to > an.duration + 1e-6 || Math.ceil((to - 1e-8) * v.rate) > v.values.length) return null;
    let first = Infinity;
    for (let i = Math.floor(from * v.rate); i < Math.min(v.values.length, Math.ceil((to - 1e-8) * v.rate)); i++) {
      const x = v.values[i];
      if (!Number.isFinite(x) || x < 0 || x > 1) return null;
      if (x >= 0.28 && !Number.isFinite(first)) first = Math.max(from, i / v.rate);
    }
    const words = lyricTiming(an);
    if (words == null ? void 0 : words.verified) {
      for (const [a, b] of words.edit) if (b > from && a < to) {
        first = Math.min(first, Math.max(from, a));
        break;
      }
    }
    return first;
  }
  function preserveFirstWords(p, A, B, s) {
    var _a, _b, _c, _d, _e, _f, _g;
    if (!s.enabled || s.stemMixing === false || !B || p.debug.processingAllowed === false || p.debug.requested === true || p.duration < 0.7 || !["crossfade", "beatmatch_blend"].includes(p.method) || p.loopA) return p;
    const D = p.duration, sourceEnd = p.bEntry + integrateTempo(p.tempoB, D), first = firstVoice(B, p.bEntry, sourceEnd);
    if (first === null || !Number.isFinite(first)) return p;
    const attack = r2(first <= p.bEntry ? 0 : outputTimeAt(p.tempoB, first - p.bEntry, D));
    const at = (deck, name, t) => {
      var _a2, _b2;
      return pointValue((_b2 = (_a2 = p.automation.find((l) => l.deck === deck && l.lane === name)) == null ? void 0 : _a2.points) != null ? _b2 : [[0, name === "filter" ? 0 : 1]], t);
    };
    const mask = pointValue((_a = p.vocalB) != null ? _a : [[0, 1]], attack);
    if (mask >= 0.999 && at("B", "gain", attack) >= 0.999 && at("B", "mid", attack) >= 0.5 && at("B", "high", attack) >= 0.5 && Math.abs(at("B", "filter", attack)) < 1e-3) return p;
    const deadline = r2(Math.max(0, attack - 0.035));
    const srcA = (t) => p.aExit + integrateTempo(p.tempoA, t);
    const spans = A ? (_c = (_b = lyricTiming(A)) == null ? void 0 : _b.edit) != null ? _c : vocalPhrases(A).filter((x) => x.confidence >= 0.35).map((x) => [x.start, x.end]) : [];
    let quiet = -1;
    if (A && deadline >= 0.1 && firstVoice(A, srcA(0), srcA(Math.min(D, deadline + 0.08))) !== null) {
      for (let t = deadline; t >= Math.max(0.1, deadline - 2); t -= 0.02) {
        const lo = srcA(Math.max(0, t - 0.08)), hi = srcA(t + 0.035);
        if (vocalMean(A, lo, hi) <= 0.12 && !spans.some(([a, b]) => hi > a && lo < b)) {
          quiet = r2(t);
          break;
        }
      }
    }
    const oldEnd = Number((_e = (_d = p.debug.stems) == null ? void 0 : _d.vocalHandoff) != null ? _e : D);
    const laterVoice = A ? firstVoice(A, srcA(Math.min(deadline, D - 1e-3)), srcA(D)) : null;
    const alreadyQuiet = !!p.vocalA && oldEnd <= deadline || A && firstVoice(A, srcA(0), srcA(D)) === Infinity;
    const activity = A == null ? void 0 : A.vocalActivity, bed = activity == null ? void 0 : activity.accompanimentRmsDb;
    const bedFrom = activity ? Math.floor(srcA(0) * activity.rate) : 0, bedTo = activity ? Math.ceil(srcA(Math.min(D, 4)) * activity.rate) : 0;
    const earlyStem = s.eqHandoff && !!p.vocalA && (activity == null ? void 0 : activity.source) === "demucs" && !!A && firstVoice(A, srcA(0), srcA(D)) !== null && !!bed && bedTo > bedFrom && bedTo <= bed.length && bed.slice(bedFrom, bedTo).every((x) => Number.isFinite(x) && x >= -42 && x <= 60);
    const wholeDeck = !earlyStem && (laterVoice !== Infinity || !alreadyQuiet && quiet < 0);
    const immediate = attack <= 0.012;
    const end = r2(earlyStem ? quiet >= 0 ? quiet : Math.max(0.04, deadline) : wholeDeck ? Math.max(immediate ? 0.3 : 0.04, quiet >= 0 ? quiet : deadline) : alreadyQuiet ? Math.min(oldEnd, deadline) : quiet);
    const fade = wholeDeck && quiet < 0 ? Math.min(0.45, end) : 0.06, from = r2(Math.max(0, end - fade));
    const outgoing = (t) => t <= from ? 1 : t >= end ? 0 : Math.cos((t - from) / (end - from) * Math.PI / 2);
    const open = r2(Math.max(0.012, deadline)), gainOpen = r2(immediate ? 0.3 : open), rise = r2(Math.max(0, open - Math.min(1.2, open)));
    const lift = !wholeDeck, floorB = 1 / VOICE_LIFT_MAX;
    let automation = p.automation.filter((l) => !(l.deck === "A" && (l.lane === "voiceEcho" || (wholeDeck || earlyStem) && l.lane === "echo")));
    automation = automation.map((l) => {
      const incoming = l.deck === "B" && (["gain", "mid", "high", "filter"].includes(l.lane) || wholeDeck && l.lane === "low");
      if (!incoming && !(wholeDeck && l.deck === "A" && l.lane === "gain")) return l;
      const knots = [.../* @__PURE__ */ new Set([...l.points.map(([t]) => t), 0, D, ...Array.from({ length: 13 }, (_, i) => incoming && l.lane === "gain" && immediate ? gainOpen * i / 12 : incoming ? rise + (open - rise) * i / 12 : from + (end - from) * i / 12)])].sort((a, b) => a - b);
      return { ...l, points: knots.map((t) => {
        const old = pointValue(l.points, t);
        if (!incoming) return [r2(t), r2(Math.min(old, outgoing(t)))];
        const laneOpen = l.lane === "gain" && immediate ? gainOpen : open, laneRise = l.lane === "gain" && immediate ? 0 : rise;
        const x = t <= laneRise ? 0 : t >= laneOpen ? 1 : (t - laneRise) / (laneOpen - laneRise), floor = l.lane === "low" ? Math.sqrt(Math.max(0, 1 - outgoing(t) ** 2)) : Math.sin(x * Math.PI / 2) * (lift && l.lane === "gain" ? floorB : 1);
        return [r2(t), r2(l.lane === "filter" ? old * (1 - x) : Math.max(old, floor))];
      }) };
    });
    if (!wholeDeck && (earlyStem || !alreadyQuiet) && s.eqHandoff) automation = guardLanes(automation, from, Math.max(end, deadline), D, { mid: BLEED_MID, high: BLEED_HIGH });
    const vocalA = wholeDeck ? void 0 : alreadyQuiet && !earlyStem ? p.vocalA : [[0, 1], [from, 1], [end, 0], [D, 0]];
    const voiceRise = immediate ? 0 : rise, voiceOpen = immediate ? gainOpen : open;
    const voice = (t) => t <= voiceRise ? 0 : t >= voiceOpen ? 1 : Math.sin((t - voiceRise) / (voiceOpen - voiceRise) * Math.PI / 2);
    let vocalB = deadline <= 0.012 ? void 0 : [[0, 0], [rise, 0], [open, 1], [D, 1]];
    if (lift) {
      const gainB = (_g = (_f = automation.find((l) => l.deck === "B" && l.lane === "gain")) == null ? void 0 : _f.points) != null ? _g : [[0, 1]];
      const knots = [.../* @__PURE__ */ new Set([
        0,
        D,
        ...gainB.map(([t]) => t),
        ...Array.from({ length: 13 }, (_, i) => voiceRise + (voiceOpen - voiceRise) * i / 12),
        ...Array.from({ length: Math.ceil(D / 0.25) }, (_, i) => i * 0.25)
      ])].filter((t) => t >= 0 && t <= D).sort((a, b) => a - b);
      vocalB = knots.map((t) => [r2(t), r2(Math.min(VOICE_LIFT_MAX, voice(t) / Math.max(1e-3, pointValue(gainB, t))))]);
      while (vocalB.length > 2 && Math.abs(vocalB[vocalB.length - 2][1] - 1) < 1e-3 && vocalB[vocalB.length - 1][1] === 1) vocalB.pop();
    }
    return {
      ...p,
      automation,
      vocalA,
      vocalB,
      voiceEcho: void 0,
      echo: automation.some((l) => l.lane === "echo") ? p.echo : void 0,
      reasons: [
        ...p.reasons.filter((x) => !/^(голос следующего трека|последнее слово текущего голоса|текущий трек уходит в эхо|подводка к измеренному вступлению:)/.test(x)),
        earlyStem ? "\u043D\u043E\u0432\u044B\u0439 \u0433\u043E\u043B\u043E\u0441 \u043D\u0430\u0447\u0438\u043D\u0430\u0435\u0442\u0441\u044F \u0441\u0440\u0430\u0437\u0443: \u043F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0438\u0439 \u0433\u043E\u043B\u043E\u0441 \u0443\u0431\u0440\u0430\u043D \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u043E, \u0438\u0437\u043C\u0435\u0440\u0435\u043D\u043D\u0430\u044F \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430\u043B\u044C\u043D\u0430\u044F \u043F\u0430\u0440\u0442\u0438\u044F \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u0435\u0442 \u0440\u0438\u0442\u043C \u0441\u0432\u0435\u0434\u0435\u043D\u0438\u044F" : wholeDeck ? "\u043F\u0435\u0440\u0432\u044B\u0435 \u0441\u043B\u043E\u0432\u0430 \u043D\u043E\u0432\u043E\u0433\u043E \u0442\u0440\u0435\u043A\u0430 \u043D\u0435 \u0436\u0434\u0443\u0442 \u0432\u043E\u043A\u0430\u043B\u044C\u043D\u043E\u0439 \u043C\u0430\u0441\u043A\u0438: \u0442\u0435\u043A\u0443\u0449\u0430\u044F \u0437\u0430\u043F\u0438\u0441\u044C \u0446\u0435\u043B\u0438\u043A\u043E\u043C \u043F\u043B\u0430\u0432\u043D\u043E \u0443\u0441\u0442\u0443\u043F\u0430\u0435\u0442 \u0438\u043C \u043C\u0435\u0441\u0442\u043E" : "\u043D\u043E\u0432\u044B\u0439 \u0433\u043E\u043B\u043E\u0441 \u043E\u0442\u043A\u0440\u044B\u0442 \u0434\u043E \u043F\u0435\u0440\u0432\u043E\u0439 \u0438\u0437\u043C\u0435\u0440\u0435\u043D\u043D\u043E\u0439 \u0430\u0442\u0430\u043A\u0438; \u0442\u0435\u043A\u0443\u0449\u0438\u0439 \u0437\u0430\u043A\u0430\u043D\u0447\u0438\u0432\u0430\u0435\u0442\u0441\u044F \u0432 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E\u0439 \u0438\u0437\u043C\u0435\u0440\u0435\u043D\u043D\u043E\u0439 \u043F\u0430\u0443\u0437\u0435"
      ],
      debug: {
        ...p.debug,
        djFilterRelease: void 0,
        firstWords: {
          policy: "first-words-1",
          attack,
          source: first,
          previousHandoff: oldEnd,
          wholeDeckFade: wholeDeck,
          outgoingTailMeasuredQuiet: laterVoice === Infinity,
          earlyStemHandoff: earlyStem,
          unavoidableOverlapSeconds: r2(Math.max(0, end - attack)),
          declickSeconds: attack < 0.012 ? 0.012 : 0,
          gainRiseSeconds: r2(immediate ? 0.3 : Math.min(1.2, open)),
          voiceLift: lift
        },
        stems: {
          ...p.debug.stems,
          policy: "first-words-1",
          vocalHandoff: end,
          bVoiceStart: deadline,
          lostB: 0,
          voiceEcho: null,
          ...wholeDeck ? { wholeDeckFade: { from, to: end } } : {}
        }
      }
    };
  }
  function outgoingPhraseCut(p, A) {
    const D = p.duration, srcA = (t) => p.aExit + integrateTempo(p.tempoA, t);
    const lane2 = (name, t) => {
      var _a, _b;
      return pointValue((_b = (_a = p.automation.find((l) => l.deck === "A" && l.lane === name)) == null ? void 0 : _a.points) != null ? _b : [[0, name === "filter" ? 0 : 1]], t);
    };
    const effective = (t) => {
      var _a;
      return pointValue((_a = p.vocalA) != null ? _a : [[0, 1]], t) * lane2("gain", t) * Math.min(lane2("mid", t), lane2("high", t));
    };
    const phrases = vocalPhrases(A).filter((x) => x.confidence >= 0.35);
    let cut = -1, endSource = -1;
    for (let t = 0; t < D; t += 0.02) {
      if (effective(t) >= 0.5) continue;
      const phrase = phrases.find((x) => x.start < srcA(t) && x.end > srcA(t) + 0.03);
      if (!phrase) continue;
      const start = phrase.start <= p.aExit ? 0 : outputTimeAt(p.tempoA, phrase.start - p.aExit, D);
      if (effective(start) < 0.5) continue;
      cut = t;
      endSource = phrase.end;
      break;
    }
    return cut < 0 ? null : { cut, endSource };
  }
  function withVocalGap(p, A, B, s) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l;
    if (!s.enabled || s.stemMixing === false || !(A == null ? void 0 : A.vocalActivity) || !(B == null ? void 0 : B.vocalActivity) || p.bDelay || p.loopA || p.tapeStopA || p.debug.processingAllowed === false || p.debug.requested === true || p.debug.variant === "instrumental-bridge" || !["crossfade", "beatmatch_blend"].includes(p.method)) return p;
    const D = p.duration, srcA = (t) => p.aExit + integrateTempo(p.tempoA, t);
    const available = Math.min(A.duration, A.audibleEnd);
    if (firstVoice(A, p.aExit, Math.min(available, srcA(D))) === null) return p;
    const attackSource = firstVoice(B, p.bEntry, Math.min(B.duration, p.bEntry + integrateTempo(p.tempoB, D)));
    if (attackSource === null || !Number.isFinite(attackSource)) return p;
    const bWord = outputTimeAt(p.tempoB, attackSource - p.bEntry, D);
    const clipped = outgoingPhraseCut(p, A);
    if (!clipped) return p;
    const { cut, endSource } = clipped, phrases = vocalPhrases(A).filter((x) => x.confidence >= 0.35);
    if (cut < 0 || endSource > available - 0.08 || endSource > srcA(cut + 16)) return p;
    const end = outputTimeAt(p.tempoA, endSource - p.aExit, D + 16), off = end + 0.12;
    if (firstVoice(A, p.aExit, Math.min(available, srcA(off) + 0.02)) === null) return p;
    if ((_a = lyricTiming(A)) == null ? void 0 : _a.edit.some(([a, b]) => srcA(off) + 0.02 > a && endSource < b)) return p;
    if (phrases.some((x) => x.start < srcA(off) + 0.02 && x.end > endSource + 1e-3 && x.start >= endSource)) return p;
    let delay = Math.max(0, off + 0.08 - bWord);
    if (delay > 0 && p.method === "beatmatch_blend") {
      const bar = ((_g = (_f = (_d = (_c = (_b = p.beatAlign) == null ? void 0 : _b.regions) == null ? void 0 : _c.A) == null ? void 0 : _d.period) != null ? _f : (_e = A.beat) == null ? void 0 : _e.period) != null ? _g : 0.5) * 4;
      delay = outputTimeAt(p.tempoA, Math.ceil(integrateTempo(p.tempoA, delay) / bar - 1e-6) * bar, D + 16);
      const rates = ((_h = p.tempoA) != null ? _h : [[0, 1]]).map(([, v]) => v);
      if ((Math.max(...rates) - Math.min(...rates)) * (D + delay) > 0.02) return p;
    }
    if (delay > 16.01) return p;
    const N = r2(Math.max(D + delay, off + 0.4)), release = Math.min(off + 0.4, outputTimeAt(p.tempoA, available - p.aExit, N));
    const cap = Number.isFinite(s.maxBlendSeconds) ? Math.max(0, Math.min(60, s.maxBlendSeconds)) : 32;
    if (release <= off || N > cap + 1e-3 || p.bEntry + integrateTempo(p.tempoB, N - delay) > B.audibleEnd + 1e-3) return p;
    const shifted = p.automation.map((l) => {
      var _a2, _b2;
      return l.deck === "A" && delay ? { ...l, points: [[0, (_b2 = (_a2 = l.points[0]) == null ? void 0 : _a2[1]) != null ? _b2 : 1], ...l.points.map(([t, v]) => [r2(t + delay), v])] } : l;
    });
    const tail = outputTimeAt(p.tempoA, available - p.aExit, N), bassB = (_j = (_i = p.automation.find((l) => l.deck === "B" && l.lane === "low")) == null ? void 0 : _i.points) != null ? _j : [[0, 1]];
    const gainB = (_l = (_k = p.automation.find((l) => l.deck === "B" && l.lane === "gain")) == null ? void 0 : _k.points) != null ? _l : [[0, 1]];
    if (delay && tail < N - 0.02 && (tail <= delay || pointValue(bassB, tail - delay) * pointValue(gainB, tail - delay) < 0.7)) return p;
    const automation = shifted.filter((l) => l.lane !== "voiceEcho" && !(l.deck === "A" && l.lane === "echo")).map((l) => {
      if (l.deck !== "A" || !["gain", "mid", "high", "filter"].includes(l.lane)) return l;
      const times = [.../* @__PURE__ */ new Set([0, end, off, release, N, ...l.points.map(([t]) => t)])].sort((a, b) => a - b);
      return { ...l, points: times.map((t) => {
        const old = pointValue(l.points, t), keep = t <= end ? 1 : t >= release ? 0 : Math.cos((t - end) / (release - end) * Math.PI / 2);
        return [r2(t), r2(l.lane === "filter" ? old * (1 - keep) : Math.max(old, keep))];
      }) };
    });
    const guarded = s.eqHandoff ? guardLanes(automation, r2(end), r2(off), N, { mid: BLEED_MID, high: BLEED_HIGH }) : automation;
    return {
      ...p,
      duration: N,
      swapAt: r2(p.swapAt + delay),
      ...delay ? { bDelay: r2(delay) } : {},
      automation: guarded,
      vocalA: [[0, 1], [r2(end), 1], [r2(off), 0], [N, 0]],
      voiceEcho: void 0,
      echo: void 0,
      reasons: [...p.reasons, "\u0437\u0432\u0443\u0447\u0430\u0449\u0430\u044F \u0444\u0440\u0430\u0437\u0430 \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0433\u043E\u043B\u043E\u0441\u0430 \u0437\u0430\u043A\u0430\u043D\u0447\u0438\u0432\u0430\u0435\u0442\u0441\u044F \u0434\u043E \u043F\u0435\u0440\u0435\u0434\u0430\u0447\u0438: \u0433\u0440\u043E\u043C\u043A\u043E\u0441\u0442\u044C \u0434\u0435\u043A\u0438 \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u0435\u0442 \u0435\u0451 \u043E\u043A\u043E\u043D\u0447\u0430\u043D\u0438\u0435"],
      debug: {
        ...p.debug,
        ...p.debug.firstWords ? { firstWords: { ...p.debug.firstWords, wholeDeckFade: false, earlyStemHandoff: true, deferredBy: r2(delay) } } : {},
        vocalGap: { policy: "finish-utterance-1", cut: r2(cut), end: r2(end), off: r2(off), bWord: r2(bWord + delay), gap: r2(bWord + delay - off), bDelay: r2(delay) },
        stems: { ...p.debug.stems, policy: "finish-utterance-1", vocalHandoff: r2(off), bVoiceStart: r2(bWord + delay), voiceEcho: null, wholeDeckFade: void 0, cleanA: true, fadeA: 0.12 }
      }
    };
  }

  // packages/core/src/plan/fullmix.ts
  var voiceUnknown = (an, s) => s.stemMixing === false || !(an == null ? void 0 : an.vocalActivity);
  var fullMixPair = (A, B, s) => voiceUnknown(A, s) || voiceUnknown(B, s);
  var clamp2 = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  var r3 = (x) => Math.round(x * 1e3) / 1e3;
  function laneValue(p, deck, name, t) {
    var _a, _b;
    return pointValue((_b = (_a = p.automation.find((l) => l.deck === deck && l.lane === name)) == null ? void 0 : _a.points) != null ? _b : [[0, name === "filter" || name === "echo" ? 0 : 1]], t);
  }
  function bands(an, src) {
    const c = an.curves, rate = c.rate;
    if (!(rate > 0)) return null;
    const lo = Math.max(0, Math.floor((src - 0.5) * rate)), hi = Math.min(c.lowDb.length, Math.ceil((src + 0.5) * rate));
    if (hi <= lo) return null;
    const out = [0, 0, 0];
    const lin = [linearPower(c.lowDb), linearPower(c.midDb), linearPower(c.highDb)];
    for (let i = lo; i < hi; i++) {
      if (!(Number.isFinite(c.lowDb[i]) && Number.isFinite(c.midDb[i]) && Number.isFinite(c.highDb[i]))) return null;
      for (let k = 0; k < 3; k++) out[k] += lin[k][i];
    }
    return out.map((x) => x / (hi - lo));
  }
  var LOW_HZ = [50, 80, 120];
  var MID_HZ = [250, 700, 1800];
  var HIGH_HZ = [3500, 6e3, 9e3];
  function sweepPower(v, hz) {
    const a = clamp2(Math.abs(v));
    if (a < 1e-6) return 1;
    const upper = 48e3 * 0.45, fc = v > 0 ? 20 * Math.exp(Math.log(300) * a) : upper * Math.exp(Math.log(180 / upper) * a);
    const wet = Math.min(1, a / 0.08);
    return hz.reduce((sum, f) => {
      const r5 = (f / fc) ** 4, h = Math.sqrt(v > 0 ? r5 / (1 + r5) : 1 / (1 + r5));
      return sum + (1 - wet + wet * h) ** 2;
    }, 0) / hz.length;
  }
  function deckPower(p, an, deck, t) {
    var _a;
    const delay = deck === "B" ? (_a = p.bDelay) != null ? _a : 0 : 0, tt = t - delay;
    if (tt < 0) return { total: 0, low: 0, mid: 0 };
    const src = deck === "A" ? p.aExit + integrateTempo(p.tempoA, tt) : p.bEntry + integrateTempo(p.tempoB, tt);
    if (src > an.audibleEnd) return { total: 0, low: 0, mid: 0 };
    const b = bands(an, src);
    if (!b) return null;
    const g = laneValue(p, deck, "gain", tt) ** 2 * 10 ** ((deck === "A" ? p.gainA : p.gainB) / 10);
    const f = laneValue(p, deck, "filter", tt);
    const low = b[0] * laneValue(p, deck, "low", tt) ** 2 * g * sweepPower(f, LOW_HZ);
    const mid = b[1] * laneValue(p, deck, "mid", tt) ** 2 * g * sweepPower(f, MID_HZ);
    const high = b[2] * laneValue(p, deck, "high", tt) ** 2 * g * sweepPower(f, HIGH_HZ);
    return { total: low + mid + high, low, mid };
  }
  function effectiveExit(p, A) {
    const D = p.duration;
    for (let t = D; t >= 0; t -= 0.1) {
      const src = p.aExit + integrateTempo(p.tempoA, t), b = bands(A, src), q = deckPower(p, A, "A", t);
      if (!b || !q) continue;
      if (q.total >= 0.1 * (b[0] + b[1] + b[2]) * 10 ** (p.gainA / 10)) return { t: r3(t), source: r3(src) };
    }
    return { t: 0, source: p.aExit };
  }
  function pickupLost(B, entry) {
    if (!B.beat || entry < B.audibleStart + 0.05) return 0;
    const beat = B.beat.period, rate = B.curves.rate;
    const level2 = (a, b) => {
      const lo = Math.max(0, Math.floor(a * rate)), hi = Math.min(B.curves.rmsDb.length, Math.ceil(b * rate));
      const lin = linearPower(B.curves.rmsDb);
      let s = 0;
      for (let i = lo; i < hi; i++) s += lin[i];
      return hi > lo ? 10 * Math.log10(Math.max(1e-12, s / (hi - lo))) : -90;
    };
    const last = level2(entry - beat, entry - 0.02), before = level2(entry - 2 * beat, entry - beat);
    return last >= B.bodyRmsDb - 12 && last >= before + 3 ? 1 : 0;
  }
  function localKey(an, t) {
    var _a;
    const l = an.local;
    if (!l || !(l.rate > 0)) return "";
    const i = Math.floor(t * l.rate);
    return i >= 0 && i < l.camelot.length && ((_a = l.keyConfidence[i]) != null ? _a : 0) >= 0.3 ? l.camelot[i] : "";
  }
  function localClashFraction(A, aStart, aLen, B, bStart, bLen) {
    if (!A.local || !B.local) return 0;
    let clash = 0;
    for (let i = 0; i < 8; i++) {
      const x = (i + 0.5) / 8, ka = localKey(A, aStart + x * aLen), kb = localKey(B, bStart + x * bLen);
      if (ka && kb && camelotCompatibility(ka, kb).score < 0.5) clash++;
    }
    return clash / 8;
  }
  function tonalClashSeconds(p, A, B) {
    var _a;
    if (!A.local || !B.local) return 0;
    let s = 0;
    for (let t = 0.25; t < p.duration; t += 0.5) {
      const tb = t - ((_a = p.bDelay) != null ? _a : 0);
      if (tb < 0) continue;
      const ka = localKey(A, p.aExit + integrateTempo(p.tempoA, t)), kb = localKey(B, p.bEntry + integrateTempo(p.tempoB, tb));
      if (!ka || !kb || camelotCompatibility(ka, kb).score >= 0.5) continue;
      if (laneValue(p, "A", "gain", t) * laneValue(p, "A", "mid", t) >= 0.5 && laneValue(p, "B", "gain", tb) * laneValue(p, "B", "mid", tb) >= 0.5) s += 0.5;
    }
    return s;
  }
  var bodies = /* @__PURE__ */ new WeakMap();
  function bodyDensity(an) {
    let v = bodies.get(an);
    if (v === void 0) {
      const c = an.curves, x = c.midDensity.slice(Math.floor(an.audibleStart * c.rate), Math.ceil(an.audibleEnd * c.rate)).sort((a, b) => a - b);
      v = x.length ? x[x.length >> 1] : 1;
      bodies.set(an, v);
    }
    return v;
  }
  var meanDensity = (an, a, b) => {
    const c = an.curves, lo = Math.max(0, Math.floor(a * c.rate)), hi = Math.min(c.midDensity.length, Math.ceil(b * c.rate));
    let x = 0;
    for (let i = lo; i < hi; i++) x += c.midDensity[i];
    return hi > lo ? x / (hi - lo) : 0;
  };
  var density = (an, src) => {
    const c = an.curves, i = Math.round(src * c.rate);
    return i >= 0 && i < c.midDensity.length ? c.midDensity[i] : 0;
  };
  function leadRiskSeconds(p, A, B) {
    var _a;
    let s = 0;
    for (let t = 0.25; t < p.duration; t += 0.5) {
      const tb = t - ((_a = p.bDelay) != null ? _a : 0);
      if (tb < 0) continue;
      const ma = laneValue(p, "A", "gain", t) * laneValue(p, "A", "mid", t), mb = laneValue(p, "B", "gain", tb) * laneValue(p, "B", "mid", tb);
      if (ma < 0.5 || mb < 0.5) continue;
      if (density(A, p.aExit + integrateTempo(p.tempoA, t)) >= bodyDensity(A) && density(B, p.bEntry + integrateTempo(p.tempoB, tb)) >= bodyDensity(B)) s += 0.5;
    }
    return s;
  }
  function fullMixCost(p, A, B, s) {
    var _a, _b;
    const D = p.duration;
    if (!(D > 0.5)) return null;
    const power = (an, a, b, curve = an.curves.rmsDb) => {
      const lo = Math.max(0, Math.floor(a * an.curves.rate)), hi = Math.min(curve.length, Math.ceil(b * an.curves.rate));
      const lin = linearPower(curve);
      let x = 0;
      for (let i = lo; i < hi; i++) x += lin[i];
      return hi > lo ? 10 * Math.log10(Math.max(1e-12, x / (hi - lo))) : -90;
    };
    const before = Math.max(power(A, Math.max(A.audibleStart, p.aExit - 6), Math.max(A.audibleStart + 0.1, p.aExit - 1)), A.bodyRmsDb - 2) + p.gainA;
    const endB = p.bEntry + integrateTempo(p.tempoB, D - ((_a = p.bDelay) != null ? _a : 0));
    const after = power(B, endB, Math.min(B.audibleEnd, endB + 4)) + p.gainB;
    const bodyLowA = power(A, A.audibleStart, A.audibleEnd, A.curves.lowDb), bodyLowB = power(B, B.audibleStart, B.audibleEnd, B.curves.lowDb);
    let hole = 0, unsupported = 0, jump = 0, doubleBass = 0, prev = null;
    for (let t = 0.25; t < D; t += 0.5) {
      const a = deckPower(p, A, "A", t), b = deckPower(p, B, "B", t);
      if (!a || !b) return null;
      const level2 = 10 * Math.log10(Math.max(1e-12, a.total + b.total));
      const target = before + (after - before) * (t / D);
      hole = Math.max(hole, target - level2 - 3);
      if (prev !== null) jump = Math.max(jump, Math.abs(level2 - prev) - 4);
      prev = level2;
      const srcA = p.aExit + integrateTempo(p.tempoA, t), tb = t - ((_b = p.bDelay) != null ? _b : 0);
      const srcB = tb < 0 ? -1 : p.bEntry + integrateTempo(p.tempoB, tb);
      if (power(A, srcA - 0.5, srcA + 0.5) < before - p.gainA - 12 && (srcB < 0 || power(B, srcB - 0.5, srcB + 0.5) < after - p.gainB - 8)) unsupported += 0.5;
      const lowA = 10 * Math.log10(Math.max(1e-12, a.low)) - p.gainA, lowB = 10 * Math.log10(Math.max(1e-12, b.low)) - p.gainB;
      if (lowA >= bodyLowA - 4 && lowB >= bodyLowB - 4) doubleBass += 0.5;
    }
    const exit = effectiveExit(p, A);
    const closureMiss = A.structure ? 1 - closureAt(A.structure, exit.source) : 0.5;
    const rest = Math.max(0, A.audibleEnd - exit.source);
    const restDensity = rest > 0 ? density(A, (exit.source + A.audibleEnd) / 2) : 0;
    const cutA = rest <= 2 ? 0 : clamp2(rest / (restDensity < 0.18 ? 45 : 14));
    const unknownB = voiceUnknown(B, s), skipped = Math.max(0, p.bEntry - B.audibleStart);
    const skippedDensity = skipped > 5 ? meanDensity(B, B.audibleStart, p.bEntry) / bodyDensity(B) : 0;
    const skippedUnknownB = unknownB && skipped > 5 ? (skipped - 5) * clamp2((skippedDensity - 0.7) / 0.3) : 0;
    const pickup = pickupLost(B, p.bEntry), leadRisk = leadRiskSeconds(p, A, B), tonalClash = tonalClashSeconds(p, A, B);
    const total = 0.25 * closureMiss + 0.2 * cutA + 0.15 * pickup + 0.05 * Math.max(0, hole) + 0.1 * unsupported + 0.03 * Math.max(0, jump) + 0.3 * doubleBass / D + 0.3 * leadRisk / D + 0.2 * tonalClash / D + 5e-3 * skippedUnknownB + 0.15 * clamp2((10 - D) / 10);
    if (!Number.isFinite(total)) return null;
    return {
      total: r3(total),
      closureMiss: r3(closureMiss),
      cutA: r3(cutA),
      pickup,
      holeDb: r3(Math.max(0, hole)),
      unsupported,
      jumpDb: r3(Math.max(0, jump)),
      doubleBass,
      leadRisk,
      tonalClash,
      skippedUnknownB: r3(skippedUnknownB)
    };
  }

  // packages/core/src/plan/micro-onset.ts
  var median = (xs) => {
    const a = [...xs].sort((x, y) => x - y), i = Math.floor(a.length / 2);
    return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
  };
  var trusted = (b) => {
    var _a;
    return !!b && b.stable && b.confidence >= 0.85 && b.jitterMs <= 8 && b.downbeatConfidence >= 0.7 && ((_a = b.attacks) == null ? void 0 : _a.version) === "lf-attack-1" && b.attacks.offsetsMs.length === b.beats.length && b.attacks.strength.length === b.beats.length;
  };
  function withMicroOnset(p, A, B, s, requestedAt) {
    var _a, _b, _c, _d, _e;
    if (!s.enabled || requestedAt !== void 0 || p.debug.requested === true || p.debug.processingAllowed === false || p.debug.microOnset || p.debug.firstWords || p.method !== "beatmatch_blend" || !p.beatAlign || p.beatAlign.regions || p.loopA || p.tapeStopA || p.voiceEcho || p.duration < 3 || !A || !B || !trusted(A.beat) || !trusted(B.beat) || ((_b = (_a = A.structure) == null ? void 0 : _a.gridCheck) == null ? void 0 : _b.periodHint) || ((_d = (_c = B.structure) == null ? void 0 : _c.gridCheck) == null ? void 0 : _d.periodHint)) return p;
    const ga = A.beat, gb = B.beat;
    const full = voiceUnknown(A, s) || voiceUnknown(B, s);
    for (const [an, cue] of [[A, p.aExit], [B, p.bEntry]]) {
      const voice = cue < an.audibleStart + 0.025 ? 0 : firstVoice(an, cue - 0.025, cue + 0.18);
      if (voice !== Infinity && !(full && voice === null)) return p;
    }
    const shifts = [], until = Math.min(p.duration, 6);
    let previous = -1;
    for (let i = 0; i < ga.beats.length && shifts.length < 8; i++) {
      const ta = ga.beats[i];
      if (ta < p.aExit - 1e-3) continue;
      if (ta > p.aExit + integrateTempo(p.tempoA, until)) break;
      const t = outputTimeAt(p.tempoA, ta - p.aExit, until), predicted = p.bEntry + integrateTempo(p.tempoB, t);
      let j = -1, distance = 0.018;
      for (let k = Math.max(0, previous + 1); k < gb.beats.length; k++) {
        const d = Math.abs(gb.beats[k] - predicted);
        if (d < distance) {
          distance = d;
          j = k;
        }
        if (gb.beats[k] > predicted + 0.018) break;
      }
      if (j < 0) continue;
      const oa = ga.attacks.offsetsMs[i], ob = gb.attacks.offsetsMs[j], sa = ga.attacks.strength[i], sb = gb.attacks.strength[j];
      if (oa === null || ob === null || !Number.isFinite(oa) || !Number.isFinite(ob) || Math.abs(oa) > 25 || Math.abs(ob) > 25 || !Number.isFinite(sa) || !Number.isFinite(sb) || sa < 0.7 || sb < 0.7 || sa > 1 || sb > 1) continue;
      previous = j;
      const ra = pointValue((_e = p.tempoA) != null ? _e : [[0, 1]], t), rb = pointValue(p.tempoB, t);
      if (!Number.isFinite(ra) || !Number.isFinite(rb) || ra < 0.8 || ra > 1.2 || rb < 0.8 || rb > 1.2) return p;
      shifts.push(gb.beats[j] - predicted + ob / 1e3 - oa / 1e3 * rb / ra);
    }
    if (shifts.length < (full ? 6 : 4)) return p;
    const shift = median(shifts), residual = Math.max(...shifts.map((x) => Math.abs(x - shift)));
    if (Math.abs(shift) < 2e-3 || Math.abs(shift) > 0.015 || residual > (full ? 2e-3 : 3e-3)) return p;
    const entry = Math.round((p.bEntry + shift) * 1e6) / 1e6;
    if (entry < B.audibleStart || entry + integrateTempo(p.tempoB, p.duration) > B.audibleEnd) return p;
    return {
      ...p,
      id: `${p.id}_onset_${Math.round(shift * 1e6)}`,
      bEntry: entry,
      entrySelection: p.entrySelection ? { ...p.entrySelection, skippedSeconds: Math.max(0, p.entrySelection.skippedSeconds + shift) } : void 0,
      reasons: [...p.reasons, `\u0430\u0442\u0430\u043A\u0438 \u0431\u043E\u0447\u043A\u0438 \u0443\u0442\u043E\u0447\u043D\u0435\u043D\u044B \u043F\u043E ${shifts.length} \u0438\u0437\u043C\u0435\u0440\u0435\u043D\u043D\u044B\u043C \u0434\u043E\u043B\u044F\u043C: ${Math.round(shift * 1e3)} \u043C\u0441`],
      debug: { ...p.debug, microOnset: { policy: full ? "lf-attack-fullmix-1" : "lf-attack-1", shiftMs: Math.round(shift * 1e6) / 1e3, pairs: shifts.length, residualMs: Math.round(residual * 1e6) / 1e3 } }
    };
  }

  // packages/core/src/plan/answer.ts
  function withVoiceAnswer(p, A, B, s, requestedAt) {
    var _a, _b, _c, _d;
    if (!s.enabled || s.djPhrasing === false || s.stemMixing === false || !s.eqHandoff || requestedAt !== void 0 || !A || !B || p.debug.processingAllowed === false || p.loopA || p.tapeStopA || p.echo || !p.vocalA || !p.vocalB || p.duration < 4 || !["crossfade", "beatmatch_blend"].includes(p.method)) return p;
    const end = (_a = p.vocalA.find(([t, g]) => t > 0 && g <= 1e-3)) == null ? void 0 : _a[0];
    const first = firstVoice(B, p.bEntry, p.bEntry + integrateTempo(p.tempoB, p.duration));
    if (end === void 0 || end < 0.5 || first === null || !Number.isFinite(first)) return p;
    const attack = outputTimeAt(p.tempoB, first - p.bEntry, p.duration), clear = attack - 0.15;
    let delay = ((_c = (_b = A.beat) == null ? void 0 : _b.period) != null ? _c : 0.5) / pointValue((_d = p.tempoA) != null ? _d : [[0, 1]], end);
    if (!Number.isFinite(delay) || delay <= 0) return p;
    while (delay < 0.3) delay *= 2;
    while (delay > 0.8) delay /= 2;
    if (clear - end < delay * 2 || pointValue(p.vocalB, attack) < 0.999) return p;
    const last = firstVoice(A, p.aExit + integrateTempo(p.tempoA, Math.max(0, end - 0.5)), p.aExit + integrateTempo(p.tempoA, end));
    if (last === null || !Number.isFinite(last)) return p;
    const from = Math.max(0, end - Math.min(delay, 0.5)), level2 = 0.2;
    return {
      ...p,
      voiceEcho: { delay, feedback: 0.22, clearAt: clear },
      automation: [
        ...p.automation.filter((l) => l.lane !== "voiceEcho"),
        { deck: "A", lane: "voiceEcho", points: [[0, 0], [from, 0], [Math.min(end, from + 0.04), level2], [end, level2], [end + 0.03, 0], [p.duration, 0]] }
      ],
      reasons: [...p.reasons, "\u0432\u043E\u043A\u0430\u043B\u044C\u043D\u043E\u0435 \u044D\u0445\u043E \u043E\u0442\u0432\u0435\u0447\u0430\u0435\u0442 \u0432 \u0438\u0437\u043C\u0435\u0440\u0435\u043D\u043D\u043E\u0439 \u043F\u0430\u0443\u0437\u0435 \u0438 \u043F\u043E\u043B\u043D\u043E\u0441\u0442\u044C\u044E \u0437\u0430\u043A\u0440\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u043F\u0435\u0440\u0435\u0434 \u043D\u043E\u0432\u043E\u0439 \u0444\u0440\u0430\u0437\u043E\u0439"],
      debug: { ...p.debug, voiceAnswer: { policy: "measured-gap-1", from, end, clearAt: clear, attack, delay } }
    };
  }

  // packages/core/src/plan/harmonic.ts
  function withHarmonicHandoff(p, A, B, s, requestedAt) {
    var _a, _b;
    if (!s.enabled || !s.eqHandoff || s.djPhrasing === false || requestedAt !== void 0 || !A || !B || p.loopA || p.debug.processingAllowed === false || p.duration < 3 || !["crossfade", "beatmatch_blend"].includes(p.method) || !(((_a = A.key) == null ? void 0 : _a.confidence) >= 0.75) || !(((_b = B.key) == null ? void 0 : _b.confidence) >= 0.75) || !p.keyInfo || p.keyInfo.compatibility >= 0.3) return p;
    const at = (deck, lane2, t) => {
      var _a2, _b2;
      return pointValue((_b2 = (_a2 = p.automation.find((l) => l.deck === deck && l.lane === lane2)) == null ? void 0 : _a2.points) != null ? _b2 : [[0, 1]], t);
    };
    const mid = p.automation.find((l) => l.deck === "A" && l.lane === "mid");
    if (!mid) return p;
    const points = [];
    for (const t of [.../* @__PURE__ */ new Set([...mid.points.map(([t2]) => t2), ...Array.from({ length: 17 }, (_, i) => p.duration * i / 16)])].sort((a, b) => a - b)) {
      const sourceA = p.aExit + integrateTempo(p.tempoA, t), sourceB = p.bEntry + integrateTempo(p.tempoB, t);
      const read = (an, c, time) => c[Math.floor(time * an.curves.rate)];
      const a = read(A, A.curves.rmsDb, sourceA), b = read(B, B.curves.rmsDb, sourceB), m = read(A, A.curves.midDb, sourceA);
      if (![a, b, m].every(Number.isFinite)) return p;
      const gA = at("A", "gain", t), gB = at("B", "gain", t), old = at("A", "mid", t);
      const total = 10 ** ((a + p.gainA) / 10) * gA * gA + 10 ** ((b + p.gainB) / 10) * gB * gB;
      const midPower = 10 ** ((m + p.gainA) / 10) * gA * gA;
      const budget = total * (1 - 10 ** (-1 / 10));
      const floor = midPower > 0 ? Math.sqrt(Math.max(0, old * old - budget / midPower)) : old;
      const depth = Math.sin(Math.PI * t / p.duration) ** 2;
      points.push([t, Math.min(old, Math.max(floor, old * 10 ** (-1 / 20), old * (1 - 0.35 * depth)))]);
    }
    return {
      ...p,
      automation: p.automation.map((l) => l === mid ? { ...l, points } : l),
      reasons: [...p.reasons, "\u043A\u043E\u043D\u0444\u043B\u0438\u043A\u0442\u0443\u044E\u0449\u0438\u0435 \u0442\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0435 \u0441\u0435\u0440\u0435\u0434\u0438\u043D\u044B \u0440\u0430\u0441\u0445\u043E\u0434\u044F\u0442\u0441\u044F \u043C\u044F\u0433\u0447\u0435; \u0431\u0430\u0441 \u0438 \u043D\u043E\u0432\u044B\u0439 \u0433\u043E\u043B\u043E\u0441 \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u044E\u0442\u0441\u044F"],
      debug: { ...p.debug, harmonicHandoff: { policy: "measured-mid-1", maxAdditionalMidAttenuationDb: 1 } }
    };
  }

  // packages/core/src/plan/tape-stop.ts
  function withTapeStop(p, A, B, s, requestedAt) {
    var _a, _b, _c, _d, _e;
    if (!s.enabled || !s.eqHandoff || s.loopBridges === false || s.djPhrasing === false || s.style !== "auto" || requestedAt !== void 0 || !A || !B || p.debug.processingAllowed === false || p.debug.firstWords || p.method !== "crossfade" || p.duration < 4 || p.duration > 10 || p.loopA || p.echo || p.voiceEcho || ((_a = p.tempoA) == null ? void 0 : _a.some(([, v2]) => Math.abs(v2 - 1) > 1e-5)) || p.tempoB.some(([, v2]) => Math.abs(v2 - 1) > 1e-5) || !((_b = A.beat) == null ? void 0 : _b.stable) || !((_c = B.beat) == null ? void 0 : _c.stable) || A.beat.confidence < 0.85 || B.beat.confidence < 0.85 || A.beat.jitterMs > 8 || B.beat.jitterMs > 8 || Math.abs(A.beat.bpm / B.beat.bpm - 1) < 0.15) return p;
    const start = A.beat.downbeats.find((t) => t >= p.aExit + 0.5 && t <= p.aExit + Math.min(2, p.duration * 0.4));
    if (start === void 0) return p;
    const v = A.vocalActivity, end = start + Math.max(0.3, Math.min(0.9, A.beat.period * 1.5));
    if (!(v == null ? void 0 : v.vocalRmsDb) || !v.accompanimentRmsDb || !(v.rate > 0) || end > A.audibleEnd - 0.01 || end > p.aExit + p.duration) return p;
    const lo = Math.floor((start - 0.05) * v.rate), hi = Math.ceil(A.audibleEnd * v.rate);
    if (lo < 0 || hi > v.vocalRmsDb.length || hi > v.accompanimentRmsDb.length) return p;
    for (let i = lo; i < hi; i++) if (!Number.isFinite(v.vocalRmsDb[i]) || !Number.isFinite(v.accompanimentRmsDb[i]) || v.vocalRmsDb[i] + p.gainA > -42 || v.vocalRmsDb[i] > v.accompanimentRmsDb[i] - 25) return p;
    const from = start - p.aExit, until = end - p.aExit, D = p.duration;
    for (const name of ["gain", "low", "mid", "high", "filter"]) {
      const points = (_e = (_d = p.automation.find((l) => l.deck === "B" && l.lane === name)) == null ? void 0 : _d.points) != null ? _e : [[0, name === "filter" ? 0 : 1]];
      for (const t of [until, D, ...points.filter(([t2]) => t2 > until && t2 < D).map(([t2]) => t2)]) {
        const value = pointValue(points, t);
        if (!Number.isFinite(value) || (name === "filter" ? Math.abs(value) > 1e-3 : value < (name === "gain" ? 0.95 : 0.9))) return p;
      }
    }
    const automation = p.automation.map((l) => {
      if (l.deck !== "A" || l.lane !== "gain") return l;
      return { ...l, points: [...l.points.filter(([t]) => t < from), [from, pointValue(l.points, from)], [until, 0], [D, 0]] };
    });
    return {
      ...p,
      tapeStopA: { start, end, crossfade: 0.025 },
      automation,
      reasons: [...p.reasons, "\u043A\u043E\u0440\u043E\u0442\u043A\u0430\u044F \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430 \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430\u043B\u044C\u043D\u043E\u0433\u043E \u0444\u0438\u043D\u0430\u043B\u0430 \u0441 \u043F\u043E\u043D\u0438\u0436\u0435\u043D\u0438\u0435\u043C \u0442\u043E\u043D\u0430 \u043F\u0435\u0440\u0435\u0434 \u0441\u043C\u0435\u043D\u043E\u0439 \u0442\u0435\u043C\u043F\u0430"],
      debug: { ...p.debug, tapeStop: { policy: "quiet-tail-1", start, end } }
    };
  }

  // packages/core/src/plan/unlocked.ts
  var r4 = (x) => Math.round(x * 1e3) / 1e3;
  var ECHO_OUT_MIN_STRETCH = 25;
  var SUNG = 0.28;
  function level(an, c, a, b) {
    const rate = an.curves.rate, lo = Math.floor(a * rate), hi = Math.ceil(b * rate);
    if (!(rate > 0) || lo < 0 || hi > c.length || hi <= lo) return NaN;
    let p = 0;
    for (let i = lo; i < hi; i++) {
      if (!Number.isFinite(c[i])) return NaN;
      p += 10 ** (c[i] / 10);
    }
    return 10 * Math.log10(Math.max(1e-12, p / (hi - lo)));
  }
  function voiceKnown(an, a, b) {
    const v = an.vocalActivity;
    if (!v || !(v.rate > 0) || a < 0 || Math.ceil(b * v.rate) > v.values.length) return false;
    for (let i = Math.floor(a * v.rate); i < Math.ceil(b * v.rate); i++) if (!Number.isFinite(v.values[i])) return false;
    return true;
  }
  var sung = (an, t) => vocalMean(an, t - 0.05, t + 0.05) >= SUNG;
  function quietFor(an, from, to) {
    for (let t = from; t < to; t += 0.25) if (level(an, an.curves.rmsDb, t, t + 0.5) >= an.bodyRmsDb - 12) return t - from;
    return to - from;
  }
  function quietBefore(an, to) {
    for (let t = to - 0.5; t >= to - 8; t -= 0.25) if (level(an, an.curves.rmsDb, t, t + 0.5) >= an.bodyRmsDb - 12) return to - t - 0.5;
    return 8;
  }
  function planEchoOut(base, A, B, s, stretchPercent) {
    var _a, _b, _c, _d;
    const ga = A.beat, gb = B.beat;
    if (stretchPercent < ECHO_OUT_MIN_STRETCH || !ga || !gb || !ga.stable || !gb.stable || ga.confidence < 0.6 || gb.confidence < 0.45 || ga.downbeatConfidence < 0.3 || A.rhythmStrength <= 0.45 || B.rhythmStrength <= 0.45 || !A.vocalActivity || !B.vocalActivity) return null;
    const beat = ga.period, bar = 4 * beat, need = Math.max(bar, 2);
    const skip = s.entryMode === "preserve" ? 0 : Math.min((_a = s.maxEntrySkipSeconds) != null ? _a : 45, (B.audibleEnd - B.audibleStart) * 0.45);
    const look = Math.min(B.audibleEnd, B.audibleStart + skip + 12);
    if (!voiceKnown(B, B.audibleStart, look)) return null;
    let voiceB = Infinity;
    for (let t = B.audibleStart; t < look; t += 0.02) if (sung(B, t)) {
      voiceB = t;
      break;
    }
    const entries = [B.audibleStart, ...gb.downbeats.filter((t) => t > B.audibleStart && t <= B.audibleStart + skip && t <= voiceB - 0.15)].map((entry) => ({ entry, lead: voiceB - entry, quiet: quietFor(B, entry, entry + 8) })).filter((e) => e.quiet < 8);
    const options = [];
    for (const d of ga.downbeats) {
      if (d < Math.max(A.audibleStart + 30, A.audibleEnd - 40) || d > A.audibleEnd - 0.5) continue;
      const start = d - bar;
      if (!voiceKnown(A, start - 10, A.audibleEnd) || Number.isNaN(level(A, A.curves.rmsDb, start, d)) || vocalMean(A, d - 0.1, d + 0.25) >= 0.18) continue;
      const lostA = vocalMean(A, d, A.audibleEnd) * (A.audibleEnd - d);
      if (lostA > 3) continue;
      let lastA = -Infinity;
      for (let t = d; t >= start - 10; t -= 0.02) if (sung(A, t)) {
        lastA = t - start;
        break;
      }
      const quietA = quietBefore(A, d);
      for (const e of entries) {
        const bDelay = Math.max(bar + beat, lastA + need - e.lead);
        if (bDelay > 2 * bar + 1e-6) continue;
        const valley = quietA + (bDelay - bar) + e.quiet;
        if (valley > 5) continue;
        options.push({ cost: lostA + 0.03 * (A.audibleEnd - d) + 0.3 * valley, d, lastA, lostA, entry: e.entry, lead: e.lead, bDelay, valley });
      }
    }
    options.sort((x, y) => x.cost - y.cost);
    for (const best of options.slice(0, 8)) {
      const p = build(best);
      const h = applyVocalHandoff(p, A, B, s), shift = (_b = p.bDelay) != null ? _b : 0;
      let ok = true;
      for (let t = 0; t < bar && ok; t += 0.05) if (sung(A, p.aExit + t) && pointValue((_c = h.vocalA) != null ? _c : [[0, 1]], t) < 0.5) ok = false;
      for (let t = 0; t < p.duration - shift && ok; t += 0.05)
        if (pointValue(p.automation[3].points, t) > 0.5 && sung(B, p.bEntry + t) && pointValue((_d = h.vocalB) != null ? _d : [[0, 1]], t) < 0.5) ok = false;
      if (ok) return p;
    }
    return tailSegue();
    function tailSegue() {
      var _a2;
      const from = Math.max(A.audibleStart, A.audibleEnd - 40);
      if (!voiceKnown(A, from, A.audibleEnd)) return null;
      let lastA = -Infinity, quiet = A.audibleEnd;
      for (let t = A.audibleEnd; t >= from; t -= 0.02) if (sung(A, t)) {
        lastA = t;
        break;
      }
      const bodyLow = level(A, A.curves.lowDb, A.audibleStart, A.audibleEnd);
      for (let t = A.audibleEnd - 0.5; t >= from && level(A, A.curves.rmsDb, t, t + 0.5) < A.bodyRmsDb - 6 && level(A, A.curves.lowDb, t, t + 0.5) < bodyLow - 15; t -= 0.25) quiet = t;
      const bEntry = Math.max(0, B.audibleStart - 0.5), lead = voiceB - bEntry;
      const aExit = Math.max(quiet, lastA + 0.3, lastA + need - lead), fade = Math.min(bar, A.audibleEnd - aExit);
      if (aExit > A.audibleEnd - 1.5 || aExit - Math.max(quiet, lastA) > 4 || quietFor(B, bEntry, bEntry + 8) > 4) return null;
      const D = r4(Math.max(6, fade + 2));
      const p = {
        ...base,
        aExit: r4(aExit),
        bEntry: r4(bEntry),
        duration: D,
        swapAt: 0,
        tempoB: [[0, 1]],
        echo: { delay: r4(echoDelay()), feedback: 0.55 },
        automation: [
          { deck: "A", lane: "gain", points: [[0, 1], [r4(fade / 2), 0.7], [r4(fade), 0], [D, 0]] },
          { deck: "A", lane: "echo", points: [[0, 0.5], [r4(fade), 0.5], [r4(fade + 0.02), 0], [D, 0]] },
          { deck: "B", lane: "gain", points: [[0, 0], [0.02, 1], [D, 1]] }
        ],
        confidence: r4(Math.min(0.6, ga.confidence, gb.confidence)),
        reasons: [
          `\u044D\u0445\u043E-\u0432\u044B\u0445\u043E\u0434: \u0442\u0435\u043C\u043F\u044B ${ga.bpm.toFixed(0)} \u0438 ${gb.bpm.toFixed(0)} BPM \u043D\u0435 \u0441\u0432\u043E\u0434\u044F\u0442\u0441\u044F \u043F\u043E \u0431\u0438\u0442\u0430\u043C \u2014 \u0442\u0435\u043A\u0443\u0449\u0438\u0439 \u0442\u0440\u0435\u043A \u0434\u043E\u043F\u0435\u0432\u0430\u0435\u0442 \u0438 \u0443\u0445\u043E\u0434\u0438\u0442 \u0441\u0432\u043E\u0438\u043C \u0442\u0438\u0445\u0438\u043C \u043E\u043A\u043E\u043D\u0447\u0430\u043D\u0438\u0435\u043C \u0432 \u044D\u0445\u043E, \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u043D\u0430\u0447\u0438\u043D\u0430\u0435\u0442\u0441\u044F \u0441 \u043D\u0430\u0447\u0430\u043B\u0430 \u043F\u043E\u0432\u0435\u0440\u0445 \u043D\u0435\u0433\u043E`,
          "\u0440\u0438\u0442\u043C\u044B \u0434\u0432\u0443\u0445 \u0442\u0440\u0435\u043A\u043E\u0432 \u043D\u0435 \u0437\u0432\u0443\u0447\u0430\u0442 \u043E\u0434\u043D\u043E\u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E; \u043C\u0435\u0436\u0434\u0443 \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0435\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439 \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0438 \u043F\u0435\u0440\u0432\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u2014 \u043D\u0435 \u043C\u0435\u043D\u044C\u0448\u0435 \u0442\u0430\u043A\u0442\u0430 \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430\u043B\u0430"
        ],
        debug: { ...base.debug, variant: "echo-tail", echoOut: { quietFrom: r4(quiet), lastVoiceA: r4(lastA), voiceLeadB: r4(lead), voiceGap: r4(aExit + lead - lastA) } }
      };
      const h = applyVocalHandoff(p, A, B, s);
      for (let t = 0; t < D; t += 0.05) if (sung(B, bEntry + t) && pointValue((_a2 = h.vocalB) != null ? _a2 : [[0, 1]], t) < 0.5) return null;
      return p;
    }
    function echoDelay() {
      let delay = beat;
      while (delay < 0.3) delay *= 2;
      while (delay > 0.8) delay /= 2;
      return delay;
    }
    function build(best) {
      const cut = r4(bar), start = r4(best.bDelay), D = r4(Math.max(6, start + 1, cut + 2 * bar));
      const preroll = best.entry - start >= 0;
      return {
        ...base,
        aExit: r4(best.d - bar),
        bEntry: r4(preroll ? best.entry - start : best.entry),
        duration: D,
        swapAt: cut,
        tempoB: [[0, 1]],
        ...preroll ? {} : { bDelay: start },
        echo: { delay: r4(echoDelay()), feedback: 0.55 },
        automation: [
          { deck: "A", lane: "gain", points: [[0, 1], [r4(cut - 0.03), 1], [cut, 0], [D, 0]] },
          // the echo repeats A's last beat without its bass (808 tails would boom under B)
          { deck: "A", lane: "low", points: [[0, 1], [r4(cut - beat), 1], [r4(cut - 0.05), 0], [D, 0]] },
          // pre-fader send: closed at the cut so A's music after it never feeds the echo
          { deck: "A", lane: "echo", points: [[0, 0], [r4(cut - 2 * beat), 0], [r4(cut - beat), 0.7], [cut, 0.7], [r4(cut + 0.02), 0], [D, 0]] },
          { deck: "B", lane: "gain", points: preroll ? [[0, 0], [start, 0], [r4(start + 0.02), 1], [D, 1]] : [[0, 0], [0.02, 1], [r4(D - start), 1]] }
        ],
        confidence: r4(Math.min(0.7, ga.confidence, gb.confidence)),
        reasons: [
          `\u044D\u0445\u043E-\u0432\u044B\u0445\u043E\u0434: \u0442\u0435\u043C\u043F\u044B ${ga.bpm.toFixed(0)} \u0438 ${gb.bpm.toFixed(0)} BPM \u043D\u0435 \u0441\u0432\u043E\u0434\u044F\u0442\u0441\u044F \u043F\u043E \u0431\u0438\u0442\u0430\u043C \u2014 \u0442\u0435\u043A\u0443\u0449\u0438\u0439 \u0442\u0440\u0435\u043A \u0437\u0430\u043A\u0430\u043D\u0447\u0438\u0432\u0430\u0435\u0442 \u0444\u0440\u0430\u0437\u0443, \u0435\u0433\u043E \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0439 \u0442\u0430\u043A\u0442 \u0443\u0445\u043E\u0434\u0438\u0442 \u0432 \u044D\u0445\u043E, \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u0432\u0445\u043E\u0434\u0438\u0442 \u0441\u043E \u0441\u0432\u043E\u0435\u0439 \u0441\u0438\u043B\u044C\u043D\u043E\u0439 \u0434\u043E\u043B\u0438 \u043F\u043E\u0434 \u0445\u0432\u043E\u0441\u0442 \u044D\u0445\u0430`,
          "\u0440\u0438\u0442\u043C\u044B \u0434\u0432\u0443\u0445 \u0442\u0440\u0435\u043A\u043E\u0432 \u043D\u0435 \u0437\u0432\u0443\u0447\u0430\u0442 \u043E\u0434\u043D\u043E\u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E; \u043C\u0435\u0436\u0434\u0443 \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0435\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439 \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0438 \u043F\u0435\u0440\u0432\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u2014 \u043D\u0435 \u043C\u0435\u043D\u044C\u0448\u0435 \u0442\u0430\u043A\u0442\u0430 \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430\u043B\u0430"
        ],
        debug: { ...base.debug, variant: "echo-out", echoOut: {
          cutSource: r4(best.d),
          bStartsAt: start,
          bSource: r4(best.entry),
          preroll,
          lastVoiceA: r4(best.lastA),
          voiceLeadB: r4(best.lead),
          voiceGap: r4(start + best.lead - best.lastA),
          lostA: r4(best.lostA),
          valley: r4(best.valley),
          cost: r4(best.cost)
        } }
      };
    }
  }

  // packages/core/src/plan/feedback.ts
  var PRIOR = 8;
  var WEIGHT = 0.8;
  var CAP = 0.15;
  var FEATURE_COUNT = 5;
  var bucket = (x, edges, names) => {
    var _a;
    return (_a = names[edges.findIndex((e) => x < e)]) != null ? _a : names[names.length - 1];
  };
  function ratingFeatures(plan, A, B) {
    var _a, _b;
    const m = plan.method;
    const stretch = (_b = (_a = plan.beatAlign) == null ? void 0 : _a.stretchPercent) != null ? _b : (A == null ? void 0 : A.beat) && (B == null ? void 0 : B.beat) ? tempoRelation(A.beat.bpm, B.beat.bpm).stretchPercent : null;
    const out = [`method:${m}`];
    if (stretch !== null && Number.isFinite(stretch)) out.push(`bpm:${m}:${bucket(stretch, [2, 5, 8, 12], ["<2", "2-5", "5-8", "8-12", "12+"])}`);
    if (plan.keyInfo) out.push(`key:${m}:${bucket(plan.keyInfo.compatibility, [0.5, 0.8], ["low", "mid", "high"])}`);
    out.push(`length:${bucket(plan.duration, [4, 10, 20], ["<4", "4-10", "10-20", "20+"])}`);
    out.push(`vocals:${plan.vocalA || plan.vocalB ? "masked" : "none"}`);
    return out;
  }
  function ratingBias(stats, plan, A, B) {
    const used = {};
    let sum = 0;
    for (const f of ratingFeatures(plan, A, B)) {
      const c = stats.features[f];
      if (!c) continue;
      const dev = (c.good + PRIOR / 2) / (c.good + c.bad + PRIOR) - 0.5;
      used[f] = Math.round(dev * 1e3) / 1e3;
      sum += dev;
    }
    const bias = Math.max(-CAP, Math.min(CAP, WEIGHT * sum / FEATURE_COUNT));
    return { bias: Math.round(bias * 1e3) / 1e3, features: used };
  }

  // packages/core/src/plan/planner.ts
  var clamp3 = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  var r32 = (x) => Math.round(x * 1e3) / 1e3;
  function fnv1a(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }
  function normalizationGain(an, target) {
    if (!an || target === null) return 0;
    const l = an.loudness;
    if (!Number.isFinite(l.integratedLufs) || l.integratedLufs <= -69) return 0;
    let g = target - l.integratedLufs;
    g = Math.min(g, -1 - l.truePeakDb + 3);
    return r32(clamp3(g, -18, 12));
  }
  function tempoRelation(bpmA, bpmB) {
    const stretch = (ratio) => Math.max(Math.abs(ratio - 1), Math.abs(1 / ratio - 1)) * 100;
    let best = { ratio: bpmA / bpmB, m: 1, stretchPercent: stretch(bpmA / bpmB) };
    for (const m of [0.5, 1, 2]) {
      const ratio = bpmA / (bpmB * m);
      const sp = stretch(ratio);
      if (sp < best.stretchPercent - 1e-9) best = { ratio, m, stretchPercent: sp };
    }
    return best;
  }
  function curveMean(curve, rate, a, b) {
    var _a;
    const i0 = Math.min(curve.length, Math.max(0, Math.floor(a * rate)));
    const i1 = Math.min(curve.length, Math.max(i0 + 1, Math.ceil(b * rate)));
    let s = 0;
    for (let i = i0; i < i1; i++) s += curve[i];
    return i1 > i0 ? s / (i1 - i0) : (_a = curve[curve.length - 1]) != null ? _a : 0;
  }
  function shape(t0, t1, f, n = 8) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const x = i / n;
      pts.push([r32(t0 + (t1 - t0) * x), r32(f(x))]);
    }
    return pts;
  }
  var sinUp = (x) => Math.sin(x * Math.PI / 2);
  var cosDown = (x) => Math.cos(x * Math.PI / 2);
  var smoothstep = (x) => x * x * (3 - 2 * x);
  function lane(deck, l, ...parts) {
    const pts = [];
    for (const p of parts) {
      for (const q of p) {
        const last = pts[pts.length - 1];
        if (last && q[0] < last[0]) continue;
        if (last && q[0] === last[0]) {
          last[1] = q[1];
          continue;
        }
        pts.push([q[0], q[1]]);
      }
    }
    return { deck, lane: l, points: pts };
  }
  function isConsecutiveAlbum(a, b) {
    var _a, _b, _c, _d;
    if (!a.album || !b.album || a.album !== b.album) return false;
    if (((_a = a.albumArtist) != null ? _a : "") !== ((_b = b.albumArtist) != null ? _b : "")) return false;
    if (a.trackNo == null || b.trackNo == null) return false;
    const discA = (_c = a.discNo) != null ? _c : 1;
    const discB = (_d = b.discNo) != null ? _d : 1;
    if (discA === discB) return b.trackNo === a.trackNo + 1;
    return discB === discA + 1 && b.trackNo === 1;
  }
  function basePlan(ctx, method) {
    const featureKey = (an) => {
      var _a, _b, _c, _d, _e, _f;
      return `${an == null ? void 0 : an.version}|${(_b = (_a = an == null ? void 0 : an.vocalActivity) == null ? void 0 : _a.model) != null ? _b : ""}|${(_d = (_c = an == null ? void 0 : an.vocalActivity) == null ? void 0 : _c.version) != null ? _d : ""}|${(_f = (_e = an == null ? void 0 : an.vocalActivity) == null ? void 0 : _e.revision) != null ? _f : ""}`;
    };
    const key = `${ctx.a.id}|${ctx.b.id}|${method}|${featureKey(ctx.a.analysis)}|${featureKey(ctx.b.analysis)}|${JSON.stringify(ctx.s)}`;
    return {
      id: `tp_${fnv1a(key)}_${fnv1a(PLANNER_VERSION + key)}`,
      version: PLANNER_VERSION,
      fromTrackId: ctx.a.id,
      toTrackId: ctx.b.id,
      method,
      confidence: 0,
      reasons: [],
      aExit: 0,
      bEntry: 0,
      duration: 0,
      gap: 0,
      swapAt: 0,
      tempoB: [[0, 1]],
      automation: [],
      gainA: ctx.a.mixingAllowed && ctx.b.mixingAllowed ? ctx.gainA : 0,
      gainB: ctx.a.mixingAllowed && ctx.b.mixingAllowed ? ctx.gainB : 0,
      debug: { processingAllowed: ctx.a.mixingAllowed && ctx.b.mixingAllowed }
    };
  }
  function planSequential(ctx, reason, method = "gapless") {
    const p = basePlan(ctx, method);
    p.aExit = r32(ctx.a.duration);
    p.bEntry = 0;
    p.duration = 0;
    p.swapAt = 0;
    p.confidence = 1;
    p.reasons.push(reason);
    return p;
  }
  function planFallbackCrossfade(ctx, reason) {
    const p = basePlan(ctx, "fallback_crossfade");
    const L = Math.min(ctx.s.fallbackSeconds, ctx.s.maxBlendSeconds, ctx.a.duration * 0.15, ctx.b.duration * 0.35);
    if (L < 0.03) return planSequential(ctx, reason);
    p.aExit = r32(Math.max(0, ctx.a.duration - L));
    p.bEntry = 0;
    p.duration = r32(L);
    p.swapAt = r32(L / 2);
    p.automation = [lane("A", "gain", shape(0, L, cosDown)), lane("B", "gain", shape(0, L, sinUp))];
    p.confidence = 0.3;
    p.fallbackReason = reason;
    p.reasons.push(reason, "\u043C\u044F\u0433\u043A\u0438\u0439 \u043A\u0440\u043E\u0441\u0441\u0444\u0435\u0439\u0434 \u043F\u043E \u0434\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u0438 \u0444\u0430\u0439\u043B\u0430");
    return p;
  }
  function sanitizedSettings(settings) {
    return {
      ...settings,
      maxStretchPercent: clamp3(Number.isFinite(settings.maxStretchPercent) ? settings.maxStretchPercent : 12, 0, 30),
      maxBlendSeconds: clamp3(Number.isFinite(settings.maxBlendSeconds) ? settings.maxBlendSeconds : 32, 0, 60),
      fallbackSeconds: clamp3(Number.isFinite(settings.fallbackSeconds) ? settings.fallbackSeconds : 6, 0, 20),
      entryMode: settings.entryMode === "preserve" ? "preserve" : "smart",
      maxEntrySkipSeconds: clamp3(Number.isFinite(settings.maxEntrySkipSeconds) ? settings.maxEntrySkipSeconds : 45, 0, 75)
    };
  }
  function safePosition(position, duration) {
    return clamp3(Number.isFinite(position) ? position : 0, 0, Math.max(0, duration - 0.01));
  }
  var LOCK_MAX_PERCENT = 8;
  var lockLimit = (s) => Math.min(s.maxStretchPercent, LOCK_MAX_PERCENT);
  var LOCK_LONG_PERCENT = 10;
  var LONG_LOCK_MIN_SECONDS = 12;
  var MIN_LOCK_SECONDS = 10;
  function planTransition(a, b, settings, requestedAt, feedback) {
    return drain(rankPlans(a, b, settings, requestedAt, feedback))[0];
  }
  function* rankPlans(a, b, settings, requestedAt, feedback) {
    const p = finishPlan(buildTransition(a, b, settings, requestedAt), a.analysis, b.analysis, settings, requestedAt);
    const fb = feedback && Object.keys(feedback.features).length ? feedback : void 0;
    if (requestedAt === void 0 && settings.enabled && fullMixPair(a.analysis, b.analysis, settings)) {
      yield;
      return yield* chooseFullMixPlan(p, a, b, settings, fb);
    }
    return [chooseMusicalPlan(p, a, b, settings, requestedAt, fb)];
  }
  function feedbackFor(fb, named, A, B) {
    const bias = /* @__PURE__ */ new Map();
    if (!fb) return { bias: (_) => 0, debug: void 0 };
    const rows = named.map(({ name, plan }) => {
      const r5 = ratingBias(fb, plan, A, B);
      bias.set(plan, r5.bias);
      return { name, bias: r5.bias, features: r5.features };
    });
    return { bias: (q) => {
      var _a;
      return (_a = bias.get(q)) != null ? _a : 0;
    }, debug: { policy: "listener-ratings-1", version: fb.version, candidates: rows } };
  }
  function* chooseFullMixPlan(p, a, b, settings, fb) {
    var _a, _b, _c;
    const A = a.analysis, B = b.analysis, s = sanitizedSettings(settings);
    if (!A || !B || p.debug.processingAllowed === false || !["crossfade", "beatmatch_blend"].includes(p.method) || p.loopA) return [p];
    const build = (alt, fixed) => finishPlan(buildTransition(a, b, alt, void 0, void 0, fixed), A, B, alt);
    const entries = [["baseline", p]];
    if (p.method === "beatmatch_blend" && p.beatAlign && !p.beatAlign.regions && A.beat) {
      const bars = p.beatAlign.overlapBeats / 4, barA = A.beat.period * 4;
      const baseCost = fullMixCost(p, A, B, s);
      const fault = !!baseCost && (baseCost.unsupported > 0 || baseCost.holeDb > 6 || baseCost.jumpDb > 2 || baseCost.doubleBass / p.duration > 0.2);
      if (bars > 4 && (fault || ((_a = p.debug.fullMixRules) == null ? void 0 : _a.looseGrid))) {
        const half = Math.max(4, bars / 2), q = build(s, { exit: p.aExit, entry: p.bEntry, bars: half });
        yield;
        if (q.method === "beatmatch_blend" && ((_b = q.beatAlign) == null ? void 0 : _b.overlapBeats) === half * 4) entries.push(["shorter", q]);
      }
      const tried = (_c = p.debug.candidates) != null ? _c : [];
      const near = tried.find((c) => c.bars === bars && Math.abs(c.exit - p.aExit) >= 4 * barA - 0.05 && Math.abs(c.exit - p.aExit) <= 8 * barA + 0.05);
      if (near) {
        const q = build(s, { exit: near.exit, entry: near.entry, bars: near.bars });
        yield;
        if (q.method === "beatmatch_blend" && Math.abs(q.aExit - near.exit) < 0.01) entries.push(["neighbor-exit", q]);
      }
      if (p.debug.fullMixRules && p.debug.fullMixRules.looseGrid) {
        const q = build({ ...s, maxStretchPercent: 0 });
        yield;
        if (q.method !== "beatmatch_blend" && ["crossfade", "beatmatch_blend"].includes(q.method)) entries.push(["unlocked", q]);
      }
    }
    if (s.entryMode !== "preserve" && s.maxEntrySkipSeconds !== 0 && p.bEntry - B.audibleStart >= 2) {
      const q = build({ ...s, entryMode: "preserve" });
      yield;
      if (["crossfade", "beatmatch_blend"].includes(q.method) && q.bEntry < p.bEntry - 1 && (p.method !== "beatmatch_blend" || q.method === "beatmatch_blend")) entries.push(["preserve-start", q]);
    }
    const rated = entries.slice(0, 4).map(([name, plan]) => ({ name, plan, cost: fullMixCost(plan, A, B, s) }));
    const base = rated[0];
    const ratings = feedbackFor(fb, rated, A, B), adj = (c) => c.cost.total - ratings.bias(c.plan);
    const safe = (c) => !ratings.debug || !base.cost || c.cost.total < base.cost.total - 0.1 || c.cost.unsupported <= base.cost.unsupported && c.cost.holeDb <= base.cost.holeDb + 0.5 && c.cost.jumpDb <= base.cost.jumpDb + 0.5;
    const valid = rated.filter((c) => !!c.cost).sort((x, y) => adj(x) - adj(y));
    const best = valid.find((c) => c === base || safe(c));
    const winner = base.cost && best && best.name !== "baseline" && adj(best) < adj(base) - 0.1 ? best : base;
    const reason = !base.cost ? "\u043F\u043E\u043B\u043E\u0441\u044B \u043D\u0435 \u0438\u0437\u043C\u0435\u0440\u0435\u043D\u044B: \u0438\u0441\u0445\u043E\u0434\u043D\u044B\u0439 \u043F\u043B\u0430\u043D" : winner === base ? "\u0430\u043B\u044C\u0442\u0435\u0440\u043D\u0430\u0442\u0438\u0432\u044B \u043F\u043E\u043B\u043D\u043E\u0433\u043E \u043C\u0438\u043A\u0441\u0430 \u043D\u0435 \u0434\u0430\u043B\u0438 \u0437\u0430\u043C\u0435\u0442\u043D\u043E\u0433\u043E \u0443\u043B\u0443\u0447\u0448\u0435\u043D\u0438\u044F" : winner.name === "shorter" ? "\u043F\u043E\u043B\u043D\u044B\u0439 \u043C\u0438\u043A\u0441: \u043A\u043E\u0440\u043E\u0447\u0435 \u043E\u0431\u0449\u0438\u0439 \u0443\u0447\u0430\u0441\u0442\u043E\u043A, A \u0443\u0445\u043E\u0434\u0438\u0442 \u043F\u043E \u043E\u043A\u043E\u043D\u0447\u0430\u043D\u0438\u0438 \u0441\u0432\u043E\u0435\u0433\u043E \u0440\u0430\u0437\u0434\u0435\u043B\u0430" : winner.name === "neighbor-exit" ? "\u043F\u043E\u043B\u043D\u044B\u0439 \u043C\u0438\u043A\u0441: \u0432\u044B\u0445\u043E\u0434 \u043D\u0430 \u0441\u043E\u0441\u0435\u0434\u043D\u0435\u0439 \u0444\u0440\u0430\u0437\u0435, \u0433\u0434\u0435 \u0442\u0435\u043A\u0443\u0449\u0438\u0439 \u0442\u0440\u0435\u043A \u0441\u043B\u044B\u0448\u043D\u043E \u0437\u0430\u043A\u0430\u043D\u0447\u0438\u0432\u0430\u0435\u0442 \u0440\u0430\u0437\u0434\u0435\u043B" : winner.name === "unlocked" ? "\u043F\u043E\u043B\u043D\u044B\u0439 \u043C\u0438\u043A\u0441: \u0431\u0435\u0437 \u0441\u0442\u044B\u043A\u043E\u0432\u043A\u0438 \u0440\u0438\u0442\u043C\u043E\u0432, \u0440\u043E\u0432\u043D\u0435\u0435 \u043F\u0443\u0442\u044C \u0433\u0440\u043E\u043C\u043A\u043E\u0441\u0442\u0438 \u0438 \u0431\u0430\u0441\u0430" : "\u043F\u043E\u043B\u043D\u044B\u0439 \u043C\u0438\u043A\u0441: \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u0442\u0440\u0435\u043A \u0432\u0445\u043E\u0434\u0438\u0442 \u0441\u043E \u0441\u0432\u043E\u0435\u0433\u043E \u043D\u0430\u0447\u0430\u043B\u0430, \u0431\u0435\u0437 \u0441\u0440\u0435\u0437\u0430\u043D\u043D\u043E\u0433\u043E \u0437\u0430\u0442\u0430\u043A\u0442\u0430 \u0438 \u0432\u0441\u0442\u0443\u043F\u043B\u0435\u043D\u0438\u044F";
    const debug = {
      policy: "full-mix-1",
      selected: winner.name,
      reason,
      margin: 0.1,
      candidates: rated.map((c) => ({ name: c.name, method: c.plan.method, variant: c.plan.debug.variant, duration: c.plan.duration, bEntry: c.plan.bEntry, cost: c.cost }))
    };
    const label = (c) => ({
      ...c.plan,
      id: c === base ? c.plan.id : `${c.plan.id}_${c.name}`,
      reasons: c === winner && c !== base ? [...c.plan.reasons, reason] : c.plan.reasons,
      debug: {
        ...c.plan.debug,
        fullMix: { ...debug, selected: c === winner ? winner.name : debug.selected, this: c.name },
        ...ratings.debug ? { ratingFeedback: { ...ratings.debug, selected: winner.name, margin: 0.1 } } : {}
      }
    });
    return [label(winner), ...[...valid.map((c) => c), ...rated.filter((c) => !c.cost)].filter((c) => c !== winner).map(label)];
  }
  function chooseMusicalPlan(p, a, b, s, requestedAt, fb) {
    var _a, _b, _c, _d, _e, _f;
    const A = a.analysis, B = b.analysis;
    if (requestedAt !== void 0 || !s.enabled || !A || !B || p.debug.processingAllowed === false || p.loopA || ((_a = p.beatAlign) == null ? void 0 : _a.regions) || !["crossfade", "beatmatch_blend"].includes(p.method) || !gridTrust(A).trusted || !gridTrust(B).trusted) return p;
    const known = firstVoice(A, Math.max(A.audibleStart, p.aExit - 2), A.audibleEnd) !== null && firstVoice(B, p.bEntry, p.bEntry + integrateTempo(p.tempoB, p.duration - ((_b = p.bDelay) != null ? _b : 0))) !== null && measuredCurves(A, Math.max(A.audibleStart, p.aExit - 2), A.audibleEnd) && measuredCurves(B, p.bEntry, Math.min(B.audibleEnd, p.bEntry + integrateTempo(p.tempoB, p.duration - ((_c = p.bDelay) != null ? _c : 0)) + 3));
    const entries = [["baseline", p]];
    if (known) {
      const protection = p.debug.firstWords;
      const ctx = {
        a,
        b,
        s: sanitizedSettings(s),
        gainA: p.gainA,
        gainB: p.gainB,
        vocalRepair: { entry: p.bEntry, minHandoff: p.aExit + integrateTempo(p.tempoA, (_d = protection == null ? void 0 : protection.previousHandoff) != null ? _d : p.swapAt) - 0.5 }
      };
      if (p.method === "beatmatch_blend" && p.duration > 8 && ((protection == null ? void 0 : protection.wholeDeckFade) || (protection == null ? void 0 : protection.earlyStemHandoff))) {
        const shorter = finishPlan(buildTransition(a, b, s, void 0, ctx.vocalRepair), A, B, s);
        if (shorter.method === "beatmatch_blend" && Math.abs(shorter.bEntry - p.bEntry) < 1e-3 && shorter.duration < p.duration - 0.1 && !((_e = shorter.beatAlign) == null ? void 0 : _e.regions)) entries.push(["short-phrase", shorter]);
      }
      const ga = A.beat, gb = B.beat;
      if (ga && gb && ga.stable && gb.stable && ga.confidence >= 0.8 && gb.confidence >= 0.8 && ga.downbeatConfidence >= 0.7 && gb.downbeatConfidence >= 0.7 && ga.jitterMs <= 12 && gb.jitterMs <= 12 && A.phraseConfidence >= 0.6 && tempoRelation(ga.bpm, gb.bpm).stretchPercent > Math.max(LOCK_LONG_PERCENT, s.maxStretchPercent)) {
        const cut = planPhraseCut(ctx, A, B, p.keyInfo, p.fallbackReason);
        if (((_f = cut == null ? void 0 : cut.beatAlign) == null ? void 0 : _f.phraseAligned) && Math.abs(cut.bEntry - p.bEntry) < 1e-3) entries.push(["phrase-cut", finishPlan(cut, A, B, s)]);
      }
    }
    const cost = (q) => {
      var _a2, _b2, _c2, _d2, _e2;
      if (!known || firstVoice(A, Math.max(A.audibleStart, q.aExit - 2), A.audibleEnd) === null || firstVoice(B, q.bEntry, q.bEntry + integrateTempo(q.tempoB, q.duration - ((_a2 = q.bDelay) != null ? _a2 : 0))) === null || !measuredCurves(A, Math.max(A.audibleStart, q.aExit - 2), A.audibleEnd) || !measuredCurves(B, q.bEntry, Math.min(B.audibleEnd, q.bEntry + integrateTempo(q.tempoB, q.duration - ((_b2 = q.bDelay) != null ? _b2 : 0)) + 3))) return null;
      const at = (deck, name, t) => {
        var _a3, _b3;
        return pointValue((_b3 = (_a3 = q.automation.find((l) => l.deck === deck && l.lane === name)) == null ? void 0 : _a3.points) != null ? _b3 : [[0, 1]], t);
      };
      let lostA = 0, lostB = 0, voiceOverlap = 0, drumOverlap = 0, hole = 0;
      const delay = (_c2 = q.bDelay) != null ? _c2 : 0, endB = q.bEntry + integrateTempo(q.tempoB, q.duration - delay);
      const reference = Math.min(levelBefore(A, q.aExit) + q.gainA, powerLevel(B, endB, Math.min(B.audibleEnd, endB + 3)) + q.gainB);
      for (let i = 0; i < 32; i++) {
        const t = q.duration * (i + 0.5) / 32, dt = q.duration / 32, tb = t - delay, sa = q.aExit + integrateTempo(q.tempoA, t), sb = q.bEntry + integrateTempo(q.tempoB, Math.max(0, tb));
        const va = vocalMean(A, sa, sa + 0.05), vb = tb < 0 ? 0 : vocalMean(B, sb, sb + 0.05), ma = pointValue((_d2 = q.vocalA) != null ? _d2 : [[0, 1]], t), mb = pointValue((_e2 = q.vocalB) != null ? _e2 : [[0, 1]], tb);
        const ag = at("A", "gain", t), bg = tb < 0 ? 0 : at("B", "gain", tb);
        lostA += va * (1 - Math.min(1, ag * ma)) * dt;
        lostB += vb * (1 - Math.min(1, bg * mb)) * dt;
        voiceOverlap += Math.min(va * ag * ma, vb * bg * mb) * dt;
        if (q.method !== "beatmatch_blend") drumOverlap += Math.min(ag * at("A", "low", t), bg * at("B", "low", tb)) * dt * A.rhythmStrength * B.rhythmStrength;
        const power = ag * ag * filteredPower(A, sa, q.gainA, at("A", "low", t), at("A", "mid", t), at("A", "high", t), ma) + bg * bg * filteredPower(B, sb, q.gainB, at("B", "low", tb), at("B", "mid", tb), at("B", "high", tb), mb);
        hole = Math.max(hole, reference - 10 * Math.log10(Math.max(1e-12, power)) - 3);
      }
      const tail = q.aExit + integrateTempo(q.tempoA, q.duration);
      if (tail < A.audibleEnd) lostA += vocalMean(A, tail, A.audibleEnd) * (A.audibleEnd - tail);
      const total = 0.16 * lostA + 0.8 * lostB + 0.5 * voiceOverlap + 0.2 * drumOverlap + 0.2 * Math.max(0, hole) + (q.method === "phrase_cut" ? 0.3 : 0);
      if (!Number.isFinite(total)) return null;
      return { total: r32(total), cutA: !!outgoingPhraseCut(q, A), lostA: r32(lostA), lostB: r32(lostB), voiceOverlap: r32(voiceOverlap), drumOverlap: r32(drumOverlap), holeDb: r32(Math.max(0, hole)) };
    };
    const rated = entries.map(([name, plan]) => ({ name, plan, cost: cost(plan) }));
    const ratings = feedbackFor(fb, rated, A, B), adj = (c) => c.cost.total - ratings.bias(c.plan);
    let winner = rated[0];
    for (const c of rated.slice(1)) if (c.cost && winner.cost && (adj(c) < adj(winner) - 0.15 || winner.cost.cutA && !c.cost.cutA && adj(c) <= adj(winner) && c.cost.lostB <= winner.cost.lostB && c.cost.voiceOverlap <= winner.cost.voiceOverlap) && c.cost.holeDb <= Math.max(3, winner.cost.holeDb + 0.5)) winner = c;
    const reason = !known ? "\u0438\u0437\u043C\u0435\u0440\u0435\u043D\u0438\u044F \u043D\u0435\u043F\u043E\u043B\u043D\u044B: \u0438\u0441\u0445\u043E\u0434\u043D\u044B\u0439 \u043F\u043B\u0430\u043D, \u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u0432\u043E\u043A\u0430\u043B \u043D\u0435 \u043E\u0446\u0435\u043D\u0438\u0432\u0430\u043B\u0441\u044F \u043A\u0430\u043A \u0442\u0438\u0448\u0438\u043D\u0430" : winner.name === "baseline" ? "\u0430\u043B\u044C\u0442\u0435\u0440\u043D\u0430\u0442\u0438\u0432\u044B \u043D\u0435 \u0434\u0430\u043B\u0438 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043D\u043D\u043E\u0433\u043E \u0443\u043B\u0443\u0447\u0448\u0435\u043D\u0438\u044F \u0441 \u0437\u0430\u043F\u0430\u0441\u043E\u043C" : "\u043C\u0435\u043D\u044C\u0448\u0435 \u043F\u043E\u0442\u0435\u0440\u044F\u043D\u043D\u044B\u0445 \u0444\u0440\u0430\u0437 \u0438 \u043A\u043E\u043D\u0444\u043B\u0438\u043A\u0442\u043E\u0432 \u0431\u0435\u0437 \u0443\u0445\u0443\u0434\u0448\u0435\u043D\u0438\u044F \u0440\u0430\u0441\u0447\u0451\u0442\u043D\u043E\u0433\u043E \u043F\u0440\u043E\u0432\u0430\u043B\u0430 \u043C\u043E\u0449\u043D\u043E\u0441\u0442\u0438";
    return {
      ...winner.plan,
      id: winner.name === "baseline" ? p.id : `${winner.plan.id}_${winner.name}`,
      reasons: winner.name === "baseline" ? p.reasons : [...winner.plan.reasons, reason],
      debug: {
        ...winner.plan.debug,
        candidateSelection: {
          policy: "metadata-candidates-1",
          baseline: "baseline",
          selected: winner.name,
          reason,
          knownCoverage: known,
          margin: 0.15,
          candidates: rated.map((c) => ({ name: c.name, method: c.plan.method, duration: c.plan.duration, cost: c.cost }))
        },
        ...ratings.debug ? { ratingFeedback: { ...ratings.debug, selected: winner.name, margin: 0.15 } } : {}
      }
    };
  }
  function finishPlan(plan, A, B, s, requestedAt) {
    var _a, _b;
    const timed = withMasterTempo(plan, A, B, s, requestedAt);
    const p = applyVocalHandoff(holdLoudness(timed, A, B), A, B, s);
    const held = (p.vocalA || p.vocalB) && (((_a = A == null ? void 0 : A.vocalActivity) == null ? void 0 : _a.accompanimentRmsDb) || ((_b = B == null ? void 0 : B.vocalActivity) == null ? void 0 : _b.accompanimentRmsDb)) ? holdLoudness(p, A, B) : p;
    const result = s.eqHandoff && requestedAt === void 0 && held.method === "beatmatch_blend" && A && B ? phraseBassSwap(held, A, B) : held;
    const bassed = s.eqHandoff && requestedAt === void 0 && A && B ? bassContinuity(result, A, B) : result;
    const decorated = withDjPhrasing(withInstrumentalLoop(bassed, A, B, s, requestedAt), A, B, s, requestedAt);
    const protectedPlan = requestedAt === void 0 ? withVocalGap(preserveFirstWords(decorated, A, B, s), A, B, s) : decorated;
    if (protectedPlan.bDelay || protectedPlan.debug.vocalGap) return protectedPlan;
    const onset = withMicroOnset(protectedPlan, A, B, s, requestedAt);
    return withTapeStop(withHarmonicHandoff(withVoiceAnswer(onset, A, B, s, requestedAt), A, B, s, requestedAt), A, B, s, requestedAt);
  }
  function holdLoudness(p, A, B) {
    if (!A || !B || p.duration < 1 || !["crossfade", "beatmatch_blend"].includes(p.method)) return p;
    return raiseLanes(raiseLanes(p, A, B, ["gain"]), A, B, ["mid", "high"]);
  }
  function raiseLanes(p, A, B, lanes) {
    var _a, _b;
    const D = p.duration;
    const pts = (deck, l) => {
      var _a2;
      return (_a2 = p.automation.find((x) => x.deck === deck && x.lane === l)) == null ? void 0 : _a2.points;
    };
    const at = (points, t) => points ? pointValue(points, t) : 1;
    const before = levelBefore(A, p.aExit) + p.gainA;
    const bEnd = p.bEntry + integrateTempo(p.tempoB, D);
    const after = powerLevel(B, bEnd, Math.min(B.audibleEnd, bEnd + 6)) + p.gainB;
    const N = 16, maxBoost = Math.pow(10, 3 / 20);
    const boost = [];
    for (let i = 0; i <= N; i++) {
      const t = D * i / N;
      const ga = at(pts("A", "gain"), t), gb = at(pts("B", "gain"), t);
      const sum = ga * ga * filteredPower(A, p.aExit + integrateTempo(p.tempoA, t), p.gainA, at(pts("A", "low"), t), at(pts("A", "mid"), t), at(pts("A", "high"), t), at(p.vocalA, t)) + gb * gb * filteredPower(B, p.bEntry + integrateTempo(p.tempoB, t), p.gainB, at(pts("B", "low"), t), at(pts("B", "mid"), t), at(pts("B", "high"), t), at(p.vocalB, t));
      const target = Math.pow(10, (before + (after - before) * (t / D)) / 10);
      const held = typeof p.debug.holdUntil === "number" && t > p.debug.holdUntil;
      boost.push([r32(t), held ? 1 : Math.min(maxBoost, Math.max(1, Math.sqrt(target / Math.max(1e-12, sum))))]);
    }
    boost[0][1] = 1;
    boost[N][1] = 1;
    if (boost.every(([, k]) => k < 1.02)) return p;
    const guard = (_a = p.debug.stems) == null ? void 0 : _a.bleedGuard;
    const automation = p.automation.map((l) => {
      if (!lanes.includes(l.lane)) return l;
      const knots = [.../* @__PURE__ */ new Set([...l.points.map(([t]) => t), ...boost.map(([t]) => t)])].filter((t) => t <= D + 1e-9).sort((x, y) => x - y);
      const tail = l.points.filter(([t]) => t > D + 1e-9);
      const guarded = l.deck === "A" && (l.lane === "mid" || l.lane === "high") && guard;
      const raised = (t) => {
        const g = pointValue(l.points, t);
        return guarded && t >= guard.from ? g : Math.max(0, g, Math.min(1, g * pointValue(boost, t)));
      };
      return { ...l, points: [...knots.map((t) => [t, r32(raised(t))]), ...tail] };
    });
    const peak = Math.max(...boost.map(([, k]) => k));
    const first = p.debug.loudnessHold === void 0;
    return {
      ...p,
      automation,
      reasons: first ? [...p.reasons, "\u0433\u0440\u043E\u043C\u043A\u043E\u0441\u0442\u044C \u0432 \u0441\u0435\u0440\u0435\u0434\u0438\u043D\u0435 \u043F\u0435\u0440\u0435\u0445\u043E\u0434\u0430 \u0432\u044B\u0440\u043E\u0432\u043D\u0435\u043D\u0430 \u043F\u043E \u0438\u0437\u043C\u0435\u0440\u0435\u043D\u043D\u044B\u043C \u043F\u043E\u043B\u043E\u0441\u0430\u043C: \u0431\u0435\u0437 \u044F\u043C\u044B \u043E\u0442 \u043E\u0434\u043D\u043E\u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E\u0433\u043E \u0441\u043F\u0430\u0434\u0430 \u043E\u0431\u0435\u0438\u0445 \u0434\u0435\u043A"] : p.reasons,
      debug: { ...p.debug, loudnessHold: [...(_b = p.debug.loudnessHold) != null ? _b : [], r32(20 * Math.log10(peak))] }
    };
  }
  function buildTransition(a, b, settings, requestedAt, vocalRepair, fixed) {
    const s = sanitizedSettings(settings);
    const ctx = {
      a,
      b,
      s,
      gainA: normalizationGain(a.analysis, settings.loudnessTarget),
      gainB: normalizationGain(b.analysis, settings.loudnessTarget),
      requestedAt,
      vocalRepair,
      fixed
    };
    if (s.maxBlendSeconds < 0.03) return planSequential(ctx, "\u043D\u0430\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D\u043E \u0432 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u0445 \u0434\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u0438");
    if (!settings.enabled) return planSequential(ctx, "AutoMix \u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D: \u0442\u0440\u0435\u043A\u0438 \u0438\u0433\u0440\u0430\u044E\u0442 \u043F\u043E\u0434\u0440\u044F\u0434");
    if (!a.mixingAllowed || !b.mixingAllowed) {
      ctx.gainA = 0;
      ctx.gainB = 0;
      return planSequential(ctx, "\u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A \u043D\u0435 \u0440\u0430\u0437\u0440\u0435\u0448\u0430\u0435\u0442 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0443 \u0437\u0432\u0443\u043A\u0430: \u0431\u0435\u0437 \u043D\u0430\u043B\u043E\u0436\u0435\u043D\u0438\u044F");
    }
    if (settings.respectAlbums && isConsecutiveAlbum(a, b)) {
      return planSequential(ctx, "\u0442\u0440\u0435\u043A\u0438 \u043E\u0434\u043D\u043E\u0433\u043E \u0430\u043B\u044C\u0431\u043E\u043C\u0430 \u0438\u0434\u0443\u0442 \u043F\u043E\u0434\u0440\u044F\u0434: \u0431\u0435\u0437 \u043F\u0430\u0443\u0437\u044B \u0438 \u0431\u0435\u0437 \u043D\u0430\u043B\u043E\u0436\u0435\u043D\u0438\u044F");
    }
    const A = a.analysis;
    const B = b.analysis;
    if (!A || !B) return planFallbackCrossfade(ctx, !A && !B ? "\u0430\u043D\u0430\u043B\u0438\u0437 \u043E\u0431\u043E\u0438\u0445 \u0442\u0440\u0435\u043A\u043E\u0432 \u0435\u0449\u0451 \u043D\u0435 \u0433\u043E\u0442\u043E\u0432" : !A ? "\u0430\u043D\u0430\u043B\u0438\u0437 \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430 \u0435\u0449\u0451 \u043D\u0435 \u0433\u043E\u0442\u043E\u0432" : "\u0430\u043D\u0430\u043B\u0438\u0437 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430 \u0435\u0449\u0451 \u043D\u0435 \u0433\u043E\u0442\u043E\u0432");
    if (A.warnings.includes("silent") || B.warnings.includes("silent")) {
      return planSequential(ctx, "\u0432 \u0442\u0440\u0435\u043A\u0435 \u043D\u0435\u0442 \u0437\u0432\u0443\u043A\u0430: \u043F\u0435\u0440\u0435\u0445\u043E\u0434 \u0431\u0435\u0437 \u043D\u0430\u043B\u043E\u0436\u0435\u043D\u0438\u044F");
    }
    if (Math.min(A.audibleEnd - A.audibleStart, B.audibleEnd - B.audibleStart) < 0.06) {
      return planSequential(ctx, "\u0441\u043B\u0438\u0448\u043A\u043E\u043C \u043A\u043E\u0440\u043E\u0442\u043A\u0438\u0439 \u0437\u0432\u0443\u043A\u043E\u0432\u043E\u0439 \u0444\u0440\u0430\u0433\u043C\u0435\u043D\u0442 \u0434\u043B\u044F \u043D\u0430\u043B\u043E\u0436\u0435\u043D\u0438\u044F");
    }
    const trustA = gridTrust(A), trustB = gridTrust(B);
    const rhythmA = !!A.beat && A.beat.confidence >= 0.45 && A.beat.stable && trustA.trusted;
    const rhythmB = !!B.beat && B.beat.confidence >= 0.45 && B.beat.stable && trustB.trusted;
    const key = camelotCompatibility(A.key.camelot, B.key.camelot);
    const keyKnown = A.key.confidence > 0.15 && B.key.confidence > 0.15 && !!A.key.camelot && !!B.key.camelot;
    const keyInfo = { a: A.key.camelot || "?", b: B.key.camelot || "?", compatibility: keyKnown ? key.score : 0.5, label: keyKnown ? key.label : "\u0442\u043E\u043D\u0430\u043B\u044C\u043D\u043E\u0441\u0442\u044C \u043D\u0435 \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0435\u043D\u0430 \u0443\u0432\u0435\u0440\u0435\u043D\u043D\u043E" };
    let fallbackReason;
    if (rhythmA && rhythmB) {
      const rel = tempoRelation(A.beat.bpm, B.beat.bpm);
      if (rel.stretchPercent <= lockLimit(s) + 1e-6) {
        const p = planBeatmatch(ctx, A, B, rel, keyInfo);
        if (p) return p;
        fallbackReason = "\u043D\u0435 \u043D\u0430\u0448\u043B\u043E\u0441\u044C \u043E\u0431\u0449\u0438\u0445 \u0444\u0440\u0430\u0437 \u0441 \u0434\u043E\u0441\u0442\u0430\u0442\u043E\u0447\u043D\u044B\u043C \u0437\u0430\u043F\u0430\u0441\u043E\u043C \u0437\u0432\u0443\u043A\u0430";
      } else if (rel.stretchPercent <= Math.min(s.maxStretchPercent, LOCK_LONG_PERCENT) + 1e-6 && s.style !== "tight") {
        const p = planBeatmatch(ctx, A, B, rel, keyInfo, 8);
        if (p) return p;
        fallbackReason = `\u0442\u0435\u043C\u043F \u043E\u0442\u043B\u0438\u0447\u0430\u0435\u0442\u0441\u044F \u043D\u0430 ${rel.stretchPercent.toFixed(1)} %: \u0434\u043B\u044F \u0442\u0430\u043A\u043E\u0439 \u0440\u0430\u0437\u043D\u0438\u0446\u044B \u043D\u0443\u0436\u043D\u0430 \u0434\u043E\u043B\u0433\u0430\u044F \u043F\u043B\u0430\u0432\u043D\u0430\u044F \u0441\u0442\u044B\u043A\u043E\u0432\u043A\u0430, \u0430 \u043C\u0435\u0441\u0442\u0430 \u0434\u043B\u044F \u043D\u0435\u0451 \u043D\u0435\u0442 \u2014 \u043C\u044F\u0433\u043A\u0438\u0439 \u043F\u0435\u0440\u0435\u0445\u043E\u0434 \u0431\u0435\u0437 \u0441\u0442\u044B\u043A\u043E\u0432\u043A\u0438 \u0440\u0438\u0442\u043C\u043E\u0432`;
      } else {
        fallbackReason = `\u0442\u0435\u043C\u043F \u043E\u0442\u043B\u0438\u0447\u0430\u0435\u0442\u0441\u044F \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u0441\u0438\u043B\u044C\u043D\u043E \u0434\u043B\u044F \u0441\u0432\u0435\u0434\u0435\u043D\u0438\u044F \u043F\u043E \u0431\u0438\u0442\u0430\u043C: ${A.beat.bpm.toFixed(1)} \u0438 ${B.beat.bpm.toFixed(1)} BPM (\u043D\u0443\u0436\u043D\u043E ${rel.stretchPercent.toFixed(1)} %, \u0431\u0435\u0437 \u0441\u043B\u044B\u0448\u0438\u043C\u043E\u0433\u043E \u0440\u0430\u0441\u0442\u044F\u0436\u0435\u043D\u0438\u044F \u0434\u043E ${lockLimit(s)} %): \u043C\u044F\u0433\u043A\u0438\u0439 \u043F\u0435\u0440\u0435\u0445\u043E\u0434 \u0431\u0435\u0437 \u0441\u0442\u044B\u043A\u043E\u0432\u043A\u0438 \u0440\u0438\u0442\u043C\u043E\u0432`;
      }
    } else {
      fallbackReason = !A.beat || !B.beat ? "\u0443 \u043E\u0434\u043D\u043E\u0433\u043E \u0438\u0437 \u0442\u0440\u0435\u043A\u043E\u0432 \u043D\u0435\u0442 \u0443\u0441\u0442\u043E\u0439\u0447\u0438\u0432\u043E\u0433\u043E \u0440\u0438\u0442\u043C\u0430" : !trustA.trusted || !trustB.trusted ? "\u043F\u043E\u0432\u0442\u043E\u0440\u044B \u043C\u0443\u0437\u044B\u043A\u0438 \u043D\u0435 \u043B\u043E\u0436\u0430\u0442\u0441\u044F \u043D\u0430 \u0442\u0430\u043A\u0442\u044B \u043D\u0430\u0439\u0434\u0435\u043D\u043D\u043E\u0439 \u0441\u0435\u0442\u043A\u0438 \u0431\u0438\u0442\u043E\u0432: \u0442\u0430\u043A\u0442\u044B \u043D\u0435 \u0441\u043E\u0432\u043F\u0430\u0434\u0443\u0442, \u0441\u0432\u0435\u0434\u0435\u043D\u0438\u0435 \u043F\u043E \u044D\u0442\u043E\u0439 \u0441\u0435\u0442\u043A\u0435 \u043D\u0435 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u0442\u0441\u044F" : "\u0441\u0435\u0442\u043A\u0430 \u0431\u0438\u0442\u043E\u0432 \u043D\u0435\u0443\u0441\u0442\u043E\u0439\u0447\u0438\u0432\u0430 \u0438\u043B\u0438 \u0443\u0432\u0435\u0440\u0435\u043D\u043D\u043E\u0441\u0442\u044C \u043D\u0438\u0437\u043A\u0430\u044F";
    }
    const local = planLocalRhythm(ctx, A, B, keyInfo);
    if (local) return withGridTrust(local, trustA, trustB);
    const gridA = trustA.trusted ? A : { ...A, beat: null }, gridB = trustB.trusted ? B : { ...B, beat: null };
    return withGridTrust(planUnlocked(ctx, gridA, gridB, keyInfo, fallbackReason), trustA, trustB);
  }
  function withGridTrust(p, a, b) {
    if (a.trusted && b.trusted) return p;
    return { ...p, debug: { ...p.debug, gridTrust: { A: a, B: b } } };
  }
  function gridTrust(an) {
    var _a;
    const g = (_a = an.structure) == null ? void 0 : _a.gridCheck;
    if (!(g == null ? void 0 : g.periodHint) || !an.beat) return { trusted: true };
    return { trusted: false, reason: "period-hint", hintBpm: g.periodHint.bpm };
  }
  function regionTrusted(an, region, trust) {
    if (trust.trusted || !an.beat) return true;
    const family = (x, y) => [0.5, 1, 2].some((m) => Math.abs(x / (y * m) - 1) < 0.03);
    if (trust.hintBpm && family(region.bpm, trust.hintBpm)) return true;
    return !family(region.bpm, an.beat.bpm);
  }
  function planUnlocked(ctx, A, B, keyInfo, fallbackReason) {
    const settings = ctx.s;
    const fadeA = naturalFade(A);
    const hardEnd = fadeA.length < 2.5 && levelMean(A, A.audibleEnd - 1.5, A.audibleEnd - 0.2) > A.bodyRmsDb - 6;
    const hardStart = levelMean(B, B.audibleStart, B.audibleStart + 0.6) > B.bodyRmsDb - 6;
    const strongBeats = !!A.beat && !!B.beat && A.beat.stable && A.beat.confidence >= 0.5 && B.beat.confidence >= 0.45 && A.beat.downbeatConfidence >= 0.3 && A.beat.downbeats.length > 8 && B.beat.downbeats.length > 2;
    if (settings.style === "tight" && strongBeats && fadeA.length < 6) {
      const p = planPhraseCut(ctx, A, B, keyInfo, fallbackReason);
      if (p) return p;
    }
    const shortTrack = A.audibleEnd - A.audibleStart < 30 || B.audibleEnd - B.audibleStart < 30;
    if (shortTrack && hardEnd && hardStart && !fadeA.length) return planMinimal(ctx, A, B, keyInfo, fallbackReason);
    if (A.rhythmStrength > 0.45 && B.rhythmStrength > 0.45) {
      const p = planIntroDrop(ctx, A, B, keyInfo, fallbackReason);
      if (p) return p;
    }
    const bridge = planInstrumentalBridge(ctx, A, B, keyInfo, fallbackReason);
    if (bridge) return bridge;
    if (ctx.requestedAt === void 0 && A.beat && B.beat) {
      const echo = planEchoOut({ ...basePlan(ctx, "echo_out"), keyInfo, fallbackReason }, A, B, settings, tempoRelation(A.beat.bpm, B.beat.bpm).stretchPercent);
      if (echo) return echo;
    }
    return planCrossfade(ctx, A, B, keyInfo, fallbackReason);
  }
  function planInstrumentalBridge(ctx, A, B, keyInfo, fallbackReason) {
    var _a, _b;
    if (ctx.requestedAt !== void 0 || !A.vocalActivity || !ctx.s.eqHandoff || keyInfo.compatibility < 0.5 || !((_a = B.beat) == null ? void 0 : _a.stable) || B.beat.confidence < 0.6 || B.beat.downbeatConfidence < 0.5) return null;
    const voice = A.vocalActivity;
    if (!(voice.rate > 0) || voice.values.length / voice.rate < A.audibleEnd - 0.1 || !voice.values.slice(Math.floor(Math.max(0, A.audibleEnd - 8) * voice.rate)).every(Number.isFinite)) return null;
    const bodyLow = powerLevel(A, A.audibleStart, A.audibleEnd, A.curves.lowDb);
    const bodyHigh = powerLevel(A, A.audibleStart, A.audibleEnd, A.curves.highDb);
    const deClick = Math.min(0.75, B.beat.period);
    const limit = Math.min(16, ctx.s.maxBlendSeconds - deClick, (A.audibleEnd - A.audibleStart) * 0.15);
    if (!measuredCurves(A, Math.max(A.audibleStart, A.audibleEnd - limit - 8), A.audibleEnd)) return null;
    let start = A.audibleEnd;
    for (let t = A.audibleEnd - 0.25; t >= A.audibleEnd - limit; t -= 0.25) {
      if (vocalMean(A, t, t + 0.25) > 0.18 || powerLevel(A, t, t + 0.25, A.curves.lowDb) > bodyLow - 9 || powerLevel(A, t, t + 0.25, A.curves.highDb) > bodyHigh - 5) break;
      start = t;
    }
    const tail = A.audibleEnd - start;
    if (tail < 2.5 || tail >= limit - 0.25 || powerLevel(A, start - 1, start) < A.bodyRmsDb - 7) return null;
    const quietStart = start;
    const barB = B.beat.period * 4;
    const preparations = [1, 2, 3].map((bars) => bars * barB).filter((rise2) => rise2 <= 8 && tail + rise2 <= ctx.s.maxBlendSeconds && quietStart - rise2 >= A.audibleStart && powerLevel(A, quietStart - rise2, quietStart - rise2 + 0.75) >= A.bodyRmsDb - 3.5);
    const rise = preparations[0];
    if (rise === void 0) return null;
    start -= rise;
    const D = A.audibleEnd - start;
    const outgoingVoice = vocalMean(A, start, quietStart) > 0.18;
    const candidates = entryCandidates(B, ctx.s, 0, 0, ctx.requestedAt === void 0, !A.vocalActivity && !!B.vocalActivity);
    if (ctx.s.entryMode !== "preserve" && ctx.s.maxEntrySkipSeconds !== 0) {
      const skip = Math.min((_b = ctx.s.maxEntrySkipSeconds) != null ? _b : 45, (B.audibleEnd - B.audibleStart) * 0.45);
      for (const time of B.beat.downbeats) if (time >= B.audibleStart && time <= B.audibleStart + skip)
        candidates.push({ time, score: 0.68, kind: "downbeat", tags: ["bridge-arrival"] });
    }
    const entries = candidates.filter((c) => B.beat.downbeats.some((t) => Math.abs(t - c.time) < 0.025) && c.time + D + 1 <= B.audibleEnd && measuredCurves(B, c.time, c.time + D + 1) && (!outgoingVoice || !!B.vocalActivity && (ctx.s.stemMixing !== false || vocalMean(B, c.time, c.time + rise) <= 0.18)) && powerLevel(B, c.time, c.time + 1) >= B.bodyRmsDb - 4 && (c.time - B.audibleStart < 1 || !!B.vocalActivity && vocalMean(B, B.audibleStart, c.time) * (c.time - B.audibleStart) < 1));
    entries.sort((a, b) => entrySkipCost(B, a.time) - entrySkipCost(B, b.time) || a.time - b.time);
    const entry = entries[0];
    if (!entry) return null;
    const p = basePlan(ctx, "crossfade");
    p.aExit = r32(start);
    p.bEntry = r32(entry.time);
    p.duration = r32(D);
    p.swapAt = r32(rise);
    p.automation = [
      lane("B", "gain", shape(0, Math.min(3, rise), sinUp, 8)),
      lane("A", "gain", [[0, 1]], shape(rise, D, cosDown, 10)),
      lane("A", "low", [[0, 1]], shape(rise - deClick, rise, (x) => 1 - smoothstep(x), 6)),
      lane("B", "low", [[0, 0]], shape(rise - deClick, rise, smoothstep, 6)),
      lane("B", "high", shape(0, rise, (x) => 0.25 + 0.75 * smoothstep(x), 8))
    ];
    p.confidence = r32(Math.min(0.8, B.beat.confidence));
    p.keyInfo = keyInfo;
    p.fallbackReason = fallbackReason;
    p.debug = { variant: "instrumental-bridge", holdUntil: rise, measuredTail: r32(tail), preparation: r32(rise) };
    p.reasons = ["\u0441\u043C\u0435\u043D\u0430 \u0442\u0435\u043C\u043F\u0430 \u0447\u0435\u0440\u0435\u0437 \u0438\u0437\u043C\u0435\u0440\u0435\u043D\u043D\u044B\u0439 \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430\u043B\u044C\u043D\u044B\u0439 \u0445\u0432\u043E\u0441\u0442: \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u0442\u0440\u0435\u043A \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043B\u0435\u043D \u0437\u0430\u0440\u0430\u043D\u0435\u0435, \u0431\u0430\u0441 \u0432\u0445\u043E\u0434\u0438\u0442 \u043D\u0430 \u0441\u0438\u043B\u044C\u043D\u0443\u044E \u0434\u043E\u043B\u044E \u043F\u043E\u0441\u043B\u0435 \u0443\u0445\u043E\u0434\u0430 \u0441\u0442\u0430\u0440\u044B\u0445 \u0431\u0430\u0440\u0430\u0431\u0430\u043D\u043E\u0432, \u043E\u043A\u043E\u043D\u0447\u0430\u043D\u0438\u0435 \u0437\u0432\u0443\u0447\u0438\u0442 \u0434\u043E \u043A\u043E\u043D\u0446\u0430"];
    describeEntry(p, B, entry);
    const reference = Math.min(A.bodyRmsDb + ctx.gainA, B.bodyRmsDb + ctx.gainB);
    const value = (deck, name, t) => {
      var _a2;
      const points = (_a2 = p.automation.find((l) => l.deck === deck && l.lane === name)) == null ? void 0 : _a2.points;
      return points ? pointValue(points, t) : 1;
    };
    let hole = 0;
    for (let t = rise; t <= D + 1e-3; t += 0.25) {
      const power = value("A", "gain", t) ** 2 * filteredPower(
        A,
        start + t,
        ctx.gainA,
        value("A", "low", t),
        1,
        1
      ) + Math.pow(10, (powerLevel(B, entry.time + t - 0.25, entry.time + t + 0.5) + ctx.gainB) / 10);
      hole = Math.max(hole, reference - 10 * Math.log10(Math.max(1e-12, power)));
    }
    if (hole > 3) return null;
    p.debug.levelHole = r32(hole);
    return p;
  }
  function planLocalRhythm(ctx, A, B, keyInfo) {
    var _a;
    const views = (analysis, role) => {
      var _a2, _b, _c;
      const list = [];
      const trust = gridTrust(analysis);
      if (((_a2 = analysis.beat) == null ? void 0 : _a2.stable) && analysis.beat.confidence >= 0.45 && trust.trusted) list.push({ analysis });
      const limit = analysis.audibleStart + Math.min((_b = ctx.s.maxEntrySkipSeconds) != null ? _b : 45, (analysis.audibleEnd - analysis.audibleStart) * 0.45);
      for (const region of (_c = analysis.beatRegions) != null ? _c : []) {
        if (region.confidence < 0.55 || region.end - region.start < 12 || !regionTrusted(analysis, region, trust)) continue;
        if (role === "A" && (ctx.requestedAt === void 0 ? region.end < analysis.audibleEnd - 24 : region.end < ctx.requestedAt + 2 || region.start > ctx.requestedAt + 3)) continue;
        if (role === "B" && (region.start > limit || ctx.s.entryMode === "preserve" && region.start > analysis.audibleStart + 0.1)) continue;
        const entry = region.downbeats.find((t) => t >= region.start && t <= limit);
        list.push({ region, analysis: {
          ...analysis,
          beat: { ...region, stable: true, alternatives: [] },
          // Global cue points can all miss the independently fitted local phase.
          // Offer its first measured bar; entryCandidates still enforces preserve
          // mode and the listener's skip limit.
          cues: role === "B" && entry !== void 0 ? { ...analysis.cues, entry: [
            ...analysis.cues.entry,
            { time: entry, score: 0.68, kind: "downbeat", tags: ["measured-local-entry"] }
          ] } : analysis.cues,
          phrases: analysis.phrases.filter((t) => t >= region.start && t <= region.end),
          phraseConfidence: Math.min(analysis.phraseConfidence, region.downbeatConfidence)
        } });
      }
      return list.slice(0, 9);
    };
    let best = null, bestScore = -Infinity;
    for (const av of views(A, "A")) for (const bv of views(B, "B")) {
      if (!av.region && !bv.region) continue;
      const context = { ...ctx, regionA: av.region, regionB: bv.region };
      const rel = tempoRelation(av.analysis.beat.bpm, bv.analysis.beat.bpm);
      const plan = rel.stretchPercent <= lockLimit(ctx.s) + 1e-6 ? planBeatmatch(context, av.analysis, bv.analysis, rel, keyInfo) : rel.stretchPercent <= Math.min(ctx.s.maxStretchPercent, LOCK_LONG_PERCENT) + 1e-6 && ctx.s.style !== "tight" ? planBeatmatch(context, av.analysis, bv.analysis, rel, keyInfo, 8) : null;
      if (!plan) continue;
      const cut = A.audibleEnd - plan.aExit - integrateTempo(plan.tempoA, plan.duration);
      if (ctx.requestedAt === void 0 && cut > 20 && vocalMean(A, plan.aExit + integrateTempo(plan.tempoA, plan.duration), A.audibleEnd) > 0.2) continue;
      const score = Number((_a = plan.debug.score) != null ? _a : 0) + 0.1 * plan.confidence - 0.08 * Math.max(0, cut) / 24;
      if (score > bestScore) {
        if (plan.beatAlign) {
          const summary = (r5) => ({ start: r5.start, end: r5.end, period: r5.period, downbeat: r5.downbeats[0] });
          plan.beatAlign.regions = { ...av.region ? { A: summary(av.region) } : {}, ...bv.region ? { B: summary(bv.region) } : {} };
        }
        best = plan;
        bestScore = score;
      }
    }
    if (best) {
      best.reasons.push("\u0441\u0432\u0435\u0434\u0435\u043D\u0438\u0435 \u043F\u043E \u043F\u0440\u043E\u0432\u0435\u0440\u0435\u043D\u043D\u043E\u0439 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u043E\u0439 \u0441\u0435\u0442\u043A\u0435: \u043E\u0431\u0449\u0438\u0439 BPM \u0432\u0441\u0435\u0439 \u043F\u0435\u0441\u043D\u0438 \u043D\u0435 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u0442\u0441\u044F");
      best.debug = { ...best.debug, localRhythm: true };
    }
    return best;
  }
  function levelMean(an, a, b) {
    return curveMean(an.curves.rmsDb, an.curves.rate, a, b);
  }
  function levelBefore(A, exit) {
    return Math.max(powerLevel(A, Math.max(A.audibleStart, exit - 6), Math.max(A.audibleStart + 0.1, exit - 1)), A.bodyRmsDb - 2);
  }
  function powerLevel(an, a, b, curve = an.curves.rmsDb) {
    const lo = Math.max(0, Math.floor(a * an.curves.rate));
    const hi = Math.min(curve.length, Math.ceil(b * an.curves.rate));
    const lin = linearPower(curve);
    let power = 0;
    for (let i = lo; i < hi; i++) power += lin[i];
    return hi > lo ? 10 * Math.log10(Math.max(1e-12, power / (hi - lo))) : -90;
  }
  function measuredCurves(an, from, to) {
    if (!Number.isFinite(an.curves.rate) || an.curves.rate <= 0) return false;
    const lo = Math.max(0, Math.floor(from * an.curves.rate)), hi = Math.ceil(to * an.curves.rate);
    for (const c of [an.curves.rmsDb, an.curves.lowDb, an.curves.midDb, an.curves.highDb]) {
      if (c.length < hi) return false;
      for (let i = lo; i < hi; i++) if (!Number.isFinite(c[i])) return false;
    }
    return true;
  }
  function filteredPower(an, time, gain, low, mid, high, voiceGain = 1) {
    const t0 = Math.max(an.audibleStart, time - 0.6);
    const t1 = Math.min(an.audibleEnd, time + 0.9);
    const bands2 = [an.curves.lowDb, an.curves.midDb, an.curves.highDb].map((c) => Math.pow(10, curveMean(c, an.curves.rate, t0, t1) / 10));
    const total = bands2[0] + bands2[1] + bands2[2];
    const filtered = (bands2[0] * low * low + bands2[1] * mid * mid + bands2[2] * high * high) / Math.max(1e-12, total);
    return Math.pow(10, (powerLevel(an, t0, t1) + gain) / 10) * filtered * vocalPowerRetained(an, t0, t1, voiceGain);
  }
  function bassContinuity(p, A, B) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k;
    if (p.loopA || p.debug.variant === "intro-drop" || !["beatmatch_blend", "crossfade"].includes(p.method) || ((_a = p.debug.stems) == null ? void 0 : _a.wholeDeckFade)) return p;
    const la = (_b = p.automation.find((l) => l.deck === "A" && l.lane === "low")) == null ? void 0 : _b.points, lb = (_c = p.automation.find((l) => l.deck === "B" && l.lane === "low")) == null ? void 0 : _c.points;
    if (!la || !lb) return p;
    const D = p.duration, srcA = (t) => p.aExit + integrateTempo(p.tempoA, t), srcB = (t) => p.bEntry + integrateTempo(p.tempoB, t);
    if (!measuredCurves(A, p.aExit, srcA(D)) || !measuredCurves(B, p.bEntry, Math.min(B.audibleEnd, srcB(D) + 1))) return p;
    let from = -1, to = -1;
    for (let t = 0; t <= D; t += 0.02) {
      const v = pointValue(la, t);
      if (from < 0 && v < 0.98) from = t;
      if (v <= 0.02) {
        to = t;
        break;
      }
    }
    if (from < 0 || to < 0) return p;
    const cut = (from + to) / 2, low = B.curves.lowDb, bodyB = powerLevel(B, B.audibleStart, B.audibleEnd, low);
    const bassAt = (t) => powerLevel(B, srcB(t), srcB(t) + 1, low) >= bodyB - 8;
    let at = cut;
    if (!bassAt(cut)) {
      at = null;
      for (let t = cut; t <= D - 1; t += 0.05) if (bassAt(t) && bassAt(t + 0.5)) {
        at = t;
        break;
      }
      const bars = (_e = (_d = B.beat) == null ? void 0 : _d.downbeats) != null ? _e : [];
      if (at !== null && bars.length) {
        const near = bars.map((d) => outputTimeAt(p.tempoB, d - p.bEntry, D)).filter((t) => t > cut && t < D - 0.5).reduce((best, t) => best === null || Math.abs(t - at) < Math.abs(best - at) ? t : best, null);
        if (near !== null && Math.abs(near - at) < 0.6) at = near;
      }
    }
    const led = (an, x2) => powerLevel(an, x2, x2 + 2, an.curves.lowDb) >= powerLevel(an, x2, x2 + 2) - 3;
    const beat = ((_g = (_f = B.beat) == null ? void 0 : _f.period) != null ? _g : 0.5) / pointValue(p.tempoB, at != null ? at : cut);
    const wide = p.method === "beatmatch_blend" && at !== null && led(B, srcB(at)) && ((_i = (_h = p.keyInfo) == null ? void 0 : _h.compatibility) != null ? _i : 0) >= 0.5;
    const pre = wide ? 0.35 : 0;
    const fader = p.method === "crossfade" && !p.debug.washout && at !== null && (led(A, srcA(at)) || led(B, srcB(at)));
    const width = wide ? 4 * beat : to - from, fadeWidth = clamp3(D * 0.25, 3, 5);
    if (at !== null && Math.abs(at - cut) < 0.05 && !wide && !fader) return p;
    const b0 = Math.max(pointValue(lb, 0), 0);
    const start = at === null ? D : Math.max(0, Math.min(D - width, at - width / 2)), end = Math.min(D, start + width);
    const knots = [0, ...pre ? Array.from({ length: 8 }, (_, i) => start * (i + 1) / 9) : [], ...Array.from({ length: 13 }, (_, i) => start + (end - start) * i / 12), D].filter((t, i, a) => t <= D && (!i || t > a[i - 1]));
    const x = (t) => end > start ? clamp3((t - start) / (end - start)) : t >= end ? 1 : 0;
    const bLow = (t) => t < start ? Math.max(b0, pre * Math.sin(t / start * Math.PI / 2)) : Math.max(b0, pre) + (1 - Math.max(b0, pre)) * Math.sin(x(t) * Math.PI / 2);
    let automation = p.automation.map((l) => l.lane !== "low" || l.deck === "B" && at === null ? l : lane(
      l.deck,
      "low",
      knots.map((t) => [r32(t), r32(l.deck === "A" ? at === null ? 1 : Math.cos(x(t) * Math.PI / 2) : bLow(t))])
    ));
    if (fader) {
      const gb = (_k = (_j = p.automation.find((l) => l.deck === "B" && l.lane === "gain")) == null ? void 0 : _j.points) != null ? _k : [[0, 1]];
      let bUp = 0;
      while (bUp < D && pointValue(gb, bUp) < 0.85) bUp += 0.05;
      const f0 = Math.min(at, Math.max(0, at - fadeWidth, bUp)), f1 = Math.min(D, at + fadeWidth), y = (t) => clamp3((t - f0) / Math.max(1e-3, f1 - f0));
      automation = automation.map((l) => l.deck !== "A" || l.lane !== "gain" ? l : { ...l, points: [.../* @__PURE__ */ new Set([
        ...l.points.map(([t]) => t),
        ...Array.from({ length: 13 }, (_, i) => f0 + (f1 - f0) * i / 12)
      ])].sort((a, b) => a - b).map((t) => [r32(t), r32(Math.min(pointValue(l.points, t), Math.cos(y(t) * Math.PI / 2)))]) });
    }
    return {
      ...p,
      automation,
      reasons: [...p.reasons, at === null ? "\u0431\u0430\u0441 \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430 \u0443\u0445\u043E\u0434\u0438\u0442 \u0432\u043C\u0435\u0441\u0442\u0435 \u0441 \u043D\u0438\u043C: \u0443 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u0432 \u043F\u0435\u0440\u0435\u0445\u043E\u0434\u0435 \u043D\u0435\u0442 \u0441\u0432\u043E\u0435\u0433\u043E \u0431\u0430\u0441\u0430" : fader ? "\u0431\u0430\u0441\u043E\u0432\u044B\u0435 \u0442\u0440\u0435\u043A\u0438 \u043C\u0435\u043D\u044F\u044E\u0442\u0441\u044F \u0444\u0435\u0439\u0434\u0435\u0440\u0430\u043C\u0438 \u0437\u0430 \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0441\u0435\u043A\u0443\u043D\u0434 \u0432\u043E\u043A\u0440\u0443\u0433 \u0441\u043C\u0435\u043D\u044B \u0431\u0430\u0441\u0430: \u0431\u0435\u0437 \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u044F" : wide ? "\u0431\u0430\u0441 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430 \u0432\u0445\u043E\u0434\u0438\u0442 \u0442\u0438\u0445\u043E \u0437\u0430\u0440\u0430\u043D\u0435\u0435 \u0438 \u0437\u0430\u0431\u0438\u0440\u0430\u0435\u0442 \u043D\u0438\u0437 \u0437\u0430 \u0442\u0430\u043A\u0442: \u0441\u043C\u0435\u043D\u0430 \u0431\u0438\u0442\u0430 \u043D\u0435 \u0437\u0432\u0443\u0447\u0438\u0442 \u043A\u0430\u043A \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435" : "\u0431\u0430\u0441 \u043F\u0435\u0440\u0435\u0434\u0430\u0451\u0442\u0441\u044F, \u043A\u043E\u0433\u0434\u0430 \u0443 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430 \u043F\u043E\u044F\u0432\u043B\u044F\u0435\u0442\u0441\u044F \u0441\u0432\u043E\u0439 \u0431\u0430\u0441: \u0431\u0435\u0437 \u043F\u0440\u043E\u0432\u0430\u043B\u0430"],
      debug: { ...p.debug, bassContinuity: { previousAt: r32(cut), at: at === null ? null : r32(at), width: r32(fader ? fadeWidth : width), wide, fader } }
    };
  }
  function phraseBassSwap(p, A, B) {
    var _a, _b, _c;
    if ((_a = p.debug.stems) == null ? void 0 : _a.wholeDeckFade) return p;
    if (!B.beat || !A.beat || !gridTrust(A).trusted || !gridTrust(B).trusted || B.phraseConfidence < 0.6 || B.beat.downbeatConfidence < 0.5 || A.beat.downbeatConfidence < 0.5 || p.duration < 8 || Number((_c = (_b = p.debug.drumPattern) == null ? void 0 : _b.k) != null ? _c : 0)) return p;
    const D = p.duration, original = p.swapAt;
    const value = (deck, name, t) => {
      var _a2;
      const points = (_a2 = p.automation.find((l) => l.deck === deck && l.lane === name)) == null ? void 0 : _a2.points;
      return points ? pointValue(points, t) : 1;
    };
    const candidates = B.phrases.map((source) => ({ source, time: outputTimeAt(p.tempoB, source - p.bEntry, D) })).filter((c) => c.time >= D * 0.25 && c.time <= D * 0.75 && Math.abs(c.time - original) <= Math.min(5, D * 0.25) && Math.abs(c.time - original) > B.beat.period * 0.5 && B.beat.downbeats.some((t) => Math.abs(t - c.source) < 0.035) && A.beat.downbeats.some((t) => Math.abs(t - p.aExit - integrateTempo(p.tempoA, c.time)) < 0.035)).sort((a, b) => Math.abs(a.time - original) - Math.abs(b.time - original));
    for (const c of candidates) {
      if (!measuredCurves(A, p.aExit, p.aExit + integrateTempo(p.tempoA, D)) || !measuredCurves(B, p.bEntry, p.bEntry + integrateTempo(p.tempoB, D))) continue;
      const speedB = pointValue(p.tempoB, c.time), beat = B.beat.period / speedB;
      const lowB = powerLevel(B, c.source, c.source + B.beat.period * 4, B.curves.lowDb);
      const bodyLowB = powerLevel(B, B.audibleStart, B.audibleEnd, B.curves.lowDb);
      if (lowB < bodyLowB - 5) continue;
      const newLow = (deck, t) => {
        const x = clamp3((t - c.time + beat / 2) / beat);
        return deck === "A" ? 1 - x : x;
      };
      let regression = 0, oldPeak = 0, newPeak = 0;
      const begin = Math.max(0, Math.min(c.time, original) - beat), end = Math.min(D, Math.max(c.time, original) + beat);
      for (let t = begin; t <= end; t += 0.2) {
        const estimate = (replacement) => ["A", "B"].reduce((sum, deck) => {
          var _a2;
          const an = deck === "A" ? A : B, position = (deck === "A" ? p.aExit : p.bEntry) + integrateTempo(deck === "A" ? p.tempoA : p.tempoB, t);
          return sum + value(deck, "gain", t) ** 2 * filteredPower(
            an,
            position,
            deck === "A" ? p.gainA : p.gainB,
            replacement ? newLow(deck, t) : value(deck, "low", t),
            value(deck, "mid", t),
            value(deck, "high", t),
            pointValue((_a2 = deck === "A" ? p.vocalA : p.vocalB) != null ? _a2 : [[0, 1]], t)
          );
        }, 0);
        const before = estimate(false), after = estimate(true);
        regression = Math.max(regression, 10 * Math.log10(Math.max(1e-12, before) / Math.max(1e-12, after)));
        oldPeak = Math.max(oldPeak, before);
        newPeak = Math.max(newPeak, after);
      }
      const bump = 10 * Math.log10(Math.max(1e-12, newPeak) / Math.max(1e-12, oldPeak));
      if (regression > 0.5 || bump > 0.5) continue;
      return {
        ...p,
        automation: p.automation.map((l) => l.lane !== "low" ? l : lane(
          l.deck,
          "low",
          [[0, l.deck === "A" ? 1 : 0]],
          [[r32(c.time - beat / 2), l.deck === "A" ? 1 : 0], [r32(c.time + beat / 2), l.deck === "A" ? 0 : 1]]
        )),
        reasons: [...p.reasons, "\u0431\u0430\u0441 \u043F\u0435\u0440\u0435\u0434\u0430\u0451\u0442\u0441\u044F \u043D\u0430 \u0438\u0437\u043C\u0435\u0440\u0435\u043D\u043D\u043E\u0439 \u0433\u0440\u0430\u043D\u0438\u0446\u0435 \u0444\u0440\u0430\u0437\u044B \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430: \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u044B \u0442\u043E\u0447\u043A\u0438 \u0432\u0445\u043E\u0434\u0430, \u0432\u044B\u0445\u043E\u0434\u0430 \u0438 \u043F\u0435\u0440\u0435\u0434\u0430\u0447\u0430 \u0433\u043E\u043B\u043E\u0441\u0430"],
        debug: { ...p.debug, bassSwap: { technique: "phrase-bass-swap", at: r32(c.time), sourceB: r32(c.source), previousAt: original, maxPredictedLossDb: r32(regression), maxPredictedRiseDb: r32(bump) } }
      };
    }
    return p;
  }
  function beatContinuityCost(ctx, A, B, exit, entry, nativeA, nativeB, bars, midDuck) {
    const reference = Math.min(
      levelBefore(A, exit) + ctx.gainA,
      powerLevel(B, entry + nativeB, Math.min(B.audibleEnd, entry + nativeB + 6)) + ctx.gainB
    );
    let hole = 0;
    for (let i = 1; i <= 12; i++) {
      const x = i / 12;
      let ag = cosDown(x), bg = sinUp(x), al = 1, bl = 1, am = 1, bm = 1, ah = 1, bh = 1;
      if (ctx.s.eqHandoff) {
        const fadeStart = Math.max(0.5, (bars - 2) / bars);
        ag = x <= fadeStart ? 1 : cosDown((x - fadeStart) / (1 - fadeStart));
        bg = sinUp(clamp3(x / 0.5));
        const bass = smoothstep(clamp3((x - 0.5) * bars * 4 + 0.5));
        al = 1 - bass;
        bl = bass;
        bh = 0.25 + 0.75 * smoothstep(clamp3(x * 2));
        ah = 1 - 0.75 * smoothstep(clamp3((x - 0.5) * 2));
        const b0 = midDuck ? 0.18 : 0.4;
        bm = b0 + (1 - b0) * smoothstep(clamp3(x * 2));
        am = 1 - (midDuck ? 0.8 : 0.55) * smoothstep(clamp3((x - 0.5) / Math.min(0.5, 2 / bars)));
      }
      const stems = ctx.s.stemMixing !== false && A.vocalActivity && B.vocalActivity;
      const sum = ag * ag * filteredPower(A, exit + x * nativeA, ctx.gainA, al, am, ah, stems && x >= 0.5 ? 0 : 1) + bg * bg * filteredPower(B, entry + x * nativeB, ctx.gainB, bl, bm, bh, stems && x < 0.5 ? 0 : 1);
      hole = Math.max(hole, reference - 10 * Math.log10(Math.max(1e-12, sum)) - 2.5);
      if (ag >= 0.5 && bl < 0.5) {
        const aPos = exit + x * nativeA;
        hole = Math.max(hole, levelBefore(A, exit) - powerLevel(A, aPos - 0.75, aPos + 0.75) - 6);
      }
    }
    return clamp3(hole / 10);
  }
  function decayHandoff(A, exit, duration) {
    const reference = powerLevel(A, Math.max(A.audibleStart, exit - 6), Math.max(A.audibleStart + 0.1, exit - 2));
    for (let t = 0; t < duration * 0.75; t += 0.25) {
      if (powerLevel(A, exit + t, Math.min(A.audibleEnd, exit + t + 1.5)) < reference - 2.5) return clamp3(t, Math.min(0.65, duration * 0.2), duration * 0.75);
    }
    return duration / 2;
  }
  function loudUntil(an) {
    const rate = an.curves.rate;
    const rms = an.curves.rmsDb;
    const end = Math.min(rms.length - 1, Math.floor(an.audibleEnd * rate));
    const w = rate * 2;
    for (let i = end; i > w; i--) {
      let s = 0;
      for (let k = i - w; k < i; k++) s += rms[k];
      if (s / w >= an.bodyRmsDb - 3) return i / rate;
    }
    return an.audibleEnd;
  }
  function naturalFade(an) {
    const start = loudUntil(an);
    const length = Math.max(0, an.audibleEnd - start);
    const tail = levelMean(an, an.audibleEnd - Math.min(2, length / 2), an.audibleEnd);
    const stop = levelMean(an, start + 0.5, start + 1.5) < levelMean(an, start - 1.5, start) - 12;
    return tail < an.bodyRmsDb - 8 && length >= 3 && !stop ? { start, length } : { start: an.audibleEnd, length: 0 };
  }
  function cutScore(A, endOfBlend) {
    const cut = A.audibleEnd - endOfBlend;
    if (cut <= 2) return 1;
    const dens = curveMean(A.curves.midDensity, A.curves.rate, endOfBlend, A.audibleEnd);
    return dens < 0.18 ? clamp3(1 - cut / 45) : clamp3(1 - cut / 14);
  }
  function entrySkipCost(B, time, sung2 = false, unknownVoice = false) {
    const skipped = time - B.audibleStart;
    if (skipped < 1) return 0;
    const level2 = levelMean(B, B.audibleStart, time);
    const density2 = curveMean(B.curves.midDensity, B.curves.rate, B.audibleStart, time);
    const fullness = clamp3((level2 - B.bodyRmsDb + 12) / 12);
    const spectral = clamp3(skipped / 60) * (0.08 + 0.2 * fullness + 0.12 * clamp3(density2 / 0.4));
    return spectral + (sung2 ? 0.03 * Math.max(0, sungSeconds(B, B.audibleStart, time) - 5) : 0) + (unknownVoice ? 5e-3 * Math.max(0, skipped - 5) * clamp3((density2 / bodyDensity(B) - 0.7) / 0.3) : 0);
  }
  function sungSeconds(an, from, to) {
    const v = an.vocalActivity;
    if (!v || !(v.rate > 0)) return 0;
    const lo = Math.max(0, Math.floor(from * v.rate)), hi = Math.min(v.values.length, Math.ceil(to * v.rate));
    let sum = 0;
    for (let i = lo; i < hi; i++) if (Number.isFinite(v.values[i])) sum += clamp3((v.values[i] - 0.15) / 0.7);
    return sum / v.rate;
  }
  function voiceTooSoon(B, time, outgoingUnknown = false) {
    var _a, _b;
    if (time < B.audibleStart + 1) return false;
    const bar = ((_b = (_a = B.beat) == null ? void 0 : _a.period) != null ? _b : 0) * 4, lead = (outgoingUnknown ? clamp3(bar * 2, 4, 6) : clamp3(bar, 1.5, 3)) - 0.1;
    const first = firstVoice(B, time, Math.min(B.duration, time + lead));
    return first !== null && Number.isFinite(first);
  }
  function entryCandidates(B, s, nativeBeforeSwap = 0, nativeTotal = 0, allowMeasuredVocalLead = true, outgoingUnknown = false) {
    var _a, _b, _c;
    const len = B.audibleEnd - B.audibleStart;
    if (s.entryMode === "preserve" || s.maxEntrySkipSeconds === 0) return [{ time: B.audibleStart, score: 0.76, kind: "start", tags: ["preserve-opening"] }];
    const limit = B.audibleStart + Math.min((_a = s.maxEntrySkipSeconds) != null ? _a : 45, len * 0.45);
    let candidates = B.cues.entry.filter((c) => c.time >= B.audibleStart - 0.05 && c.time <= limit).map((c) => ({ ...c }));
    const bars = (_c = (_b = B.beat) == null ? void 0 : _b.downbeats) != null ? _c : [];
    const snap = (time) => bars.length ? bars.reduce((a, b) => Math.abs(b - time) < Math.abs(a - time) ? b : a) : time;
    const targets = [...B.sectionBoundaries, B.intro.end, ...s.stemMixing !== false ? vocalStarts(B) : []].filter((t) => t > B.audibleStart + 4 && t <= limit + nativeTotal);
    for (const target of targets) for (const lead of [0, nativeBeforeSwap, nativeTotal]) {
      const time = snap(target - lead);
      if (time < B.audibleStart - 0.03 || time > limit || candidates.some((c) => Math.abs(c.time - time) < 0.03)) continue;
      candidates.push({ time: r32(time), score: 0.68, kind: "section", tags: ["structural-arrival", `arrival:${r32(target)}`] });
    }
    const first = firstVoice(B, B.audibleStart, B.audibleEnd);
    const grid = B.beat && B.beat.stable && B.beat.confidence >= 0.45 && B.beat.period > 0 ? B.beat : null;
    const phrases = allowMeasuredVocalLead && grid && first !== null && Number.isFinite(first) ? vocalStarts(B) : [];
    if (grid && phrases.length) {
      const bar = grid.period * 4;
      for (const target of phrases) for (const count of [1, 2, 4]) {
        const time = r32(snap(target - count * bar)), lead = target - time;
        if (time < B.audibleStart - 0.03 || time > limit || lead < bar - 0.1 || lead > bar * 4 + 0.1 || firstVoice(B, time, target) !== Infinity || candidates.some((c) => Math.abs(c.time - time) < 0.03)) continue;
        candidates.push({ time, score: 1, kind: "section", tags: ["measured-vocal-lead", `lead-target:${r32(target)}`, `lead-bars:${count}`] });
      }
      const localPhrases = vocalPhrases(B).filter((p) => p.confidence >= 0.5 && candidates.some((c) => c.time >= p.start - 0.2 && c.time <= p.end + 0.2));
      if (localPhrases.length) {
        const safe = candidates.filter((c) => !localPhrases.some((p) => c.time >= p.start - 0.2 && c.time <= p.end + 0.2)).map((c) => localPhrases.some((p) => {
          const lead = p.start - c.time;
          return lead >= bar - 0.1 && lead <= bar * 4 + 0.1 && firstVoice(B, c.time, p.start) === Infinity;
        }) ? { ...c, score: Math.max(c.score, 1), tags: [...c.tags, "measured-vocal-lead"] } : c);
        candidates = safe.length ? safe : [{ time: B.audibleStart, score: 0.76, kind: "start", tags: ["measured-vocal-lead-unavailable"] }];
      }
    }
    if (allowMeasuredVocalLead && s.stemMixing !== false) candidates = candidates.filter((c) => !voiceTooSoon(B, c.time, outgoingUnknown));
    if (!candidates.length) candidates.push({ time: B.audibleStart, score: 0.6, kind: "start", tags: [] });
    else if (voiceUnknown(B, s) && !candidates.some((c) => Math.abs(c.time - B.audibleStart) < 0.05))
      candidates.push({ time: B.audibleStart, score: 0.6, kind: "start", tags: ["full-mix-start"] });
    return candidates;
  }
  function arrivalFit(B, entry, nativeBeforeSwap, nativeTotal) {
    let best = { score: 0 };
    const targets = [...B.sectionBoundaries, B.intro.end];
    for (const time of targets) {
      if (time < B.audibleStart + 3 || time < entry - 0.1) continue;
      const before = levelMean(B, Math.max(B.audibleStart, time - 6), time);
      const after = levelMean(B, time, Math.min(B.audibleEnd, time + 6));
      if (after < B.bodyRmsDb - 6 || after < before - 2) continue;
      const distance = Math.min(Math.abs(entry + nativeBeforeSwap - time), Math.abs(entry + nativeTotal - time));
      const score = (0.5 + 0.5 * clamp3((after - before) / 8)) * (1 - clamp3(distance / Math.max(3, nativeTotal * 0.35)));
      if (score > best.score) best = { score, time };
    }
    return best;
  }
  function describeEntry(p, B, cue, arrivalTime) {
    const skippedSeconds = r32(Math.max(0, p.bEntry - B.audibleStart));
    p.entrySelection = {
      kind: skippedSeconds < 1 ? "start" : cue.kind === "section" || arrivalTime !== void 0 && [...B.sectionBoundaries, B.intro.end].some((t) => Math.abs(t - arrivalTime) < 0.05) ? "section" : "intro-trim",
      skippedSeconds,
      ...arrivalTime === void 0 ? {} : { arrivalTime: r32(arrivalTime) },
      confidence: r32(clamp3(cue.score))
    };
    if (skippedSeconds >= 2) p.reasons.push(`\u0432\u0445\u043E\u0434 \u0432 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u0442\u0440\u0435\u043A \u0441 ${p.bEntry.toFixed(1)} \u0441: \u0432\u044B\u0431\u0440\u0430\u043D\u0430 \u043F\u043E\u0434\u0445\u043E\u0434\u044F\u0449\u0430\u044F \u0433\u0440\u0430\u043D\u0438\u0446\u0430 \u043F\u043E \u044D\u043D\u0435\u0440\u0433\u0438\u0438 \u0438 \u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0435`);
  }
  function voiceClash(A, B, aStart, nativeA, bStart, nativeB, duration, gains = (x) => [cosDown(x), sinUp(x)]) {
    if (!A.vocalActivity || !B.vocalActivity) return 0;
    let lost = 0;
    for (let i = 0; i < 12; i++) {
      const x = (i + 0.5) / 12;
      const [ga, gb] = gains(x);
      const a = clamp3((vocalMean(A, aStart + x * nativeA - 0.4, aStart + x * nativeA + 0.4) - 0.15) / 0.7) * ga;
      const b = clamp3((vocalMean(B, bStart + x * nativeB - 0.4, bStart + x * nativeB + 0.4) - 0.15) / 0.7) * gb;
      lost += Math.min(a, b) * duration / 12;
    }
    return lost;
  }
  function pickHandoffEntry(ctx, A, B, aStart, swap, duration, align = false) {
    var _a;
    const preserving = ctx.s.entryMode === "preserve" || ctx.s.maxEntrySkipSeconds === 0;
    const unknownA = !A.vocalActivity && !!B.vocalActivity;
    let candidates = entryCandidates(B, ctx.s, swap, duration, ctx.requestedAt === void 0, unknownA);
    const bGrid = B.beat && B.beat.stable && B.beat.confidence >= 0.45 ? B.beat : null;
    if (align && bGrid && !preserving) {
      const limit = B.audibleStart + Math.min((_a = ctx.s.maxEntrySkipSeconds) != null ? _a : 45, (B.audibleEnd - B.audibleStart) * 0.45);
      const base = candidates;
      const aligned = bGrid.downbeats.filter((t) => t - swap >= B.audibleStart - 0.01 && t - swap <= limit).map((t) => ({
        time: r32(Math.max(B.audibleStart, t - swap)),
        score: 0.68,
        kind: "downbeat",
        tags: ["handoff-downbeat"]
      }));
      const first = firstVoice(B, B.audibleStart, B.audibleEnd);
      const grid = B.beat && B.beat.stable && B.beat.confidence >= 0.45 && B.beat.period > 0 ? B.beat : null;
      const phrases = ctx.requestedAt === void 0 && ctx.s.stemMixing !== false && grid && first !== null && Number.isFinite(first) ? vocalPhrases(B).filter((p) => p.confidence >= 0.5 && base.some((c) => c.time >= p.start - 0.2 && c.time <= p.end + 0.2)) : [];
      const safeAligned = phrases.length && grid ? aligned.filter((c) => phrases.every((p) => {
        if (c.time < p.start - 0.2 || c.time > p.end + 0.2) return true;
        const lead = p.start - c.time, bar = grid.period * 4;
        return lead >= bar - 0.1 && lead <= bar * 4 + 0.1 && firstVoice(B, c.time, p.start) === Infinity;
      })) : aligned;
      candidates = ctx.requestedAt === void 0 && ctx.s.stemMixing !== false ? safeAligned.filter((c) => !voiceTooSoon(B, c.time, unknownA)) : safeAligned;
    }
    if (!candidates.length) candidates = [{ time: B.audibleStart, score: 0.6, kind: "start", tags: [] }];
    const densA = curveMean(A.curves.midDensity, A.curves.rate, aStart, aStart + Math.max(1, swap));
    let best;
    for (const cue of candidates) {
      if (cue.time + duration > B.audibleEnd - Math.min(3, (B.audibleEnd - B.audibleStart) * 0.15)) continue;
      const handoffLevel = powerLevel(B, cue.time + Math.max(0, swap - 0.5), cue.time + swap + 2);
      const bodyLevel = powerLevel(B, Math.max(B.audibleStart, B.intro.end), Math.min(B.audibleEnd, Math.max(B.intro.end + 8, B.audibleStart + 16)));
      const energyFit = 1 - clamp3(Math.abs(handoffLevel - bodyLevel) / 15);
      const outgoing = levelBefore(A, aStart) + ctx.gainA;
      const needed = Math.min(outgoing, bodyLevel + ctx.gainB);
      const holeCost = clamp3((needed - handoffLevel - ctx.gainB - 2.5) / 12);
      const densB = curveMean(B.curves.midDensity, B.curves.rate, cue.time, cue.time + Math.max(1, swap));
      const conflict = clamp3(densA * densB * 6);
      const arrival = arrivalFit(B, cue.time, swap, duration);
      const voiceScore = ctx.s.stemMixing !== false ? vocalEntryScore(A, B, aStart + swap, cue.time + swap) : 0;
      const clash = ctx.s.stemMixing !== false ? voiceClash(A, B, aStart, duration, cue.time, duration, duration) : 0;
      const unknownB = voiceUnknown(B, ctx.s);
      const score = 0.18 * cue.score + 0.35 * energyFit + 0.23 * (1 - conflict) + 0.24 * arrival.score - entrySkipCost(B, cue.time, false, unknownB) - 0.45 * holeCost + 0.18 * voiceScore - (unknownB ? 0.12 * pickupLost(B, cue.time) : 0) + (cue.tags.includes("measured-vocal-lead") ? 0.18 : 0) - Math.min(0.2, 0.02 * clash);
      const aligned = !!(bGrid == null ? void 0 : bGrid.downbeats.some((t) => Math.abs(t - cue.time - swap) < 4e-3));
      if (!best || score > best.score) best = { cue, score, arrival: arrival.time, aligned };
    }
    return best != null ? best : { cue: { time: B.audibleStart, score: 0.6, kind: "start", tags: [] }, score: 0, aligned: false };
  }
  function barPattern(g, from, to) {
    const acc = g.accents;
    if (!acc || acc.kick.length !== g.beats.length) return null;
    const down = new Set(g.downbeats.map((t) => Math.round(t * 1e3)));
    const sum = [[0, 0, 0, 0], [0, 0, 0, 0]], n = [0, 0, 0, 0];
    let pos = -1;
    g.beats.forEach((t, i) => {
      if (down.has(Math.round(t * 1e3))) pos = 0;
      else if (pos >= 0) pos = (pos + 1) % 4;
      if (pos < 0 || t < from || t >= to) return;
      sum[0][pos] += acc.kick[i];
      sum[1][pos] += acc.snare[i];
      n[pos]++;
    });
    return Math.min(...n) < 3 ? null : sum.map((f) => f.map((v, i) => v / n[i]));
  }
  function drumAlignment(a, b) {
    const mean = (v) => v.reduce((x, y) => x + y, 0) / v.length;
    const sd = (v) => {
      const m = mean(v);
      return Math.sqrt(mean(v.map((x) => (x - m) ** 2)));
    };
    const bands2 = [0, 1].filter((f) => sd(a[f]) >= 0.3 * mean(a[f]) && sd(b[f]) >= 0.3 * mean(b[f]));
    if (!bands2.length) return null;
    return [0, 1, 2, 3].map((k) => mean(bands2.map((f) => {
      const ma = mean(a[f]), mb = mean(b[f]);
      let c = 0;
      for (let i = 0; i < 4; i++) c += (a[f][i] - ma) * (b[f][(i + k) % 4] - mb);
      return c / (4 * sd(a[f]) * sd(b[f]));
    })));
  }
  var DRUM_SHIFT_MARGIN = 0.5;
  var DRUM_SHIFT_MIN = 0.3;
  function planBeatmatch(ctx, A, B, rel, keyInfo, minBars = 1) {
    var _a, _b, _c, _d, _e;
    const s = ctx.s;
    const pA = A.beat.period;
    const barA = pA * 4;
    const r5 = rel.ratio;
    const short = ctx.requestedAt !== void 0 || barA * 4 > s.maxBlendSeconds;
    const avgA = Math.abs(r5 - 1) > 1e-5 ? (1 + 1 / r5) / 2 : 1;
    const repairBars = (_a = [4, 8, 16].find((b) => b * barA / avgA >= MIN_LOCK_SECONDS - 0.01 && b * barA / avgA <= s.maxBlendSeconds + 1e-4)) != null ? _a : 4;
    const barOptions = ctx.fixed ? [ctx.fixed.bars] : ctx.vocalRepair ? [repairBars] : s.style === "tight" ? [4, 2, 1, 8] : short ? [16, 8, 4, 2, 1] : [16, 8, 4];
    const unknownA = voiceUnknown(A, s), unknownB = voiceUnknown(B, s), fullMix = unknownA || unknownB;
    const looseGrid = fullMix && [A.beat, B.beat].some((g) => g.confidence < 0.55 || g.jitterMs > 20);
    let barCap = looseGrid ? 8 : Infinity;
    if (fullMix && rel.m !== 1) {
      const pa = barPattern(A.beat, A.audibleEnd - 40, A.audibleEnd), pb = barPattern(B.beat, B.audibleStart, B.audibleStart + 40);
      const accents = pa && pb ? drumAlignment(pa, pb) : null;
      barCap = Math.min(barCap, accents === null ? 8 : accents[0] < 0.2 ? 4 : Infinity);
    }
    const keyClash = keyInfo.compatibility < 0.5;
    const phraseSet = new Set((A.phraseConfidence >= 0.2 ? A.phrases : []).map((t) => Math.round(t * 1e3)));
    const cueScore = new Map(A.cues.exit.map((c) => [Math.round(c.time * 1e3), c.score]));
    const len = A.audibleEnd - A.audibleStart;
    const exits = A.beat.downbeats.map((t, i) => ({ t, i })).filter(({ t }) => (ctx.requestedAt === void 0 ? t > Math.max(A.audibleStart + len * 0.5, A.audibleEnd - 96) : t >= ctx.requestedAt + 0.15 && t <= ctx.requestedAt + 0.15 + Math.min(3, barA + 0.02)) && t < A.audibleEnd - Math.min(barA, s.maxBlendSeconds)).map(({ t }) => {
      var _a2;
      return {
        time: t,
        score: (_a2 = cueScore.get(Math.round(t * 1e3))) != null ? _a2 : 0.4,
        kind: phraseSet.has(Math.round(t * 1e3)) ? "phrase" : "downbeat",
        tags: []
      };
    });
    const bDown = ctx.vocalRepair || ctx.fixed ? B.beat.beats : B.beat.downbeats;
    const pB = B.beat.period;
    const voices = s.stemMixing !== false && !!A.vocalActivity && !!B.vocalActivity;
    let best = null;
    const tried = [];
    const glide = Math.abs(r5 - 1) > 1e-5;
    const target = 1 / r5;
    for (const bars2 of barOptions) {
      const nativeA = bars2 * barA;
      const nativeB = nativeA * r5;
      const D2 = nativeA / avgA;
      if (D2 > s.maxBlendSeconds + 1e-4) continue;
      if (bars2 < minBars || minBars > 1 && D2 < LONG_LOCK_MIN_SECONDS) continue;
      if (bars2 > barCap && !ctx.fixed) continue;
      if (keyClash && bars2 > 8) continue;
      const entries = ctx.fixed ? [{ time: ctx.fixed.entry, score: 0.76, kind: "start", tags: ["full-mix-alternative"] }] : ctx.vocalRepair ? [{ time: ctx.vocalRepair.entry, score: 0.76, kind: "start", tags: ["preserved-vocal-repair-entry"] }] : entryCandidates(B, s, nativeB / 2, nativeB, ctx.requestedAt === void 0, !A.vocalActivity && !!B.vocalActivity);
      for (const e of exits) {
        if (ctx.vocalRepair && e.time + nativeA * 0.1 < ctx.vocalRepair.minHandoff) continue;
        if (e.time + nativeA > A.audibleEnd + 0.03) continue;
        if (ctx.fixed && Math.abs(e.time - ctx.fixed.exit) > 0.01) continue;
        if (ctx.regionA && (e.time < ctx.regionA.start - 1e-3 || e.time + nativeA > ctx.regionA.end + 1e-3)) continue;
        for (const n of entries) {
          if (!bDown.some((t) => Math.abs(t - n.time) < 0.03)) continue;
          if (n.time + nativeB > B.audibleEnd - Math.min(12, (B.audibleEnd - B.audibleStart) * 0.2)) continue;
          if (ctx.regionB && (n.time < ctx.regionB.start - 1e-3 || n.time + nativeB > ctx.regionB.end + 1e-3)) continue;
          const densA = curveMean(A.curves.midDensity, A.curves.rate, e.time, e.time + nativeA);
          const densB = curveMean(B.curves.midDensity, B.curves.rate, n.time, n.time + nativeB);
          const conflict = clamp3(densA * densB * 6);
          const dense = conflict > 0.6;
          const lockTarget = dense && !voices ? 8 : s.style === "smooth" ? 20 : 14;
          const lenPref = s.style === "tight" ? 1 - clamp3(Math.abs(Math.log2(bars2 / 4)) / 4) : 1 - clamp3(Math.max(Math.log2(lockTarget / D2) / 2, Math.log2(D2 / lockTarget) / 4)) - (short ? 0 : 0.2 * clamp3((MIN_LOCK_SECONDS - D2) / MIN_LOCK_SECONDS));
          const heardEnd = unknownA ? e.time + nativeA - (s.eqHandoff && bars2 >= 4 ? 0.4 * barA : 0.2 * nativeA) : e.time + nativeA;
          const cs = ctx.requestedAt === void 0 ? cutScore(A, heardEnd) : 1;
          const closure = ctx.requestedAt === void 0 && A.structure ? closureAt(A.structure, heardEnd) : 0;
          const localClash = fullMix ? localClashFraction(A, e.time, nativeA, B, n.time, nativeB) : 0;
          const arrival = arrivalFit(B, n.time, nativeB / 2, nativeB);
          const phraseBonus = (e.kind === "phrase" ? 0.5 : 0) + (B.phraseConfidence >= 0.2 && (n.kind === "phrase" || n.kind === "start") ? 0.5 : 0);
          const aLevel = levelMean(A, e.time, e.time + nativeA) + ctx.gainA;
          const bLevel = levelMean(B, n.time, n.time + nativeB) + ctx.gainB;
          const energyFit = 1 - clamp3(Math.abs(aLevel - bLevel) / 14);
          const continuityCost = beatContinuityCost(ctx, A, B, e.time, n.time, nativeA, nativeB, bars2, conflict > 0.35 || keyClash);
          const voiceScore = s.stemMixing !== false ? vocalEntryScore(A, B, e.time + nativeA / 2, n.time + nativeB / 2) : 0;
          const fadeStart = Math.max(0.5, (bars2 - 2) / bars2);
          const clash = s.stemMixing !== false ? voiceClash(A, B, e.time, nativeA, n.time, nativeB, D2, s.eqHandoff ? (x) => [x <= fadeStart ? 1 : cosDown((x - fadeStart) / (1 - fadeStart)), sinUp(clamp3(x / 0.5))] : void 0) : 0;
          const score = 0.1 * closure + 0.1 * e.score + 0.1 * n.score + 0.28 * cs + 0.12 * lenPref + 0.12 * (1 - conflict) + 0.11 * arrival.score + 0.08 * energyFit + 0.09 * phraseBonus - entrySkipCost(B, n.time, true, unknownB) - 0.45 * continuityCost + 0.2 * voiceScore + (n.tags.includes("measured-vocal-lead") ? 0.18 : 0) - Math.min(0.4, 0.02 * clash) - (unknownB ? 0.12 * pickupLost(B, n.time) : 0) - 0.1 * localClash;
          tried.push({ exit: e.time, entry: n.time, bars: bars2, cut: r32(A.audibleEnd - e.time - nativeA), score: r32(score), continuityCost: r32(continuityCost) });
          if (!best || score > best.score) best = { score, e, n, bars: bars2, conflict, cut: A.audibleEnd - e.time - nativeA, arrival: arrival.time, localClash };
        }
      }
    }
    if (!best) return null;
    if (!ctx.vocalRepair && !ctx.fixed && rel.m === 1) {
      const nativeA = best.bars * barA, nativeB = nativeA * r5;
      const pa = barPattern(A.beat, best.e.time, best.e.time + nativeA), pb = barPattern(B.beat, best.n.time, best.n.time + nativeB);
      const match = pa && pb ? drumAlignment(pa, pb) : null;
      if (match) {
        const k = match.indexOf(Math.max(...match)), drum = { match: match.map(r32), k: 0 };
        if (k && match[k] - match[0] >= DRUM_SHIFT_MARGIN && match[k] >= DRUM_SHIFT_MIN) {
          const preserve = s.entryMode === "preserve" || s.maxEntrySkipSeconds === 0;
          const entryLimit = B.audibleStart + (preserve ? 0 : Math.min(
            (_b = s.maxEntrySkipSeconds) != null ? _b : 45,
            (B.audibleEnd - B.audibleStart) * 0.45
          ));
          const time = (_c = [{ t: best.n.time + k * pB, move: k }, { t: best.n.time - (4 - k) * pB, move: 4 - k }].filter(({ t }) => t >= B.audibleStart && t <= entryLimit && !(ctx.requestedAt === void 0 && s.stemMixing !== false && voiceTooSoon(B, t, !A.vocalActivity)) && t + nativeB <= B.audibleEnd && (!ctx.regionB || t >= ctx.regionB.start - 1e-3 && t + nativeB <= ctx.regionB.end + 1e-3)).map((o) => ({ ...o, cost: (voices ? vocalMean(B, o.t, o.t + nativeB) : 0) + 0.01 * o.move })).sort((x, y) => x.cost - y.cost)[0]) == null ? void 0 : _c.t;
          if (time === void 0) drum.blocked = preserve ? "preserve-opening" : "no-room";
          else {
            best.n = { ...best.n, time: r32(time), tags: [...best.n.tags, `drum-shift:${k}`] };
            drum.k = k;
          }
        }
        best.drum = drum;
      }
    }
    const p = basePlan(ctx, "beatmatch_blend");
    const bars = best.bars;
    const halfBars = bars / 2;
    const D = bars * barA / avgA;
    const rA = (t) => glide ? 1 + (target - 1) * smoothstep(clamp3(t / D)) : 1;
    const tOfA = (x) => {
      let acc = 0;
      const dt = D / 400;
      for (let t = 0; t < D; t += dt) {
        const v = rA(t + dt / 2) * dt;
        if (acc + v >= x) return t + (x - acc) / v * dt;
        acc += v;
      }
      return D;
    };
    const swap = tOfA(halfBars * barA);
    const beat = pA / rA(swap);
    p.aExit = r32(best.e.time);
    p.bEntry = r32(best.n.time);
    p.duration = r32(D);
    p.swapAt = r32(swap);
    if (glide) {
      const pts = Array.from({ length: 13 }, (_, i) => D * i / 12);
      p.tempoA = pts.map((t) => [r32(t), Math.round(rA(t) * 1e6) / 1e6]);
      p.tempoB = pts.map((t, i) => [r32(t), i === 12 ? 1 : Math.round(rA(t) * r5 * 1e6) / 1e6]);
    } else {
      p.tempoB = [[0, 1]];
    }
    const barOut = (k) => tOfA(k * barA);
    const lanes = [];
    const reasons = [];
    let echoSafe = true;
    if (ctx.s.eqHandoff) {
      const fadeStart = Math.max(swap, barOut(bars - 2));
      lanes.push(lane("B", "gain", shape(0, swap, sinUp, 8)));
      lanes.push(lane("A", "gain", [[0, 1]], shape(fadeStart, D, cosDown, 8)));
      lanes.push(lane("A", "low", [[0, 1]], [[r32(swap - beat / 2), 1], [r32(swap + beat / 2), 0]]));
      lanes.push(lane("B", "low", [[0, 0]], [[r32(swap - beat / 2), 0], [r32(swap + beat / 2), 1]]));
      lanes.push(lane("B", "high", shape(0, swap, (x) => 0.25 + 0.75 * smoothstep(x))));
      lanes.push(lane("A", "high", [[0, 1]], shape(swap, D, (x) => 1 - 0.75 * smoothstep(x))));
      const midDuck = best.conflict > 0.35 || keyInfo.compatibility < 0.5 || best.localClash >= 0.5;
      const bMid0 = s.stemMixing !== false && A.vocalActivity && B.vocalActivity ? keyClash ? 0.4 : 0.7 : midDuck ? 0.18 : 0.4;
      const turns = keyClash || best.localClash >= 0.5;
      if (turns) {
        const t0 = Math.max(0, swap - beat);
        lanes.push(lane("B", "mid", [[0, bMid0]], shape(t0, Math.min(D, swap + beat), (x) => bMid0 + (1 - bMid0) * sinUp(x))));
        lanes.push(lane("A", "mid", [[0, 1]], shape(t0, Math.max(t0 + beat, Math.min(D, barOut(halfBars + 2))), (x) => 0.2 + 0.8 * cosDown(x))));
      } else {
        lanes.push(lane("B", "mid", shape(0, swap, (x) => bMid0 + (1 - bMid0) * smoothstep(x))));
        lanes.push(lane("A", "mid", [[0, 1]], shape(swap, Math.min(D, barOut(halfBars + 2)), (x) => 1 - (midDuck ? 0.8 : 0.55) * smoothstep(x))));
      }
      reasons.push("\u0431\u0430\u0441 \u043F\u043B\u0430\u0432\u043D\u043E \u043F\u0435\u0440\u0435\u0434\u0430\u0451\u0442\u0441\u044F \u043D\u0430 \u0441\u0438\u043B\u044C\u043D\u043E\u0439 \u0434\u043E\u043B\u0435 \u0432 \u0441\u0435\u0440\u0435\u0434\u0438\u043D\u0435 \u043F\u0435\u0440\u0435\u0445\u043E\u0434\u0430, \u0447\u0442\u043E\u0431\u044B \u0443\u043C\u0435\u043D\u044C\u0448\u0438\u0442\u044C \u043A\u043E\u043D\u0444\u043B\u0438\u043A\u0442 \u0431\u0430\u0441\u043E\u0432\u044B\u0445 \u043B\u0438\u043D\u0438\u0439");
      if (turns) reasons.push("\u0442\u043E\u043D\u0430\u043B\u044C\u043D\u043E\u0441\u0442\u0438 \u043A\u043E\u043D\u0444\u043B\u0438\u043A\u0442\u0443\u044E\u0442: \u0441\u0435\u0440\u0435\u0434\u0438\u043D\u0430 \u0442\u0440\u0435\u043A\u043E\u0432 \u043C\u0435\u043D\u044F\u0435\u0442\u0441\u044F \u043F\u043E \u043E\u0447\u0435\u0440\u0435\u0434\u0438 \u043D\u0430 \u0441\u043C\u0435\u043D\u0435 \u0431\u0430\u0441\u0430, \u0434\u043B\u0438\u043D\u0430 \u0441\u0432\u0435\u0434\u0435\u043D\u0438\u044F \u043D\u0435 \u0441\u043E\u043A\u0440\u0430\u0449\u0430\u0435\u0442\u0441\u044F");
      else if (midDuck) reasons.push("\u0441\u0440\u0435\u0434\u043D\u0438\u0435 \u0447\u0430\u0441\u0442\u043E\u0442\u044B \u043E\u0431\u043E\u0438\u0445 \u0442\u0440\u0435\u043A\u043E\u0432 \u043F\u043B\u043E\u0442\u043D\u044B\u0435: \u0441\u0435\u0440\u0435\u0434\u0438\u043D\u0430 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430 \u0432\u0445\u043E\u0434\u0438\u0442 \u043F\u0440\u0438\u0433\u043B\u0443\u0448\u0451\u043D\u043D\u043E\u0439");
      const exitA = best.e.time + bars * barA;
      echoSafe = !unknownA || (best.e.kind === "phrase" || !!A.structure && closureAt(A.structure, exitA) >= 0.5) && curveMean(A.curves.midDensity, A.curves.rate, exitA - barA, exitA) < 0.2;
      if (best.cut > 4 && echoSafe) {
        let delay = B.beat.period;
        while (delay < 0.3) delay *= 2;
        while (delay > 0.8) delay /= 2;
        const send = 0.5;
        p.echo = { delay: r32(delay), feedback: r32(Math.min(0.45, Math.pow(0.01 / send, delay / (unknownA ? 1.5 : 3)))) };
        lanes.push(lane("A", "echo", [[0, 0]], [[r32(barOut(bars - 1)), 0], [r32(D), send]]));
        reasons.push("\u0442\u0435\u043A\u0443\u0449\u0438\u0439 \u0442\u0440\u0435\u043A \u0443\u0445\u043E\u0434\u0438\u0442 \u0432 \u044D\u0445\u043E \u043F\u043E \u0441\u0435\u0442\u043A\u0435 \u0431\u0438\u0442\u043E\u0432: \u043F\u043E\u0432\u0442\u043E\u0440\u044B \u043B\u043E\u0436\u0430\u0442\u0441\u044F \u043D\u0430 \u0434\u043E\u043B\u0438 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430");
      }
    } else {
      lanes.push(lane("A", "gain", shape(0, D, cosDown, 12)));
      lanes.push(lane("B", "gain", shape(0, D, sinUp, 12)));
    }
    p.automation = lanes;
    const aConf = A.beat.confidence;
    const bConf = B.beat.confidence;
    const drumShift = Number((_e = (_d = best.drum) == null ? void 0 : _d.k) != null ? _e : 0);
    const phraseAligned = !drumShift && A.phraseConfidence >= 0.2 && B.phraseConfidence >= 0.2 && best.e.kind === "phrase" && (best.n.kind === "phrase" || best.n.kind === "start");
    const phraseConf = (A.phraseConfidence + B.phraseConfidence) / 2;
    p.confidence = r32(Math.sqrt(aConf * bConf) * (0.75 + 0.25 * phraseConf) * (0.75 + 0.25 * keyInfo.compatibility) * (1 - 0.3 * best.conflict));
    p.beatAlign = {
      bpmA: A.beat.bpm,
      bpmB: B.beat.bpm,
      relation: rel.m,
      ratio: Math.round(r5 * 1e5) / 1e5,
      stretchPercent: Math.round(rel.stretchPercent * 100) / 100,
      overlapBeats: bars * 4,
      phraseAligned,
      glide
    };
    p.keyInfo = keyInfo;
    const tempoText = rel.m === 1 ? `${A.beat.bpm.toFixed(1)} \u2192 ${B.beat.bpm.toFixed(1)} BPM` : `${A.beat.bpm.toFixed(1)} \u2194 ${B.beat.bpm.toFixed(1)} BPM (${rel.m === 2 ? "\u043F\u043E\u043B\u043E\u0432\u0438\u043D\u043D\u044B\u0439" : "\u0434\u0432\u043E\u0439\u043D\u043E\u0439"} \u0442\u0435\u043C\u043F)`;
    p.reasons = [
      `\u0441\u0432\u0435\u0434\u0435\u043D\u0438\u0435 \u043F\u043E \u0431\u0438\u0442\u0430\u043C \u043D\u0430 ${bars} \u0442\u0430\u043A\u0442\u043E\u0432, ${tempoText}`,
      glide ? `\u043E\u0431\u0449\u0438\u0439 \u0442\u0435\u043C\u043F \u043F\u043B\u0430\u0432\u043D\u043E \u043F\u0435\u0440\u0435\u0445\u043E\u0434\u0438\u0442 \u0441 ${A.beat.bpm.toFixed(1)} \u043D\u0430 ${(B.beat.bpm * rel.m).toFixed(1)} BPM \u0437\u0430 ${D.toFixed(0)} \u0441; \u0441\u0435\u0442\u043A\u0438 \u0431\u0438\u0442\u043E\u0432 \u0441\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u043D\u044B, \u0432\u044B\u0441\u043E\u0442\u0430 \u0442\u043E\u043D\u0430 \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u0435\u0442\u0441\u044F` : "\u0442\u0435\u043C\u043F \u0441\u043E\u0432\u043F\u0430\u0434\u0430\u0435\u0442",
      phraseAligned ? "\u0432\u0445\u043E\u0434 \u0438 \u0432\u044B\u0445\u043E\u0434 \u043D\u0430 \u0433\u0440\u0430\u043D\u0438\u0446\u0430\u0445 \u0444\u0440\u0430\u0437" : "\u0432\u044B\u0445\u043E\u0434 \u043D\u0430 \u0441\u0438\u043B\u044C\u043D\u043E\u0439 \u0434\u043E\u043B\u0435",
      best.cut > 2 ? `\u043F\u0440\u043E\u043F\u0443\u0441\u043A\u0430\u0435\u0442\u0441\u044F ${Math.round(best.cut)} \u0441 \u0444\u0438\u043D\u0430\u043B\u0430` : "\u0442\u0435\u043A\u0443\u0449\u0438\u0439 \u0442\u0440\u0435\u043A \u0437\u0432\u0443\u0447\u0438\u0442 \u0434\u043E \u043A\u043E\u043D\u0446\u0430",
      keyInfo.label,
      ...drumShift ? [`\u0440\u0438\u0441\u0443\u043D\u043E\u043A \u0443\u0434\u0430\u0440\u043D\u044B\u0445 \u0432\u044B\u0440\u043E\u0432\u043D\u0435\u043D: \u0442\u0430\u043A\u0442 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430 \u0441\u0434\u0432\u0438\u043D\u0443\u0442 \u043D\u0430 ${drumShift} ${drumShift === 1 ? "\u0434\u043E\u043B\u044E" : "\u0434\u043E\u043B\u0438"} \u043E\u0442\u043D\u043E\u0441\u0438\u0442\u0435\u043B\u044C\u043D\u043E \u043D\u0430\u0439\u0434\u0435\u043D\u043D\u043E\u0439 \u0441\u0438\u043B\u044C\u043D\u043E\u0439 \u0434\u043E\u043B\u0438, \u0431\u043E\u0447\u043A\u0430 \u0441\u043E\u0432\u043F\u0430\u0434\u0430\u0435\u0442 \u0441 \u0431\u043E\u0447\u043A\u043E\u0439, \u043C\u0430\u043B\u044B\u0439 \u0441 \u043C\u0430\u043B\u044B\u043C`] : [],
      ...reasons
    ];
    describeEntry(p, B, best.n, best.arrival);
    p.debug = {
      candidates: tried.sort((a, b) => b.score - a.score).slice(0, 40),
      candidateCount: tried.length,
      conflict: r32(best.conflict),
      score: r32(best.score),
      cut: r32(best.cut),
      ...best.drum ? { drumPattern: best.drum } : {},
      ...fullMix ? { fullMixRules: { looseGrid, barCap: Number.isFinite(barCap) ? barCap : null, localClash: r32(best.localClash), echoSafe } } : {},
      ...p.echo ? { variant: "echo-tail" } : {},
      consumedA: r32(bars * barA),
      consumedB: r32(bars * barA * r5),
      analysisLimits: ["mid-density-is-not-vocal-detection", "4/4-meter-assumed"]
    };
    return p;
  }
  function planPhraseCut(ctx, A, B, keyInfo, fallbackReason) {
    var _a, _b, _c, _d, _e;
    const pA = A.beat.period;
    const D = Math.min(0.12, pA / 4, B.beat.period / 4, ctx.s.maxBlendSeconds);
    if (D < 0.03) return null;
    const phraseSet = new Set((A.phraseConfidence >= 0.2 ? A.phrases : []).map((t) => Math.round(t * 1e3)));
    const downs = A.beat.downbeats;
    const editSpans = (_b = (_a = lyricTiming(A)) == null ? void 0 : _a.edit) != null ? _b : vocalPhrases(A).filter((p2) => p2.confidence >= 0.35).map((p2) => [p2.start, p2.end]);
    const clearVoice = (t) => !editSpans.some(([start, end]) => t + D + 0.015 > start && t - 0.015 < end);
    const minT = A.audibleStart + (A.audibleEnd - A.audibleStart) * 0.5;
    const latest = (pred) => {
      for (let i = downs.length - 1; i >= 0; i--) if (pred(downs[i], i) && downs[i] + D <= A.audibleEnd && (ctx.requestedAt === void 0 ? downs[i] > minT && A.audibleEnd - downs[i] <= 8 : downs[i] >= ctx.requestedAt + 0.15 && downs[i] <= ctx.requestedAt + 3) && (!A.vocalActivity || vocalMean(A, downs[i] - 0.2, downs[i] + 0.25) < 0.2 && clearVoice(downs[i]))) return downs[i];
      return null;
    };
    const phraseExit = latest((t) => phraseSet.has(Math.round(t * 1e3)));
    const barExit = (_c = latest((_t, i) => i % 4 === 0)) != null ? _c : latest(() => true);
    const cutOf = (t) => t === null ? Infinity : A.audibleEnd - t - D;
    const exit = phraseExit !== null && cutOf(phraseExit) <= cutOf(barExit) + 4 ? phraseExit : barExit;
    if (exit === null) return null;
    const isPhrase = phraseSet.has(Math.round(exit * 1e3));
    const selected = ctx.vocalRepair ? {
      cue: { time: ctx.vocalRepair.entry, score: 0.76, kind: "downbeat", tags: ["preserved-cut-entry"] },
      aligned: B.beat.downbeats.some((t) => Math.abs(t - ctx.vocalRepair.entry) < 0.025)
    } : pickHandoffEntry(ctx, A, B, exit, 0, D, true);
    const entry = selected.cue;
    const incomingSpans = (_e = (_d = lyricTiming(B)) == null ? void 0 : _d.edit) != null ? _e : vocalPhrases(B).filter((p2) => p2.confidence >= 0.35).map((p2) => [p2.start, p2.end]);
    if (!selected.aligned || B.beat.downbeatConfidence < 0.5 || incomingSpans.some(([a, b]) => entry.time > a + 0.025 && entry.time < b - 0.025) || powerLevel(B, entry.time, entry.time + 0.6) < B.bodyRmsDb - 6) return null;
    const rel = tempoRelation(A.beat.bpm, B.beat.bpm);
    const p = basePlan(ctx, "phrase_cut");
    const beat = pA;
    p.aExit = r32(exit);
    p.bEntry = r32(entry.time);
    p.duration = r32(D);
    p.swapAt = r32(D / 2);
    p.automation = [
      lane("B", "gain", shape(0, Math.min(0.012, D / 4), sinUp, 4)),
      lane("A", "gain", shape(0, D, (x) => Math.pow(cosDown(x), 1.4), 10)),
      // basses swap right on B's first downbeat: B's kick lands with full weight
      lane("A", "low", shape(0, Math.min(beat / 4, D), (x) => 1 - smoothstep(x), 4)),
      lane("A", "mid", [[0, 1]], shape(Math.min(beat, D / 2), D, (x) => 1 - 0.5 * smoothstep(x), 4))
    ];
    p.confidence = r32(0.45 * Math.sqrt(A.beat.confidence * B.beat.confidence) + 0.25);
    p.keyInfo = keyInfo;
    p.fallbackReason = fallbackReason;
    p.beatAlign = {
      bpmA: A.beat.bpm,
      bpmB: B.beat.bpm,
      relation: rel.m,
      ratio: 1,
      stretchPercent: 0,
      overlapBeats: Math.round(D / pA),
      phraseAligned: isPhrase
    };
    const cut = Math.max(0, A.audibleEnd - exit - D);
    p.reasons = [
      `\u0441\u043C\u0435\u043D\u0430 \u0442\u0435\u043C\u043F\u0430 \u043D\u0430 \u0441\u0438\u043B\u044C\u043D\u043E\u0439 \u0434\u043E\u043B\u0435 \u0443 \u0433\u0440\u0430\u043D\u0438\u0446\u044B ${isPhrase ? "\u0444\u0440\u0430\u0437\u044B" : "\u0442\u0430\u043A\u0442\u0430"}: \u043A\u043E\u0440\u043E\u0442\u043A\u0438\u0439 \u0441\u0440\u0435\u0437 \u0441 \u0437\u0430\u0449\u0438\u0442\u043E\u0439 \u043E\u0442 \u0449\u0435\u043B\u0447\u043A\u0430`,
      ...fallbackReason ? [fallbackReason] : [],
      cut > 2 ? `\u043F\u0440\u043E\u043F\u0443\u0441\u043A\u0430\u0435\u0442\u0441\u044F ${Math.round(cut)} \u0441 \u0444\u0438\u043D\u0430\u043B\u0430` : "\u0442\u0435\u043A\u0443\u0449\u0438\u0439 \u0442\u0440\u0435\u043A \u0437\u0432\u0443\u0447\u0438\u0442 \u043F\u043E\u0447\u0442\u0438 \u0434\u043E \u043A\u043E\u043D\u0446\u0430"
    ];
    p.debug = { cut: r32(cut), variant: "downbeat-cut" };
    describeEntry(p, B, entry);
    return p;
  }
  function planCrossfade(ctx, A, B, keyInfo, fallbackReason) {
    const fade = naturalFade(A);
    const rhythmic = A.rhythmStrength > 0.45 && B.rhythmStrength > 0.45;
    const styleK = ctx.s.style === "tight" ? 0.55 : ctx.s.style === "smooth" ? 1.3 : 1;
    const p = basePlan(ctx, "crossfade");
    const lenCap = Math.min(ctx.s.maxBlendSeconds, (A.audibleEnd - A.audibleStart) * 0.3, (B.audibleEnd - B.audibleStart) * 0.35);
    let L;
    let aGain;
    let bGain;
    let handoff;
    const reasons = [];
    if (fade.length >= 3) {
      const startIn = Math.min(Math.max(A.audibleStart, fade.start - 1), A.outro.start);
      L = Math.min(Math.max(8 * styleK, A.audibleEnd - startIn), 14 * styleK, lenCap);
      p.aExit = r32(Math.max(A.audibleStart, A.audibleEnd - L));
      handoff = decayHandoff(A, p.aExit, L);
      const extra = Math.min(3.5 - handoff, Math.min(16 * styleK, lenCap) - L, p.aExit - A.audibleStart);
      if (extra > 0.25) {
        L += extra;
        p.aExit = r32(p.aExit - extra);
        handoff = decayHandoff(A, p.aExit, L);
      }
      handoff = Math.max(handoff, Math.min(3.5, L * 0.35));
      const bRise = Math.min(L, Math.max(0.3, handoff * 1.15, L * 0.5));
      const aRelease = Math.min(Math.max(handoff + 1, bRise * 0.85), L * 0.7);
      aGain = [[0, 1], [r32(aRelease), 1], ...shape(aRelease, L, cosDown, 10).slice(1)];
      bGain = shape(0, bRise, sinUp, 10);
      reasons.push("\u0442\u0435\u043A\u0443\u0449\u0438\u0439 \u0442\u0440\u0435\u043A \u0437\u0430\u0442\u0438\u0445\u0430\u0435\u0442 \u0441\u0430\u043C: \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u043D\u0430\u0440\u0430\u0441\u0442\u0430\u0435\u0442 \u0432\u043D\u0443\u0442\u0440\u0438 \u0435\u0433\u043E \u0437\u0430\u0442\u0443\u0445\u0430\u043D\u0438\u044F");
    } else {
      L = Math.min((rhythmic ? 9 : 11) * styleK, lenCap);
      const loud = loudUntil(A);
      const late = A.audibleEnd - L;
      p.aExit = r32(Math.max(A.audibleStart + (A.audibleEnd - A.audibleStart) * 0.5, A.audibleEnd - loud >= 4 ? Math.min(late, loud - L * 0.5) : late));
      aGain = shape(0, L, cosDown, 14);
      bGain = shape(0, L, sinUp, 14);
      handoff = L / 2;
      reasons.push("\u0442\u0438\u0448\u0438\u043D\u0430 \u0432 \u043D\u0430\u0447\u0430\u043B\u0435 \u0438 \u0432 \u043A\u043E\u043D\u0446\u0435 \u043E\u0431\u0440\u0435\u0437\u0430\u043D\u0430, \u043F\u0435\u0440\u0435\u0445\u043E\u0434 \u0432 \u0441\u0430\u043C\u043E\u043C \u043A\u043E\u043D\u0446\u0435 \u0442\u0440\u0435\u043A\u0430");
    }
    const selectedEntry = pickHandoffEntry(ctx, A, B, p.aExit, handoff, L);
    const cueB = selectedEntry.cue.time;
    let arrivalB;
    if (powerLevel(B, cueB, cueB + 2) < B.bodyRmsDb - 6) {
      for (let t = cueB + 0.5; t <= Math.min(B.audibleEnd - 3, cueB + L + 8); t += 0.25)
        if (powerLevel(B, t, t + 1.5) >= B.bodyRmsDb - 4 && powerLevel(B, t, t + 3) >= B.bodyRmsDb - 5) {
          arrivalB = t;
          break;
        }
    }
    const early = arrivalB === void 0 ? 0 : arrivalB - cueB - (loudUntil(A) - p.aExit) + 4;
    if (early > 0.5 && early <= 14 && L + early <= ctx.s.maxBlendSeconds && p.aExit - early >= A.audibleStart + (A.audibleEnd - A.audibleStart) * 0.5) {
      p.aExit = r32(p.aExit - early);
      L += early;
      handoff += early;
      aGain = aGain.map(([t, v], i) => i ? [r32(t + early), v] : [t, v]);
      const stop = Math.min(L, loudUntil(A) - p.aExit), r0 = Math.max(0, stop - 4);
      const ramp = (t) => t <= r0 ? 1 : t >= stop ? 0.15 : 1 - 0.85 * smoothstep((t - r0) / (stop - r0));
      aGain = [.../* @__PURE__ */ new Set([...aGain.map(([t]) => t), ...Array.from({ length: 9 }, (_, i) => r0 + (stop - r0) * i / 8)])].sort((a, b) => a - b).map((t) => [r32(t), r32(Math.min(pointValue(aGain, t), ramp(t)))]);
      reasons.push("\u043F\u0435\u0440\u0435\u0445\u043E\u0434 \u043D\u0430\u0447\u0438\u043D\u0430\u0435\u0442\u0441\u044F \u0440\u0430\u043D\u044C\u0448\u0435: \u043C\u0443\u0437\u044B\u043A\u0430 \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430 \u0434\u0435\u0440\u0436\u0438\u0442 \u0442\u0438\u0445\u043E\u0435 \u043D\u0430\u0447\u0430\u043B\u043E \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u0434\u043E \u043F\u0440\u0438\u0445\u043E\u0434\u0430 \u0435\u0433\u043E \u043E\u0441\u043D\u043E\u0432\u043D\u043E\u0439 \u0447\u0430\u0441\u0442\u0438");
    }
    p.bEntry = r32(cueB);
    p.duration = r32(L);
    p.swapAt = r32(handoff);
    p.automation = [lane("A", "gain", aGain), lane("B", "gain", bGain)];
    const washout = ctx.s.eqHandoff && rhythmic && fade.length < 3;
    if (washout) {
      p.automation.push(lane("A", "filter", [[0, 0]], shape(L * 0.3, L * 0.85, (x) => 0.7 * smoothstep(x), 12)));
      p.automation.push(lane("A", "low", [[0, 1]], shape(L * 0.25, L * 0.5, (x) => 1 - smoothstep(x), 6)));
      p.automation.push(lane("B", "low", [[0, 0]], shape(L * 0.4, L * 0.58, smoothstep, 6)));
      p.automation.push(lane("A", "high", [[0, 1]], shape(L * 0.1, L * 0.45, (x) => 1 - 0.6 * smoothstep(x), 6)));
      p.automation.push(lane("B", "high", [[0, 0.3]], shape(L * 0.35, L * 0.65, (x) => 0.3 + 0.7 * smoothstep(x), 6)));
      reasons.push("\u0443\u0445\u043E\u0434 \u0447\u0435\u0440\u0435\u0437 \u0444\u0438\u043B\u044C\u0442\u0440: \u0431\u0430\u0441 \u0438 \u0432\u0435\u0440\u0445\u0430 \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430 \u0440\u0430\u0441\u0442\u0432\u043E\u0440\u044F\u044E\u0442\u0441\u044F \u0434\u043E \u0442\u043E\u0433\u043E, \u043A\u0430\u043A \u0432\u0445\u043E\u0434\u0438\u0442 \u0440\u0438\u0442\u043C \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E");
    } else if (ctx.s.eqHandoff) {
      const handoffFrom = Math.max(0, handoff - Math.min(0.75, L * 0.08));
      const handoffTo = Math.min(L, handoff + Math.min(0.75, L * 0.08));
      p.automation.push(lane("A", "low", [[0, 1]], shape(handoffFrom, handoffTo, (x) => 1 - smoothstep(x), 4)));
      p.automation.push(lane("B", "low", [[0, 0.15]], shape(handoffFrom, handoffTo, (x) => 0.15 + 0.85 * smoothstep(x), 4)));
      const densA = curveMean(A.curves.midDensity, A.curves.rate, p.aExit, p.aExit + L);
      const densB = curveMean(B.curves.midDensity, B.curves.rate, p.bEntry, p.bEntry + L);
      const keyClash = keyInfo.compatibility < 0.3 && A.key.confidence >= 0.4 && B.key.confidence >= 0.4;
      if (densA * densB * 6 > 0.35 || keyClash) {
        p.automation.push(lane("B", "mid", [[0, 0.4]], shape(Math.max(0, handoff - L * 0.15), Math.min(L, handoff + L * 0.25), (x) => 0.4 + 0.6 * smoothstep(x), 6)));
        p.automation.push(lane("A", "mid", [[0, 1]], shape(Math.max(0, handoff - L * 0.2), Math.min(L, handoff + L * 0.2), (x) => 1 - 0.6 * smoothstep(x), 6)));
        reasons.push(keyClash && densA * densB * 6 <= 0.35 ? "\u0442\u043E\u043D\u0430\u043B\u044C\u043D\u043E\u0441\u0442\u0438 \u043A\u043E\u043D\u0444\u043B\u0438\u043A\u0442\u0443\u044E\u0442: \u0441\u0435\u0440\u0435\u0434\u0438\u043D\u0430 \u0442\u0440\u0435\u043A\u043E\u0432 \u043C\u0435\u043D\u044F\u0435\u0442\u0441\u044F \u043F\u043E \u043E\u0447\u0435\u0440\u0435\u0434\u0438, \u0430 \u043D\u0435 \u0437\u0432\u0443\u0447\u0438\u0442 \u043E\u0434\u043D\u043E\u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E" : "\u043F\u043B\u043E\u0442\u043D\u044B\u0435 \u0441\u0440\u0435\u0434\u043D\u0438\u0435 \u0447\u0430\u0441\u0442\u043E\u0442\u044B \u043C\u0435\u043D\u044F\u044E\u0442\u0441\u044F \u043F\u043E \u043E\u0447\u0435\u0440\u0435\u0434\u0438, \u0447\u0442\u043E\u0431\u044B \u0443\u043C\u0435\u043D\u044C\u0448\u0438\u0442\u044C \u043A\u043E\u043D\u0444\u043B\u0438\u043A\u0442 \u043C\u0435\u043B\u043E\u0434\u0438\u0439");
      }
      if (rhythmic) {
        p.automation.push(lane("A", "high", shape(0, Math.min(L, handoff + L * 0.1), (x) => 1 - 0.55 * smoothstep(x), 6)));
        p.automation.push(lane("B", "high", [[0, 0.45]], shape(Math.max(0, handoff - L * 0.1), Math.min(L, handoff + L * 0.5), (x) => 0.45 + 0.55 * smoothstep(x), 6)));
        reasons.push("\u0432\u0435\u0440\u0445\u0430 \u0438 \u0431\u0430\u0441 \u043C\u0435\u043D\u044F\u044E\u0442\u0441\u044F \u043F\u043E \u043E\u0447\u0435\u0440\u0435\u0434\u0438, \u0447\u0442\u043E\u0431\u044B \u0443\u043C\u0435\u043D\u044C\u0448\u0438\u0442\u044C \u043A\u043E\u043D\u0444\u043B\u0438\u043A\u0442 \u0440\u0430\u0437\u043D\u044B\u0445 \u0440\u0438\u0442\u043C\u043E\u0432");
      }
    }
    p.confidence = 0.6;
    p.keyInfo = keyInfo;
    p.fallbackReason = fallbackReason;
    p.reasons = [fade.length >= 3 ? `\u043F\u0435\u0440\u0435\u0434\u0430\u0447\u0430 \u043F\u043E \u0438\u0437\u043C\u0435\u0440\u0435\u043D\u043D\u043E\u043C\u0443 \u0437\u0430\u0442\u0443\u0445\u0430\u043D\u0438\u044E, ${L.toFixed(0)} \u0441` : `\u043F\u043B\u0430\u0432\u043D\u044B\u0439 \u043F\u0435\u0440\u0435\u0445\u043E\u0434 \u0441 \u043F\u043E\u0441\u0442\u043E\u044F\u043D\u043D\u043E\u0439 \u043C\u043E\u0449\u043D\u043E\u0441\u0442\u044C\u044E, ${L.toFixed(0)} \u0441`, ...fallbackReason ? [fallbackReason] : [], ...reasons];
    describeEntry(p, B, selectedEntry.cue, selectedEntry.arrival);
    p.debug = { naturalFade: fade.length >= 3, washout, acousticHandoff: r32(handoff), entryScore: r32(selectedEntry.score) };
    return p;
  }
  function bassArrivals(B, until) {
    const c = B.curves, low = c.lowDb;
    const sorted = low.slice(Math.floor(B.audibleStart * c.rate), Math.ceil(B.audibleEnd * c.rate)).sort((x, y) => x - y);
    if (!sorted.length) return [];
    const body = sorted[sorted.length >> 1];
    const level2 = (a, b) => powerLevel(B, a, b, low);
    const grid = B.beat && B.beat.confidence >= 0.45 ? B.beat.downbeats : [];
    const out = [];
    let runStart = null;
    for (let t = B.audibleStart; t <= Math.min(until, B.audibleEnd - 6); t += 0.25) {
      if (level2(t - 0.5, t + 0.5) < body - 10) {
        runStart != null ? runStart : runStart = t;
        continue;
      }
      if (runStart !== null && t - runStart >= 6 && level2(t, t + 4) >= body - 4) {
        let at = t - 1;
        while (at < t + 1.5 && level2(at, at + 0.25) < body - 6) at += 0.05;
        const bar = grid.find((d) => Math.abs(d - at) < 0.3);
        out.push({ start: runStart, arrival: r32(bar != null ? bar : at) });
      }
      runStart = null;
    }
    return out;
  }
  function planIntroDrop(ctx, A, B, keyInfo, fallbackReason) {
    var _a;
    const s = ctx.s;
    if (!s.eqHandoff || s.style === "tight" || ctx.requestedAt !== void 0) return null;
    const lenB = B.audibleEnd - B.audibleStart, lenA = A.audibleEnd - A.audibleStart;
    const preserving = s.entryMode === "preserve" || s.maxEntrySkipSeconds === 0;
    const limit = B.audibleStart + (preserving ? 0.5 : Math.min((_a = s.maxEntrySkipSeconds) != null ? _a : 45, lenB * 0.45));
    const tail = 2;
    const maxT = Math.min(16, s.maxBlendSeconds - tail, lenA * 0.3, lenB * 0.35);
    if (maxT < 6) return null;
    const bDowns = B.beat && B.beat.confidence >= 0.45 ? B.beat.downbeats : [];
    const aGrid = A.beat && A.beat.stable && A.beat.confidence >= 0.45 ? A.beat.downbeats : null;
    const phraseSet = new Set((A.phraseConfidence >= 0.2 ? A.phrases : []).map((t) => Math.round(t * 1e3)));
    const keyClash = keyInfo.compatibility < 0.5;
    const lanesAt = (T2, duckMid = keyClash) => {
      const L2 = T2 + tail;
      return [
        lane("B", "gain", shape(0, Math.min(4, T2 * 0.4), sinUp, 8)),
        lane("B", "low", [[0, 0]], shape(T2 - 0.4, T2 - 0.05, smoothstep, 4)),
        lane("B", "high", [[0, 0.5]], shape(T2 * 0.5, T2, (x) => 0.5 + 0.5 * smoothstep(x), 6)),
        lane("A", "gain", [[0, 1]], shape(T2 * 0.7, T2 + tail * 0.4, cosDown, 10), [[r32(L2), 0]]),
        lane("A", "low", [[0, 1]], shape(T2 * 0.65, T2 - 0.8, (x) => 1 - smoothstep(x), 6)),
        lane("A", "high", [[0, 1]], shape(T2 * 0.4, T2 * 0.85, (x) => 1 - 0.5 * smoothstep(x), 6)),
        ...duckMid ? [lane("A", "mid", [[0, 1]], shape(T2 * 0.3, T2 * 0.7, (x) => 1 - 0.5 * smoothstep(x), 6))] : []
      ];
    };
    const unknownA = voiceUnknown(A, s), unknownB = voiceUnknown(B, s);
    let best = null;
    for (const run of bassArrivals(B, limit + maxT)) {
      const entries = [run.arrival - maxT, run.arrival - 12, run.arrival - 8].map((e) => Math.max(e, run.start, B.audibleStart)).map((e) => {
        var _a2;
        return (_a2 = bDowns.find((d) => d >= e - 0.01 && d < e + 1)) != null ? _a2 : e;
      });
      for (const entry2 of new Set(entries.map(r32))) {
        const T2 = run.arrival - entry2;
        if (T2 < 6 || T2 > maxT + 0.01 || entry2 > limit) continue;
        const L2 = T2 + tail;
        let lanes = lanesAt(T2);
        const at = (deck, l, t) => {
          const x = lanes.find((q) => q.deck === deck && q.lane === l);
          return x ? pointValue(x.points, t) : 1;
        };
        const densB = unknownB ? curveMean(B.curves.midDensity, B.curves.rate, entry2, entry2 + T2) / bodyDensity(B) : 0;
        let bMuted = 0;
        if (s.stemMixing !== false && B.vocalActivity) for (let t = 0; t < T2 / 2; t += 0.25) bMuted += clamp3((vocalMean(B, entry2 + t, entry2 + t + 0.25) - 0.15) / 0.7) * at("B", "gain", t) * 0.25;
        if (bMuted > 1.5) continue;
        const drops = aGrid ? aGrid.filter((t) => t > A.audibleEnd - 60 && t <= A.audibleEnd - tail) : Array.from({ length: 120 }, (_, i) => A.audibleEnd - tail - i * 0.5);
        for (const drop of drops) {
          const exit2 = drop - T2;
          if (exit2 < A.audibleStart + lenA * 0.5) continue;
          const densA = densB >= 0.9 ? curveMean(A.curves.midDensity, A.curves.rate, exit2, exit2 + T2 * 0.7) / bodyDensity(A) : 0;
          if (unknownA && densA >= 1.1 && densB >= 1.1) continue;
          const duck = keyClash || densB >= 0.9 && densA >= 0.9;
          lanes = lanesAt(T2, duck);
          const reference = Math.min(levelBefore(A, exit2) + ctx.gainA, powerLevel(B, run.arrival, Math.min(B.audibleEnd, run.arrival + 6)) + ctx.gainB);
          let hole = 0;
          for (let i = 1; i <= 16; i++) {
            const t = L2 * i / 16;
            const stems = s.stemMixing !== false && A.vocalActivity && B.vocalActivity;
            const sum = at("A", "gain", t) ** 2 * filteredPower(A, exit2 + t, ctx.gainA, at("A", "low", t), at("A", "mid", t), at("A", "high", t), stems && t >= T2 / 2 ? 0 : 1) + at("B", "gain", t) ** 2 * filteredPower(B, entry2 + t, ctx.gainB, at("B", "low", t), at("B", "mid", t), at("B", "high", t), stems && t < T2 / 2 ? 0 : 1);
            hole = Math.max(hole, reference - 10 * Math.log10(Math.max(1e-12, sum)) - 3);
            if (at("A", "gain", t) >= 0.5) hole = Math.max(hole, levelBefore(A, exit2) - powerLevel(A, exit2 + t - 0.75, exit2 + t + 0.75) - 6);
          }
          if (hole > 3) continue;
          const cut = A.audibleEnd - drop - tail;
          const clash = s.stemMixing !== false ? voiceClash(A, B, exit2, L2, entry2, L2, L2, (x) => [at("A", "gain", x * L2), at("B", "gain", x * L2)]) : 0;
          const score = 0.45 * cutScore(A, drop + tail) - 0.5 * clamp3(hole / 10) + (phraseSet.has(Math.round(drop * 1e3)) ? 0.08 : 0) + 0.12 * (1 - clamp3(Math.abs(T2 - 12) / 8)) - entrySkipCost(B, entry2, false, unknownB) - Math.min(0.4, 0.08 * clash) - 0.1 * bMuted - 0.1 * vocalMean(A, drop - 0.3, drop + 0.2);
          if (!best || score > best.score) best = { score, exit: exit2, entry: entry2, T: T2, cut, hole, duck };
        }
      }
    }
    if (!best || best.score < 0.2) return null;
    const { exit, entry, T } = best, L = T + tail;
    const p = basePlan(ctx, "crossfade");
    p.aExit = r32(exit);
    p.bEntry = r32(entry);
    p.duration = r32(L);
    p.swapAt = r32(T);
    p.automation = lanesAt(T, best.duck);
    p.confidence = 0.65;
    p.keyInfo = keyInfo;
    p.fallbackReason = fallbackReason;
    p.reasons = [
      `\u0432\u0441\u0442\u0443\u043F\u043B\u0435\u043D\u0438\u0435 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430 \u043F\u043E\u0432\u0435\u0440\u0445 \u0440\u0438\u0442\u043C\u0430 \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E, ${T.toFixed(0)} \u0441; \u0431\u0438\u0442 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u0432\u0445\u043E\u0434\u0438\u0442, \u043A\u043E\u0433\u0434\u0430 \u0440\u0438\u0442\u043C \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0443\u0436\u0435 \u0443\u0448\u0451\u043B`,
      ...fallbackReason ? [fallbackReason] : [],
      "\u0431\u0430\u0441 \u0438 \u0432\u0435\u0440\u0445\u0430 \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430 \u0440\u0430\u0441\u0442\u0432\u043E\u0440\u044F\u044E\u0442\u0441\u044F \u0434\u043E \u0442\u043E\u0433\u043E, \u043A\u0430\u043A \u0432\u0441\u0442\u0443\u043F\u0430\u0435\u0442 \u0431\u0438\u0442 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E: \u0434\u0432\u0435 \u0431\u043E\u0447\u043A\u0438 \u043D\u0435 \u0437\u0432\u0443\u0447\u0430\u0442 \u0432\u043C\u0435\u0441\u0442\u0435",
      ...best.duck && !keyClash ? ["\u0432\u0441\u0442\u0443\u043F\u043B\u0435\u043D\u0438\u0435 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u043F\u043B\u043E\u0442\u043D\u043E\u0435, \u0433\u043E\u043B\u043E\u0441 \u0432 \u043D\u0451\u043C \u043D\u0435 \u0438\u0437\u043C\u0435\u0440\u0435\u043D: \u0441\u0435\u0440\u0435\u0434\u0438\u043D\u0430 \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0442\u0440\u0435\u043A\u0430 \u043E\u0442\u0441\u0442\u0443\u043F\u0430\u0435\u0442, \u0434\u0432\u0435 \u0432\u0435\u0434\u0443\u0449\u0438\u0435 \u043F\u0430\u0440\u0442\u0438\u0438 \u043D\u0435 \u0437\u0432\u0443\u0447\u0430\u0442 \u0432 \u043F\u043E\u043B\u043D\u0443\u044E \u0441\u0438\u043B\u0443"] : [],
      best.cut > 2 ? `\u043F\u0440\u043E\u043F\u0443\u0441\u043A\u0430\u0435\u0442\u0441\u044F ${Math.round(best.cut)} \u0441 \u0444\u0438\u043D\u0430\u043B\u0430` : "\u0442\u0435\u043A\u0443\u0449\u0438\u0439 \u0442\u0440\u0435\u043A \u0437\u0432\u0443\u0447\u0438\u0442 \u043F\u043E\u0447\u0442\u0438 \u0434\u043E \u043A\u043E\u043D\u0446\u0430"
    ];
    describeEntry(p, B, { time: entry, score: 0.7, kind: "section", tags: ["bass-arrival"] }, entry + T);
    p.debug = { washout: true, variant: "intro-drop", bassArrival: r32(entry + T), holdUntil: r32(T * 0.85), levelHole: r32(best.hole), cut: r32(best.cut), entryScore: r32(best.score) };
    return p;
  }
  function planMinimal(ctx, A, B, keyInfo, fallbackReason) {
    const p = basePlan(ctx, "gapless");
    const D = 0.03;
    p.aExit = r32(Math.min(A.duration - D, A.audibleEnd));
    p.bEntry = r32(Math.max(0, B.audibleStart - 0.02));
    p.duration = D;
    p.gap = 0.12;
    p.swapAt = D;
    p.automation = [lane("A", "gain", [[0, 1], [D, 0]])];
    p.confidence = 0.7;
    p.keyInfo = keyInfo;
    p.fallbackReason = fallbackReason;
    p.reasons = [
      "\u0440\u0435\u0437\u043A\u0438\u0439 \u0444\u0438\u043D\u0430\u043B \u0438 \u0440\u0435\u0437\u043A\u043E\u0435 \u043D\u0430\u0447\u0430\u043B\u043E: \u043D\u0430\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u0438\u0441\u043F\u043E\u0440\u0442\u0438\u043B\u043E \u0431\u044B \u043E\u0431\u0430 \u0442\u0440\u0435\u043A\u0430",
      "\u0441\u0442\u044B\u043A \u0431\u0435\u0437 \u043D\u0430\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u0441 \u043A\u043E\u0440\u043E\u0442\u043A\u043E\u0439 \u043F\u0430\u0443\u0437\u043E\u0439",
      ...fallbackReason ? [fallbackReason] : []
    ];
    return p;
  }
  function planRequestedTransition(a, b, position, settings) {
    var _a, _b, _c, _d, _e, _f, _g;
    settings = sanitizedSettings(settings);
    const now = safePosition(position, a.duration);
    if (!settings.enabled || settings.mixOnNext === false || !a.mixingAllowed || !b.mixingAllowed) return planSkip(a, b, now, settings);
    const A = a.analysis, B = b.analysis;
    const model = planTransition(a, b, { ...settings, maxBlendSeconds: Math.min(8, settings.maxBlendSeconds) }, now);
    if (model.method === "gapless") return planSkip(a, b, now, settings);
    const exit = model.aExit;
    const points = (_a = model.tempoA) != null ? _a : [[0, 1]];
    const knots = [0, ...points.map(([t]) => t).filter((t) => t > 0 && t < model.duration), model.duration];
    const value = (t) => {
      for (let i = 1; i < points.length; i++) if (t <= points[i][0]) return points[i - 1][1] + (points[i][1] - points[i - 1][1]) * (t - points[i - 1][0]) / (points[i][0] - points[i - 1][0]);
      return points[points.length - 1][1];
    };
    let consumed = 0;
    for (let i = 1; i < knots.length; i++) consumed += (knots[i] - knots[i - 1]) * (value(knots[i]) + value(knots[i - 1])) / 2;
    if (Number.isFinite(exit) && exit + consumed <= Math.min(a.duration, (_b = A == null ? void 0 : A.audibleEnd) != null ? _b : a.duration) && model.method !== "crossfade" && model.method !== "fallback_crossfade") {
      return {
        ...model,
        id: `${model.id}_request_${Math.round(now * 1e3)}`,
        aExit: r32(exit),
        reasons: ["\u043F\u0435\u0440\u0435\u0445\u043E\u0434 \u043F\u043E \u043A\u043D\u043E\u043F\u043A\u0435 \xAB\u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439\xBB: \u043D\u0430\u0447\u0438\u043D\u0430\u0435\u0442\u0441\u044F \u0443 \u0431\u043B\u0438\u0436\u0430\u0439\u0448\u0435\u0439 \u043C\u0443\u0437\u044B\u043A\u0430\u043B\u044C\u043D\u043E\u0439 \u0434\u043E\u043B\u0438", ...model.reasons.filter((r5) => !r5.includes("\u0444\u0438\u043D\u0430\u043B\u0430") && !r5.includes("\u0434\u043E \u043A\u043E\u043D\u0446\u0430"))],
        debug: { ...model.debug, requested: true, requestedAt: now }
      };
    }
    const ctx = { a, b, s: settings, gainA: normalizationGain(A, settings.loudnessTarget), gainB: normalizationGain(B, settings.loudnessTarget) };
    const p = basePlan(ctx, A && B ? "crossfade" : "fallback_crossfade");
    const D = Math.min(6, settings.maxBlendSeconds, ((_c = A == null ? void 0 : A.audibleEnd) != null ? _c : a.duration) - now - 0.08, ((_d = B == null ? void 0 : B.audibleEnd) != null ? _d : b.duration) - ((_e = B == null ? void 0 : B.audibleStart) != null ? _e : 0));
    if (D < 0.2) return planSkip(a, b, now, settings);
    p.id += `_request_${Math.round(now * 1e3)}`;
    p.aExit = r32(now + 0.08);
    p.duration = r32(D);
    p.swapAt = r32(D / 2);
    const selected = A && B ? pickHandoffEntry(ctx, A, B, p.aExit, D / 2, D) : null;
    p.bEntry = r32((_g = (_f = selected == null ? void 0 : selected.cue.time) != null ? _f : B == null ? void 0 : B.audibleStart) != null ? _g : 0);
    p.automation = [lane("A", "gain", shape(0, D, cosDown, 16)), lane("B", "gain", shape(0, D, sinUp, 16))];
    if (settings.eqHandoff) {
      p.automation.push(lane("A", "low", [[0, 1]], shape(D * 0.35, D * 0.65, (x) => 1 - smoothstep(x), 8)));
      p.automation.push(lane("B", "low", [[0, 0]], shape(D * 0.35, D * 0.65, smoothstep, 8)));
    }
    p.confidence = A && B ? 0.65 : 0.3;
    p.reasons = ["\u043F\u0435\u0440\u0435\u0445\u043E\u0434 \u043F\u043E \u043A\u043D\u043E\u043F\u043A\u0435 \xAB\u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439\xBB: \u043F\u043B\u0430\u0432\u043D\u0430\u044F \u043F\u0435\u0440\u0435\u0434\u0430\u0447\u0430 \u0438\u0437 \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u043C\u0435\u0441\u0442\u0430", `\u043D\u0430\u043B\u043E\u0436\u0435\u043D\u0438\u0435 ${D.toFixed(1)} \u0441 \u0441 \u0432\u044B\u0440\u0430\u0432\u043D\u0438\u0432\u0430\u043D\u0438\u0435\u043C \u0433\u0440\u043E\u043C\u043A\u043E\u0441\u0442\u0438`];
    if (B && selected) describeEntry(p, B, selected.cue, selected.arrival);
    p.debug = { requested: true, requestedAt: now };
    return finishPlan(p, A, B, settings, now);
  }
  function planSkip(a, b, aPosition, settings) {
    var _a, _b;
    aPosition = safePosition(aPosition, a.duration);
    const ctx = {
      a,
      b,
      s: settings,
      gainA: normalizationGain(a.analysis, settings.loudnessTarget),
      gainB: normalizationGain(b.analysis, settings.loudnessTarget)
    };
    if (!a.mixingAllowed || !b.mixingAllowed) {
      const join = planSequential(ctx, "\u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A \u043D\u0435 \u0440\u0430\u0437\u0440\u0435\u0448\u0430\u0435\u0442 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0443 \u0437\u0432\u0443\u043A\u0430: \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435 \u0431\u0435\u0437 \u043D\u0430\u043B\u043E\u0436\u0435\u043D\u0438\u044F");
      join.aExit = r32(Math.max(0, Math.min(a.duration, aPosition)));
      join.gainA = 0;
      join.gainB = 0;
      return join;
    }
    const p = basePlan(ctx, "skip_fade");
    p.id = `${p.id}_skip_${Math.round(aPosition * 10)}`;
    const B = b.analysis;
    const entry = B ? settings.entryMode === "preserve" ? B.audibleStart : (_b = (_a = B.cues.entry.find((c) => c.kind === "start")) == null ? void 0 : _a.time) != null ? _b : B.audibleStart : 0;
    const D = 0.4;
    p.aExit = r32(aPosition);
    p.bEntry = r32(Math.max(0, settings.enabled ? entry : 0));
    p.duration = D;
    p.swapAt = 0;
    p.automation = [lane("A", "gain", shape(0, D, cosDown, 6)), lane("B", "gain", shape(0, 0.12, sinUp, 4))];
    p.confidence = 1;
    p.reasons = ["\u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435 \u0432\u0440\u0443\u0447\u043D\u0443\u044E: \u0431\u044B\u0441\u0442\u0440\u043E\u0435 \u0437\u0430\u0442\u0443\u0445\u0430\u043D\u0438\u0435"];
    return p;
  }

  // apps/ios/core-entry.ts
  function planJSON(input) {
    var _a;
    const request = JSON.parse(input);
    for (const track of [request.a, request.b]) {
      if (!track || typeof track.id !== "string" || !track.id || !Number.isFinite(track.duration) || track.duration <= 0 || track.duration > 86400 || typeof track.mixingAllowed !== "boolean") throw new Error("Invalid planner track");
      (_a = track.analysis) != null ? _a : track.analysis = null;
    }
    if (request.position !== void 0 && (!Number.isFinite(request.position) || request.position < 0)) throw new Error("Invalid playback position");
    const settings = { ...DEFAULT_AUTOMIX_SETTINGS, ...request.settings };
    return JSON.stringify(request.position === void 0 ? planTransition(request.a, request.b, settings) : planRequestedTransition(request.a, request.b, request.position, settings));
  }
  return __toCommonJS(core_entry_exports);
})();
