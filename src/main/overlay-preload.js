/**
 * Preload script for off-screen overlay BrowserWindows.
 * Intercepts Web Audio output and sends raw PCM data to the main process
 * for piping into FFmpeg.
 *
 * Only loaded when audioMode === 'template'.
 */
const { ipcRenderer } = require('electron');

// Monkey-patch AudioContext to capture audio output
const OrigAudioContext = window.AudioContext || window.webkitAudioContext;

if (OrigAudioContext) {
  const _origProto = OrigAudioContext.prototype;
  const _origCreateMediaElementSource = _origProto.createMediaElementSource;
  const _origCreateMediaStreamSource = _origProto.createMediaStreamSource;

  // We intercept by inserting a ScriptProcessorNode before the destination
  const patchedContexts = new WeakSet();

  const patchContext = (ctx) => {
    if (patchedContexts.has(ctx)) return;
    patchedContexts.add(ctx);

    const bufferSize = 4096;
    const processor = ctx.createScriptProcessor(bufferSize, 2, 2);

    // The processor captures audio flowing through it and sends PCM to main
    processor.onaudioprocess = (e) => {
      const left = e.inputBuffer.getChannelData(0);
      const right = e.inputBuffer.getChannelData(1);

      // Interleave L/R into 16-bit signed PCM (s16le)
      const samples = left.length;
      const pcm = new Int16Array(samples * 2);
      for (let i = 0; i < samples; i++) {
        // Clamp to [-1, 1] then scale to Int16 range
        pcm[i * 2] = Math.max(-1, Math.min(1, left[i])) * 0x7FFF;
        pcm[i * 2 + 1] = Math.max(-1, Math.min(1, right[i])) * 0x7FFF;
      }

      ipcRenderer.send('overlay-audio-data', Buffer.from(pcm.buffer));

      // Pass through to output (even though offscreen, keeps graph alive)
      const outL = e.outputBuffer.getChannelData(0);
      const outR = e.outputBuffer.getChannelData(1);
      outL.set(left);
      outR.set(right);
    };

    // Intercept destination: patch connect() to route through our processor
    const origConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (...args) {
      if (args[0] === ctx.destination) {
        // Route: source → processor → destination
        origConnect.call(this, processor);
        origConnect.call(processor, ctx.destination);
        return args[0];
      }
      return origConnect.apply(this, args);
    };
  };

  // Patch the constructor to auto-patch each new AudioContext
  window.AudioContext = function (...args) {
    const ctx = new OrigAudioContext(...args);
    patchContext(ctx);
    return ctx;
  };
  window.AudioContext.prototype = OrigAudioContext.prototype;

  if (window.webkitAudioContext) {
    window.webkitAudioContext = window.AudioContext;
  }
}
