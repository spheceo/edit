import { Stretch } from "@soundtouchjs/core";

/** WSOLA changes duration without changing pitch, like export's atempo chain. */
export function stretchAudio(channels: Float32Array<ArrayBuffer>[], sampleRate: number, speed: number) {
  if (Math.abs(speed - 1) < 1e-6) return channels;
  let remaining = speed;
  let output = channels;
  while (Math.abs(remaining - 1) > 1e-6) {
    const step = Math.max(0.5, Math.min(2, remaining));
    const length = Math.max(1, Math.round(output[0].length / step));
    const stretched = output.map(() => new Float32Array(length));
    for (let channel = 0; channel < output.length; channel += 2) {
      const left = output[channel], right = output[channel + 1] ?? left;
      // Drain the final analysis window, so a short effect or the end of a clip
      // doesn't lose its tail. Context is trimmed by the caller after stretching.
      const stereo = new Float32Array((left.length + Math.ceil(sampleRate * 0.3)) * 2);
      for (let i = 0; i < left.length; i++) { stereo[2 * i] = left[i]; stereo[2 * i + 1] = right[i]; }
      const stretch = new Stretch({ sampleRate, createBuffers: true });
      stretch.tempo = step;
      stretch.inputBuffer!.putSamples(stereo);
      stretch.process();
      const data = new Float32Array(length * 2);
      stretch.outputBuffer!.extract(data, 0, length);
      for (let i = 0; i < length; i++) {
        stretched[channel][i] = data[2 * i];
        if (channel + 1 < stretched.length) stretched[channel + 1][i] = data[2 * i + 1];
      }
      stretch.clear();
    }
    output = stretched;
    remaining /= step;
  }
  return output;
}
