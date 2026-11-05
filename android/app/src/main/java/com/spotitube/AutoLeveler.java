package com.spotitube;

import androidx.media3.common.C;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.audio.BaseAudioProcessor;
import java.nio.ByteBuffer;

/**
 * Dynamic leveling for mixed loudness sources (YouTube uploads vary wildly).
 * Tracks a short-term RMS envelope and eases a make-up gain toward a -17 dBFS
 * target, fast down / slow up, with a hard ceiling. Not a mastering limiter —
 * it just keeps tracks from sounding dramatically quieter/louder than each other.
 */
final class AutoLeveler extends BaseAudioProcessor {
    static volatile boolean enabled = true;

    private static final float TARGET_RMS = 0.14f;   // ≈ -17 dBFS
    private static final float MAX_GAIN = 3.5f;      // +11 dB
    private static final float MIN_GAIN = 0.25f;     // -12 dB
    private static final float CEILING = 0.97f;

    private int channels = 2;
    private float envelope = TARGET_RMS;
    private float gain = 1.0f;

    @Override protected AudioProcessor.AudioFormat onConfigure(AudioProcessor.AudioFormat inputAudioFormat)
        throws AudioProcessor.UnhandledAudioFormatException {
        if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT) {
            throw new AudioProcessor.UnhandledAudioFormatException(inputAudioFormat);
        }
        channels = Math.max(1, inputAudioFormat.channelCount);
        return inputAudioFormat;
    }

    @Override protected void onFlush() {
        // Keep the current gain; a song boundary shouldn't slam the envelope.
    }

    @Override protected void onReset() {
        envelope = TARGET_RMS;
        gain = 1.0f;
    }

    @Override public void queueInput(ByteBuffer inputBuffer) {
        int bytes = inputBuffer.remaining();
        if (bytes == 0) return;
        ByteBuffer out = replaceOutputBuffer(bytes);

        if (!enabled) {
            // Bypass: bit-exact copy.
            for (int i = 0; i < bytes; i++) out.put(inputBuffer.get());
            out.flip();
            return;
        }

        // First pass: block RMS to steer the target gain.
        float sumSquares = 0f;
        int samples = bytes / 2;
        inputBuffer.mark();
        for (int i = 0; i < samples; i++) {
            short s = inputBuffer.getShort();
            float f = s / 32768f;
            sumSquares += f * f;
        }
        inputBuffer.reset();
        float rms = (float) Math.sqrt(sumSquares / Math.max(1, samples));

        // Silence: hold gain steady so noise floors don't get boosted.
        if (rms > 1e-4f) {
            envelope = envelope * 0.85f + rms * 0.15f;
        }
        float desired = envelope > 1e-4f ? TARGET_RMS / envelope : 1.0f;
        desired = Math.max(MIN_GAIN, Math.min(MAX_GAIN, desired));

        // Fast to reduce (5ms-ish), slow to raise (~300ms), per sample smoothing.
        float perSample = desired < gain ? 0.0015f : 0.00015f;
        for (int i = 0; i < samples; i++) {
            gain += (desired - gain) * perSample;
            short s = inputBuffer.getShort();
            float f = s / 32768f;
            float v = f * gain;
            if (v > CEILING) v = CEILING; else if (v < -CEILING) v = -CEILING;
            out.putShort((short) (v * 32767f));
        }
        out.flip();
    }
}
