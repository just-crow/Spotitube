package com.spotitube;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

@UnstableApi
public final class PlaybackService extends MediaSessionService {
    private MediaSession session;
    private static PlaybackService active;
    private android.media.audiofx.LoudnessEnhancer enhancer;
    private int boost;
    private int audioSession;

    /** Routes PCM through the AutoLeveler (about -17 dBFS, fast-down/slow-up). */
    private static final class NormalizingRenderersFactory extends androidx.media3.exoplayer.DefaultRenderersFactory {
        NormalizingRenderersFactory(android.content.Context context) {
            super(context);
        }

        @Override protected androidx.media3.exoplayer.audio.AudioSink buildAudioSink(
            android.content.Context context, boolean enableFloatOutput, boolean enableAudioOffload) {
            return new androidx.media3.exoplayer.audio.DefaultAudioSink.Builder(context)
                .setAudioProcessors(new androidx.media3.common.audio.AudioProcessor[] { new AutoLeveler() })
                .setEnableFloatOutput(enableFloatOutput)
                .build();
        }
    }

    @Override public void onCreate() {
        super.onCreate();
        DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
            .setBufferDurationsMs(60_000, 120_000, 5_000, 15_000)
            .setPrioritizeTimeOverSizeThresholds(true)
            .build();
        ExoPlayer player = new ExoPlayer.Builder(this, new NormalizingRenderersFactory(this))
            .setLoadControl(loadControl)
            .setMediaSourceFactory(new androidx.media3.exoplayer.source.DefaultMediaSourceFactory(
                new androidx.media3.datasource.ResolvingDataSource.Factory(
                    new androidx.media3.datasource.DefaultDataSource.Factory(this), spec -> {
                        if (!"spotitube-stream".equals(spec.uri.getScheme())) return spec;
                        String id = spec.uri.getHost();
                        if (id == null || !id.matches("[A-Za-z0-9_-]{11}")) {
                            throw new java.io.IOException("Invalid video ID");
                        }
                        java.io.File file = OfflineStore.fileFor(this, id);
                        if (file != null) return spec.withUri(android.net.Uri.fromFile(file));
                        try {
                            return spec.withUri(android.net.Uri.parse(NewPipeAudioResolver.resolve(id)));
                        } catch (Exception failure) {
                            throw new java.io.IOException("Could not resolve audio", failure);
                        }
                    })))
            .build();
        player.setAudioAttributes(new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true);
        player.setHandleAudioBecomingNoisy(true);
        player.setWakeMode(C.WAKE_MODE_NETWORK);
        active = this;
        android.os.Handler handler = new android.os.Handler(player.getApplicationLooper());
        ExoPlayer.PreloadConfiguration nextTrack = new ExoPlayer.PreloadConfiguration(15_000_000);
        Runnable updatePreloading = new Runnable() {
            @Override public void run() {
                if (active != PlaybackService.this) return;
                boolean canPreload = player.isPlaying()
                    && player.getBufferedPosition() - player.getCurrentPosition() >= 30_000;
                ExoPlayer.PreloadConfiguration configuration = canPreload
                    ? nextTrack : ExoPlayer.PreloadConfiguration.DEFAULT;
                if (player.getPreloadConfiguration() != configuration) player.setPreloadConfiguration(configuration);
                handler.postDelayed(this, 500);
            }
        };
        handler.post(updatePreloading);
        player.addListener(new androidx.media3.common.Player.Listener() {
            private int attempts;

            @Override public void onMediaItemTransition(androidx.media3.common.MediaItem item, int reason) {
                attempts = 0;
            }

            @Override public void onPlayerError(androidx.media3.common.PlaybackException failure) {
                if (attempts >= 3 || failure.errorCode < 2000 || failure.errorCode >= 3000) return;
                long delay = new long[] { 1000, 3000, 8000 }[attempts++];
                handler.postDelayed(() -> {
                    if (active == PlaybackService.this && player.getPlayerError() == failure
                        && player.getPlayWhenReady()) player.prepare();
                }, delay);
            }

            @Override public void onPlaybackStateChanged(int state) {
                if (state != androidx.media3.common.Player.STATE_READY) {
                    player.setPreloadConfiguration(ExoPlayer.PreloadConfiguration.DEFAULT);
                }
            }
            @Override public void onAudioSessionIdChanged(int id) {
                audioSession = id;
                releaseEnhancer();
                applyBoost();
            }
        });
        session = new MediaSession.Builder(this, player).build();
    }

    @Override public MediaSession onGetSession(MediaSession.ControllerInfo controller) {
        return session;
    }

    static void setBoost(int millibels) {
        if (active == null) return;
        active.boost = millibels;
        active.applyBoost();
    }

    static void setNormalize(boolean enabled) {
        AutoLeveler.enabled = enabled;
    }

    private void applyBoost() {
        if (boost == 0) { releaseEnhancer(); return; }
        if (audioSession <= 0) return;
        try {
            if (enhancer == null) enhancer = new android.media.audiofx.LoudnessEnhancer(audioSession);
            enhancer.setTargetGain(boost);
            enhancer.setEnabled(true);
        } catch (RuntimeException unavailable) { releaseEnhancer(); }
    }

    private void releaseEnhancer() {
        if (enhancer != null) { enhancer.release(); enhancer = null; }
    }

    @Override public void onTaskRemoved(android.content.Intent rootIntent) {
        if (session != null) {
            session.getPlayer().pause();
            session.getPlayer().clearMediaItems();
        }
        stopSelf();
    }

    @Override public void onDestroy() {
        active = null;
        releaseEnhancer();
        session.getPlayer().release();
        session.release();
        super.onDestroy();
    }
}



