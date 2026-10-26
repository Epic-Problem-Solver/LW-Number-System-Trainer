/* Copyright 2026 Epic-Problem-Solver. SPDX-License-Identifier: AGPL-3.0-only */
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    var channels = inputs[0];
    var channel = channels && channels[0];
    if (channel && channel.length) {
      var copy = new Float32Array(channel.length);
      copy.set(channel);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
