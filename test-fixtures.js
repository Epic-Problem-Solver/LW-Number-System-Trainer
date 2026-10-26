/* Copyright 2026 Epic-Problem-Solver. SPDX-License-Identifier: AGPL-3.0-only
   Synthetic songs for the walkthrough acceptance checks.
   Sawtooth triads, a sine bass root, and a kick on every beat. */
var FIXTURE_SR = 44100;

var FIXTURE_VOICING = {
  'G': { bass: 43, triad: [55, 59, 62] },
  'D': { bass: 38, triad: [50, 54, 57] },
  'Em': { bass: 40, triad: [52, 55, 59] },
  'C': { bass: 36, triad: [48, 52, 55] },
  'A': { bass: 45, triad: [57, 61, 64] },
  'E': { bass: 40, triad: [52, 56, 59] },
  'F#m': { bass: 42, triad: [54, 57, 61] }
};

function midiFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function tonePcm(sec, freq) {
  var n = Math.floor(sec * FIXTURE_SR);
  var pcm = new Float32Array(n);
  var f = freq || 440;
  for (var i = 0; i < n; i++) pcm[i] = Math.sin(2 * Math.PI * f * i / FIXTURE_SR) * 0.2;
  return pcm;
}

function scheduleTone(ctx, type, freq, t0, dur, peak, attack) {
  var osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  var gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + attack);
  var hold = Math.max(t0 + attack + 0.01, t0 + dur - 0.03);
  gain.gain.setValueAtTime(peak, hold);
  gain.gain.linearRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.01);
}

function scheduleChord(ctx, name, t0, dur) {
  var voice = FIXTURE_VOICING[name];
  if (!voice) throw new Error('No voicing for ' + name);
  scheduleTone(ctx, 'sine', midiFreq(voice.bass), t0, dur, 0.2, 0.03);
  for (var i = 0; i < voice.triad.length; i++) {
    scheduleTone(ctx, 'sawtooth', midiFreq(voice.triad[i]), t0, dur, 0.07, 0.04);
  }
}

function scheduleKick(ctx, t0) {
  var osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, t0);
  osc.frequency.exponentialRampToValueAtTime(48, t0 + 0.08);
  var gain = ctx.createGain();
  gain.gain.setValueAtTime(0.7, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.1);

  var len = Math.floor(0.025 * FIXTURE_SR);
  var buffer = ctx.createBuffer(1, len, FIXTURE_SR);
  var data = buffer.getChannelData(0);
  for (var i = 0; i < len; i++) {
    var env = 1 - i / len;
    data[i] = (Math.random() * 2 - 1) * env * env * 0.2;
  }
  var noise = ctx.createBufferSource();
  noise.buffer = buffer;
  noise.connect(ctx.destination);
  noise.start(t0);
}

function repeatLoop(loop, times) {
  var names = [];
  for (var i = 0; i < times; i++) {
    for (var j = 0; j < loop.length; j++) names.push(loop[j]);
  }
  return names;
}

function renderBars(names, bpm) {
  var beat = 60 / bpm;
  var barDur = beat * 4;
  // A kick at sample 0 is invisible to the beat tracker, which then shifts every bar by one beat.
  var lead = beat * 0.5;
  var frames = Math.ceil((lead + names.length * barDur) * FIXTURE_SR);
  var ctx = new OfflineAudioContext(1, frames, FIXTURE_SR);
  for (var i = 0; i < names.length; i++) {
    var t0 = lead + i * barDur;
    scheduleChord(ctx, names[i], t0, barDur);
    for (var k = 0; k < 4; k++) scheduleKick(ctx, t0 + k * beat);
  }
  return ctx.startRendering().then(function (buffer) {
    return new Float32Array(buffer.getChannelData(0));
  });
}

function modulationFixture() {
  var names = repeatLoop(['G', 'D', 'Em', 'C'], 4).concat(repeatLoop(['A', 'E', 'F#m', 'D'], 4));
  return renderBars(names, 100);
}

function noModulationFixture() {
  return renderBars(repeatLoop(['D', 'G', 'D', 'A'], 6), 100);
}

function relativeMinorFixture() {
  return renderBars(repeatLoop(['Em', 'C', 'G', 'D'], 4), 100);
}

function encodeWav(pcm, sampleRate) {
  var rate = sampleRate || FIXTURE_SR;
  var n = pcm.length;
  var buffer = new ArrayBuffer(44 + n * 2);
  var view = new DataView(buffer);
  function writeStr(offset, text) {
    for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, n * 2, true);
  var offset = 44;
  for (var i = 0; i < n; i++) {
    var s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
