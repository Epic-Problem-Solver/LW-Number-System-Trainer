/* Copyright 2026 Epic-Problem-Solver. SPDX-License-Identifier: AGPL-3.0-only */
import { EssentiaWASM } from 'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia-wasm.es.js';
import Essentia from 'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia.js-core.es.js';

var FRAME = 4096;
var HOP = 2048;
var SR = 44100;
var NAME_PC = {
  'C': 0, 'B#': 0,
  'C#': 1, 'Db': 1,
  'D': 2,
  'D#': 3, 'Eb': 3,
  'E': 4, 'Fb': 4,
  'F': 5, 'E#': 5,
  'F#': 6, 'Gb': 6,
  'G': 7,
  'G#': 8, 'Ab': 8,
  'A': 9,
  'A#': 10, 'Bb': 10,
  'B': 11, 'Cb': 11
};
var DIATONIC = { 0: 'maj', 2: 'min', 4: 'min', 5: 'maj', 7: 'maj', 9: 'min', 11: 'dim' };

var essentia = null;
var cancelled = Object.create(null);

function later() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

function del() {
  for (var i = 0; i < arguments.length; i++) {
    var value = arguments[i];
    if (value && typeof value.delete === 'function') {
      try { value.delete(); } catch (e) { /* already freed */ }
    }
  }
}

function vectorSize(vec) {
  if (!vec) return 0;
  if (typeof vec.size === 'function') return vec.size();
  if (typeof vec.length === 'number') return vec.length;
  return 0;
}

function vectorGet(vec, index) {
  if (typeof vec.get === 'function') return vec.get(index);
  return vec[index];
}

function copyFloat(vec) {
  var n = vectorSize(vec);
  if (!n) return new Float32Array();
  if (essentia && typeof essentia.vectorToArray === 'function' && typeof vec.size === 'function') {
    return new Float32Array(essentia.vectorToArray(vec));
  }
  var out = new Float32Array(n);
  for (var i = 0; i < n; i++) out[i] = vectorGet(vec, i);
  return out;
}

function copyStrings(vec) {
  var n = vectorSize(vec);
  var out = new Array(n);
  for (var i = 0; i < n; i++) out[i] = String(vectorGet(vec, i));
  return out;
}

function as12(arr) {
  var out = new Float32Array(12);
  if (!arr || !arr.length) return out;
  if (arr.length === 12) {
    for (var i = 0; i < 12; i++) out[i] = arr[i];
    return out;
  }
  for (var b = 0; b < 12; b++) {
    var start = Math.floor(b * arr.length / 12);
    var end = Math.floor((b + 1) * arr.length / 12);
    var sum = 0;
    var count = 0;
    for (var k = start; k < end; k++) { sum += arr[k]; count++; }
    out[b] = count ? sum / count : 0;
  }
  return out;
}

function sum12(frame) {
  var sum = 0;
  for (var i = 0; i < 12; i++) sum += frame[i] || 0;
  return sum;
}

function averageFrames(list) {
  var acc = new Float32Array(12);
  if (!list.length) return acc;
  for (var i = 0; i < list.length; i++) {
    var frame = list[i];
    for (var k = 0; k < 12; k++) acc[k] += frame[k] || 0;
  }
  for (var k = 0; k < 12; k++) acc[k] /= list.length;
  return acc;
}

function parseEngineName(name) {
  if (!name || name === 'N' || name === 'X') {
    return { rootPc: null, quality: null, name: 'N' };
  }
  var text = String(name).trim();
  var quality = 'maj';
  var root = text;
  if (text.length > 1 && text.charAt(text.length - 1) === 'm') {
    quality = 'min';
    root = text.slice(0, -1);
  }
  if (!Object.prototype.hasOwnProperty.call(NAME_PC, root)) {
    return { rootPc: null, quality: null, name: 'N' };
  }
  return { rootPc: NAME_PC[root], quality: quality, name: text };
}

function nameToPc(name) {
  var root = String(name || '').trim().split(/\s+/)[0];
  if (Object.prototype.hasOwnProperty.call(NAME_PC, root)) return NAME_PC[root];
  return null;
}

function normMode(scale) {
  return String(scale || '').toLowerCase().indexOf('min') !== -1 ? 'minor' : 'major';
}

function isDiatonic(chord, numbering) {
  if (!chord || chord.rootPc == null || !chord.quality) return false;
  var interval = (chord.rootPc - numbering + 12) % 12;
  return DIATONIC[interval] === chord.quality;
}

function median(values) {
  if (!values.length) return 0;
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// BeatTrackerMultiFeature skips a kick at the start, then spends the first
// bar locking on. Project the steady tempo back over that prefix so the
// first bar line sits on the first chord instead of one beat late.
function repairLeadingBeats(beats) {
  if (beats.length < 12) return beats;
  var intervals = [];
  for (var i = 1; i < beats.length; i++) intervals.push(beats[i] - beats[i - 1]);
  var period = median(intervals);
  if (!(period >= 0.28 && period <= 1.5)) return beats;
  var tol = period * 0.08;
  var anchor = -1;
  var limit = Math.min(beats.length - 3, 12);
  for (var i = 1; i <= limit; i++) {
    var a = beats[i] - beats[i - 1];
    var b = beats[i + 1] - beats[i];
    var c = beats[i + 2] - beats[i + 1];
    if (Math.abs(a - period) < tol && Math.abs(b - period) < tol && Math.abs(c - period) < tol) {
      anchor = i - 1;
      break;
    }
  }
  var next = beats;
  if (anchor > 0) {
    var t = beats[anchor];
    var prefix = [];
    var guard = 0;
    while (t - period > 0.04 && guard < 8) {
      t -= period;
      prefix.unshift(t);
      guard++;
    }
    if (prefix.length) next = prefix.concat(beats.slice(anchor));
  }
  var gap = next[0] - period;
  if (gap > 0.02 && gap < period * 0.55) return [gap].concat(next);
  if (next[0] > period * 0.55 && next[0] < period * 1.45) {
    var at = next[0] - period;
    if (at < 0.02) at = 0;
    if (next[0] - at > 0.2) return [at].concat(next);
  }
  return next;
}

function labelOf(event) {
  return event.rootPc == null ? 'N' : event.rootPc + ':' + event.quality;
}

function mergeShortRuns(events) {
  if (events.length < 2) return events.map(function (event) { return Object.assign({}, event); });
  var labels = events.map(labelOf);
  var runs = [];
  var i = 0;
  while (i < events.length) {
    var j = i + 1;
    while (j < events.length && labels[j] === labels[i]) j++;
    runs.push({ start: i, end: j, len: j - i });
    i = j;
  }
  var out = events.map(function (event) { return Object.assign({}, event); });
  for (var r = 0; r < runs.length; r++) {
    var run = runs[r];
    if (run.len >= 2) continue;
    var prev = r > 0 ? runs[r - 1] : null;
    var next = r + 1 < runs.length ? runs[r + 1] : null;
    var donor = null;
    if (prev && next) donor = next.len > prev.len ? next : prev;
    else donor = prev || next;
    if (!donor) continue;
    var src = events[donor.start];
    for (var k = run.start; k < run.end; k++) {
      out[k].rootPc = src.rootPc;
      out[k].quality = src.quality;
      out[k].name = src.name;
    }
  }
  return out;
}

function framesBetween(frames, times, t0, t1) {
  var list = [];
  for (var i = 0; i < times.length; i++) {
    if (times[i] >= t0 && times[i] < t1) list.push(frames[i]);
  }
  return list;
}

function estimateKey(mean) {
  if (sum12(mean) < 0.05) return null;
  var vec = essentia.arrayToVector(mean);
  var out;
  try {
    out = essentia.Key(vec, 4, 12, 'bgate', 0.6, false, true, true);
  } catch (e) {
    console.log('key call failed', e && e.message ? e.message : e);
    return null;
  } finally {
    del(vec);
  }
  var keyName = out && out.key != null ? String(out.key) : '';
  var mode = normMode(out && out.scale);
  var pc = nameToPc(keyName);
  var strength = Number(out && out.strength);
  if (!isFinite(strength)) strength = 0;
  if (pc == null) {
    console.log('unparsed key', keyName, out && out.scale);
    return null;
  }
  return {
    keyName: keyName,
    mode: mode,
    tonicPc: pc,
    numberingTonicPc: mode === 'minor' ? (pc + 3) % 12 : pc,
    strength: strength
  };
}

function blankSegment(info, start, end) {
  return {
    startTime: start,
    endTime: end,
    tonicPc: info.tonicPc,
    mode: info.mode,
    numberingTonicPc: info.numberingTonicPc,
    strengthSum: info.strength,
    votes: 1,
    minorVotes: info.mode === 'minor' ? 1 : 0,
    majorVotes: info.mode === 'major' ? 1 : 0,
    confidence: info.strength,
    minorFeel: false
  };
}

function addVote(seg, info) {
  seg.strengthSum += info.strength;
  seg.votes++;
  if (info.mode === 'minor') seg.minorVotes++;
  else seg.majorVotes++;
}

function finishSegment(seg) {
  var total = seg.majorVotes + seg.minorVotes;
  if (total && seg.minorVotes / total > 0.6) {
    seg.mode = 'minor';
    seg.tonicPc = (seg.numberingTonicPc + 9) % 12;
    seg.minorFeel = true;
  } else {
    seg.mode = 'major';
    seg.tonicPc = seg.numberingTonicPc;
    seg.minorFeel = false;
  }
  seg.confidence = seg.votes ? seg.strengthSum / seg.votes : 0;
  return {
    startTime: seg.startTime,
    endTime: seg.endTime,
    tonicPc: seg.tonicPc,
    mode: seg.mode,
    numberingTonicPc: seg.numberingTonicPc,
    confidence: seg.confidence,
    minorFeel: seg.minorFeel
  };
}

function chooseBoundary(chords, first, confirmStart, beatCount, oldPc, newPc) {
  var confirmEnd = Math.min(beatCount - 1, confirmStart + 32);
  var best = null;
  var bestScore = -1;
  var start = Math.ceil(first / 4) * 4;
  for (var b = start; b <= confirmEnd; b += 4) {
    if (b <= 0) continue;
    var score = 0;
    var last = Math.min(confirmEnd, chords.length);
    for (var i = first; i < last; i++) {
      if (i < b) {
        if (isDiatonic(chords[i], oldPc)) score++;
      } else if (isDiatonic(chords[i], newPc)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  if (best == null) best = Math.max(4, start);
  return Math.min(best, beatCount - 1);
}

function detectKeySegments(frames, times, beats, chords, duration, opts) {
  var lines = [];
  var beatCount = beats.length;
  if (beatCount < opts.keyWindowBeats + opts.keyHopBeats) {
    var only = estimateKey(averageFrames(frames));
    if (!only) only = { tonicPc: 0, mode: 'major', numberingTonicPc: 0, strength: 0, keyName: 'C' };
    var seg = blankSegment(only, 0, duration);
    if (only.mode === 'minor') {
      seg.minorVotes = 1;
      seg.majorVotes = 0;
    }
    lines.push('short-file key ' + only.keyName + ' ' + only.mode + ' ' + only.strength.toFixed(3));
    return { keys: [finishSegment(seg)], lines: lines };
  }

  var hop = opts.keyHopBeats;
  var width = opts.keyWindowBeats;
  var windows = [];
  for (var s = 0; s + width <= beatCount; s += hop) {
    var t0 = beats[s];
    var t1 = (s + width < beatCount) ? beats[s + width] : beats[beatCount - 1];
    if (!(t1 > t0)) t1 = t0 + 0.5;
    var mean = averageFrames(framesBetween(frames, times, t0, t1));
    var energy = sum12(mean);
    if (energy < 0.05) {
      windows.push({ skip: true, beat: s, energy: energy });
      lines.push('key window beat ' + s + ' skip energy ' + energy.toFixed(4));
      continue;
    }
    var info = estimateKey(mean);
    if (!info) {
      windows.push({ skip: false, weak: true, beat: s, energy: energy, strength: 0 });
      lines.push('key window beat ' + s + ' no-key energy ' + energy.toFixed(3));
      continue;
    }
    info.beat = s;
    info.energy = energy;
    info.skip = false;
    windows.push(info);
    lines.push('key window beat ' + s + ' ' + info.keyName + ' ' + info.mode + ' num ' + info.numberingTonicPc + ' ' + info.strength.toFixed(3) + ' energy ' + energy.toFixed(3));
  }

  var segments = [];
  var current = null;
  var pending = null;
  for (var w = 0; w < windows.length; w++) {
    var win = windows[w];
    if (win.skip) continue;
    if (win.weak || win.strength < opts.minKeyStrength) {
      pending = null;
      continue;
    }
    if (!current) {
      current = blankSegment(win, 0, duration);
      segments.push(current);
      continue;
    }
    if (win.numberingTonicPc === current.numberingTonicPc) {
      pending = null;
      addVote(current, win);
      continue;
    }
    if (!pending || pending.numberingTonicPc !== win.numberingTonicPc) {
      pending = {
        numberingTonicPc: win.numberingTonicPc,
        tonicPc: win.tonicPc,
        mode: win.mode,
        firstBeat: win.beat,
        lastBeat: win.beat,
        count: 1,
        strengthSum: win.strength,
        minorVotes: win.mode === 'minor' ? 1 : 0,
        majorVotes: win.mode === 'major' ? 1 : 0
      };
    } else {
      pending.count++;
      pending.lastBeat = win.beat;
      pending.strengthSum += win.strength;
      if (win.mode === 'minor') pending.minorVotes++;
      else pending.majorVotes++;
      pending.tonicPc = win.tonicPc;
      pending.mode = win.mode;
    }
    if (pending.count >= opts.minHoldWindows) {
      var boundary = chooseBoundary(chords, pending.firstBeat, pending.lastBeat, beatCount, current.numberingTonicPc, pending.numberingTonicPc);
      var at = beats[boundary];
      current.endTime = at;
      lines.push('modulation boundary beat ' + boundary + ' t ' + at.toFixed(3) + ' from ' + current.numberingTonicPc + ' to ' + pending.numberingTonicPc);
      current = {
        startTime: at,
        endTime: duration,
        tonicPc: pending.tonicPc,
        mode: pending.mode,
        numberingTonicPc: pending.numberingTonicPc,
        strengthSum: pending.strengthSum,
        votes: pending.count,
        minorVotes: pending.minorVotes,
        majorVotes: pending.majorVotes,
        confidence: 0,
        minorFeel: false
      };
      segments.push(current);
      pending = null;
    }
  }

  if (!segments.length) {
    var fallback = estimateKey(averageFrames(frames));
    if (!fallback) fallback = { tonicPc: 0, mode: 'major', numberingTonicPc: 0, strength: 0 };
    segments.push(blankSegment(fallback, 0, duration));
  }
  return { keys: segments.map(finishSegment), lines: lines };
}

function hpcpOfFrame(frame) {
  var win = essentia.Windowing(frame, false, FRAME, 'hann', 0, true);
  var winFrame = win && win.frame ? win.frame : win;
  var spec = essentia.Spectrum(winFrame, FRAME);
  var spectrum = spec && spec.spectrum ? spec.spectrum : spec;
  var peaks = essentia.SpectralPeaks(spectrum, 0, 4500, 100, 80, 'frequency', SR);
  var freqs = peaks.frequencies;
  var mags = peaks.magnitudes;
  var hpcpVec = null;
  var white = null;
  try {
    if (!freqs || vectorSize(freqs) === 0) return new Float32Array(12);
    white = essentia.SpectralWhitening(spectrum, freqs, mags, 4500, SR);
    var whiteMags = white && white.magnitudes ? white.magnitudes : white;
    var hpcp = essentia.HPCP(
      freqs, whiteMags,
      true, 500, 0, 4500, false, 80, false, 'unitMax', 440, SR, 12, 'squaredCosine', 1
    );
    hpcpVec = hpcp && hpcp.hpcp ? hpcp.hpcp : hpcp;
    return as12(copyFloat(hpcpVec));
  } finally {
    del(hpcpVec, white && white.magnitudes, freqs, mags, spectrum, winFrame);
  }
}

function collectHpcp(pcm, id) {
  var frames = essentia.FrameGenerator(pcm, FRAME, HOP);
  var n = vectorSize(frames);
  var hpcp = new Array(n);
  var times = new Array(n);
  return (async function () {
    try {
      for (var i = 0; i < n; i++) {
        if (cancelled[id]) return null;
        var frame = typeof frames.get === 'function' ? frames.get(i) : frames[i];
        hpcp[i] = hpcpOfFrame(frame);
        times[i] = i * HOP / SR;
        if (i % 40 === 0) {
          postMessage({ type: 'progress', id: id, stage: 'chords', pct: n ? i / n : 1 });
          await later();
        }
      }
      postMessage({ type: 'progress', id: id, stage: 'chords', pct: 1 });
      return { hpcp: hpcp, times: times };
    } finally {
      del(frames);
    }
  })();
}

function toVectorVector(frames) {
  var vv = new essentia.module.VectorVectorFloat();
  for (var i = 0; i < frames.length; i++) {
    var vec = essentia.arrayToVector(frames[i]);
    vv.push_back(vec);
    del(vec);
  }
  return vv;
}

function readConfidence(value) {
  if (typeof value === 'number') return value;
  if (value && typeof value.size === 'function') {
    var n = value.size();
    var num = n ? Number(value.get(0)) : 0;
    del(value);
    return isFinite(num) ? num : 0;
  }
  var num = Number(value);
  return isFinite(num) ? num : 0;
}

async function analyze(pcm, id, opts) {
  if (pcm.length < SR * 5) {
    postMessage({ type: 'error', id: id, code: 'too-short', message: 'This audio is under 5 seconds.' });
    return;
  }
  postMessage({ type: 'progress', id: id, stage: 'beats', pct: 0 });
  var signal = essentia.arrayToVector(pcm);
  var beatOut;
  try {
    beatOut = essentia.BeatTrackerMultiFeature(signal, 208, 40);
  } finally {
    del(signal);
  }
  var ticks = copyFloat(beatOut.ticks);
  var confidence = readConfidence(beatOut.confidence);
  del(beatOut.ticks);
  postMessage({ type: 'progress', id: id, stage: 'beats', pct: 1 });
  if (cancelled[id]) return;

  var beats = [];
  for (var i = 0; i < ticks.length; i++) {
    if (!beats.length || ticks[i] > beats[beats.length - 1] + 0.02) beats.push(ticks[i]);
  }
  beats = repairLeadingBeats(beats);
  if (beats.length < 4) {
    postMessage({ type: 'error', id: id, code: 'internal', message: 'No beats detected.' });
    return;
  }
  var intervals = [];
  for (var b = 1; b < beats.length; b++) intervals.push(60 / (beats[b] - beats[b - 1]));
  var bpm = median(intervals);
  var warnings = [];
  if (!(confidence >= 1.5)) warnings.push('Beat tracking unsure; bar lines may drift');

  var packed = await collectHpcp(pcm, id);
  if (!packed || cancelled[id]) return;
  if (!packed.hpcp.length) {
    postMessage({ type: 'error', id: id, code: 'internal', message: 'No audio frames to analyse.' });
    return;
  }

  var vv = toVectorVector(packed.hpcp);
  var tickVec = essentia.arrayToVector(new Float32Array(beats));
  var chordOut;
  try {
    chordOut = essentia.ChordsDetectionBeats(vv, tickVec, 'interbeat_median', HOP, SR);
  } finally {
    del(vv, tickVec);
  }
  var names = copyStrings(chordOut.chords);
  var strength = copyFloat(chordOut.strength);
  del(chordOut.chords, chordOut.strength);

  var limit = Math.min(names.length, Math.max(0, beats.length - 1));
  var events = [];
  var strengthValues = [];
  for (var c = 0; c < limit; c++) {
    var t0 = beats[c];
    var t1 = beats[c + 1];
    var mean = averageFrames(framesBetween(packed.hpcp, packed.times, t0, t1));
    var energy = sum12(mean);
    var parsed = parseEngineName(names[c]);
    var power = c < strength.length ? Number(strength[c]) : 0;
    if (!isFinite(power)) power = 0;
    strengthValues.push(power);
    if (power < opts.noChordStrength || energy < 0.05) {
      parsed = { rootPc: null, quality: null, name: 'N' };
    }
    events.push({
      t: t0,
      dur: t1 - t0,
      rootPc: parsed.rootPc,
      quality: parsed.quality,
      name: parsed.name,
      strength: power
    });
  }
  events = mergeShortRuns(events);
  postMessage({ type: 'progress', id: id, stage: 'key', pct: 0.2 });
  var duration = pcm.length / SR;
  var keyed = detectKeySegments(packed.hpcp, packed.times, beats, events, duration, opts);
  postMessage({ type: 'progress', id: id, stage: 'key', pct: 1 });

  var summaryNames = events.map(function (event) { return event.name; }).join(' ');
  console.log('bpm ' + bpm.toFixed(2) + ' confidence ' + confidence.toFixed(3) + ' beats ' + beats.length + ' chords ' + summaryNames);
  keyed.lines.forEach(function (line) { console.log(line); });

  postMessage({
    type: 'result',
    id: id,
    analysis: {
      grid: { beats: beats, bpm: bpm, confidence: confidence },
      chords: events,
      keys: keyed.keys,
      warnings: warnings,
      debugWindows: keyed.lines,
      debugStrength: {
        min: strengthValues.length ? Math.min.apply(null, strengthValues) : 0,
        max: strengthValues.length ? Math.max.apply(null, strengthValues) : 0,
        median: median(strengthValues)
      }
    }
  });
}

function provisionalName(pcm) {
  if (!pcm || pcm.length < FRAME) return 'N';
  var frames = essentia.FrameGenerator(pcm, FRAME, HOP);
  var n = vectorSize(frames);
  var hpcp = [];
  try {
    var limit = Math.min(n, 120);
    for (var i = 0; i < limit; i++) {
      var frame = typeof frames.get === 'function' ? frames.get(i) : frames[i];
      hpcp.push(hpcpOfFrame(frame));
    }
  } finally {
    del(frames);
  }
  if (!hpcp.length) return 'N';
  var vv = toVectorVector(hpcp);
  var out;
  try {
    out = essentia.ChordsDetection(vv, HOP, SR, 2);
  } finally {
    del(vv);
  }
  var names = copyStrings(out.chords);
  del(out.chords, out.strength);
  for (var k = names.length - 1; k >= 0; k--) {
    if (names[k] && names[k] !== 'N') return names[k];
  }
  return names.length ? names[names.length - 1] : 'N';
}

function boot() {
  try {
    var wasm = EssentiaWASM;
    essentia = new Essentia(wasm);
    postMessage({ type: 'ready' });
  } catch (e) {
    postMessage({ type: 'error', code: 'engine-load', message: String(e && e.message || e) });
  }
}

self.onmessage = function (ev) {
  var msg = ev.data || {};
  if (msg.type === 'cancel') {
    cancelled[msg.id] = true;
    return;
  }
  if (!essentia) {
    postMessage({ type: 'error', id: msg.id, code: 'engine-load', message: 'Analysis engine is not loaded.' });
    return;
  }
  if (msg.type === 'chunk') {
    try {
      postMessage({ type: 'provisional', id: msg.id, name: provisionalName(msg.pcm) });
    } catch (e) {
      postMessage({ type: 'provisional', id: msg.id, name: 'N' });
    }
    return;
  }
  if (msg.type === 'analyze') {
    var opts = msg.opts || {};
    analyze(msg.pcm, msg.id, {
      keyWindowBeats: opts.keyWindowBeats || 32,
      keyHopBeats: opts.keyHopBeats || 4,
      minHoldWindows: opts.minHoldWindows || 4,
      minKeyStrength: opts.minKeyStrength != null ? opts.minKeyStrength : 0.3,
      noChordStrength: opts.noChordStrength != null ? opts.noChordStrength : 0.3
    }).catch(function (e) {
      if (cancelled[msg.id]) return;
      postMessage({ type: 'error', id: msg.id, code: 'internal', message: String(e && e.message || e) });
    });
  }
};

boot();
