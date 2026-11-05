package com.spotitube;

import android.app.Activity;
import android.content.ComponentName;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.*;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import org.json.JSONArray;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String HOST = "spotitube.local";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private ListenableFuture<MediaController> connection;
    private MediaController controller;
    private WebView web;
    private AppUpdates updates;
    private boolean resumed;
    private int boostedVolume = 100;
    private static final int MUSIC = android.media.AudioManager.STREAM_MUSIC;
    private final Object queueLock = new Object();
    private final java.util.List<QueueItem> queueMeta = new java.util.ArrayList<>();
    private final ConcurrentHashMap<Integer, MediaItem> resolved = new ConcurrentHashMap<>();
    private volatile int startBase = 0;
    private volatile int currentQueueIndex = 0;
    private volatile boolean absoluteAnchored = false;
    private volatile boolean prepared = false;
    private boolean wantsPlayback;
    private volatile boolean notificationRequested;
    private volatile long startPositionMs = 0;
    private int anchoredSize = 0;
    private int resolveGeneration = 0;
    private final java.util.Set<String> retryIds = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private final ExecutorService queuePool = Executors.newFixedThreadPool(6);
    private int repeatModeValue = 0; // 0 off, 1 all, 2 one

    private static final class QueueItem {
        final String id, title, artist, key;
        QueueItem(String id, String title, String artist, String key) {
            this.id = id;
            this.title = title;
            this.artist = artist == null ? "" : artist;
            this.key = key == null || key.isEmpty() ? id + System.nanoTime() : key;
        }
        static QueueItem fromJson(JSONObject json) {
            return new QueueItem(json.optString("id"), json.optString("title"),
                json.optString("author_name", json.optString("artist")), json.optString("key"));
        }
    }

    private static MediaItem buildMediaItem(String key, String uri, String title, String artist) {
        return new MediaItem.Builder().setUri(uri).setMediaId(key)
            .setMediaMetadata(new MediaMetadata.Builder().setTitle(title).setArtist(artist).build())
            .build();
    }

    private MediaItem unresolvedItem(QueueItem item) {
        // A URL that always fails fast: playback surfaces like a resolve failure.
        return buildMediaItem(item.key, "https://spotitube.local/unavailable", item.title, item.artist);
    }

    private String resolveOne(QueueItem item) throws Exception {
        File offline = OfflineStore.fileFor(this, item.id);
        if (offline != null) return offline.toURI().toString();
        return NewPipeAudioResolver.resolve(item.id);
    }

    private android.media.AudioManager audioManager() {
        return (android.media.AudioManager) getSystemService(AUDIO_SERVICE);
    }

    private void applyBoostVolume(int percent) {
        boostedVolume = percent;
        PlaybackService.setBoost(percent > 100 ? (int)Math.round(2000 * Math.log10(percent / 100.0)) : 0);
    }

    @Override public boolean dispatchKeyEvent(android.view.KeyEvent event) {
        int key = event.getKeyCode();
        boolean up = key == android.view.KeyEvent.KEYCODE_VOLUME_UP;
        if (!up && key != android.view.KeyEvent.KEYCODE_VOLUME_DOWN) return super.dispatchKeyEvent(event);
        if (event.getAction() == android.view.KeyEvent.ACTION_DOWN && controller != null) {
            var audio = audioManager();
            if (audio.getStreamVolume(MUSIC) < audio.getStreamMaxVolume(MUSIC) && boostedVolume > 100) applyBoostVolume(100);
            if ((up && audio.getStreamVolume(MUSIC) == audio.getStreamMaxVolume(MUSIC)) || (!up && boostedVolume > 100)) {
                applyBoostVolume(up ? Math.min(300, boostedVolume + 10) : Math.max(100, boostedVolume - 10));
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    private volatile String snapshot = "{}";
    private volatile long snapshotAt;
    private int positionVersion;
    private String error = "";
    private volatile boolean resolving;
    private final android.os.Handler handler = new android.os.Handler(android.os.Looper.getMainLooper());
    private String currentKey() {
        synchronized (queueLock) {
            if (currentQueueIndex < 0 || currentQueueIndex >= queueMeta.size()) return "";
            return queueMeta.get(currentQueueIndex).key;
        }
    }
    private final Runnable poll = new Runnable() {
        @Override public void run() {
            try {
                JSONObject state = new JSONObject();
                if (controller != null) {
                    state.put("playing", controller.isPlaying());
                    state.put("time", controller.getCurrentPosition() / 1000.0);
                    state.put("duration", Math.max(0, controller.getDuration()) / 1000.0);
                    state.put("ended", controller.getPlaybackState() == Player.STATE_ENDED);
                }
                var audio = audioManager();
                int system = audio.getStreamVolume(MUSIC);
                int max = audio.getStreamMaxVolume(MUSIC);
                if (system < max && boostedVolume > 100) applyBoostVolume(100);
                state.put("volume", boostedVolume > 100 ? boostedVolume : Math.round(100f * system / Math.max(1, max)));
                state.put("key", currentKey());
                state.put("positionVersion", positionVersion);
                state.put("error", error);
                state.put("loading", resolving || (controller != null && controller.getPlaybackState() == Player.STATE_BUFFERING));
                state.put("buffered", controller == null ? 0 : controller.getBufferedPosition() / 1000.0);
                state.put("preparing", resolving);
                state.put("editableQueue", absoluteAnchored && controller != null && controller.getMediaItemCount() == queueMeta.size());
                synchronized (queueLock) {
                    state.put("index", currentQueueIndex);
                    state.put("count", queueMeta.size());
                }
                state.put("version", BuildConfig.VERSION_NAME);
                state.put("editableQueue", true);
                snapshot = state.toString();
                snapshotAt = android.os.SystemClock.elapsedRealtime();
            } catch (Exception ignored) {}
            handler.postDelayed(this, 100);
        }
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        try {
            JSONArray jobs = new JSONArray(DownloadService.snapshot(this));
            for (int i = 0; i < jobs.length(); i++) {
                String status = jobs.getJSONObject(i).optString("status");
                if (java.util.Arrays.asList("queued", "preparing", "downloading").contains(status)) {
                    startForegroundService(new android.content.Intent(this, DownloadService.class));
                    break;
                }
            }
        } catch (Exception ignored) {}
        updates = new AppUpdates(this);
        setVolumeControlStream(android.media.AudioManager.STREAM_MUSIC);
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(0xff121212);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setSupportZoom(false);
        web.getSettings().setBuiltInZoomControls(false);
        web.getSettings().setDisplayZoomControls(false);
        web.getSettings().setUseWideViewPort(true);
        web.getSettings().setLoadWithOverviewMode(false);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.addJavascriptInterface(new Bridge(), "SpotitubeAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!HOST.equals(request.getUrl().getHost())) {
                    if (request.isForMainFrame() && "https".equals(request.getUrl().getScheme())) {
                        try { startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW, request.getUrl())); }
                        catch (android.content.ActivityNotFoundException ignored) {}
                    }
                    return true;
                }
                return false;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String path = request.getUrl().getPath();
                String host = request.getUrl().getHost();
                if ("https".equals(request.getUrl().getScheme()) && ("i.ytimg.com".equals(host) || "img.youtube.com".equals(host)) && path != null && path.startsWith("/vi/")) return null;
                // Only the bundled app is served over spotitube.local. Everything
                // else (lyrics, thumbnails) must reach the real network.
                if (!HOST.equals(host)) return null;
                if (path == null) return new WebResourceResponse("text/plain", "UTF-8", null);
                if (path.equals("/")) path = "/index.html";
                if (!path.matches("/(?:index[.]html|assets/[A-Za-z0-9_.-]+)"))
                    return new WebResourceResponse("text/plain", "UTF-8", null);
                String mime = path.endsWith(".js") ? "application/javascript" : path.endsWith(".css") ? "text/css" : "text/html";
                try { return new WebResourceResponse(mime, "UTF-8", getAssets().open("web" + path)); }
                catch (java.io.IOException ignored) { return new WebResourceResponse("text/plain", "UTF-8", null); }
            }
        });
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        android.widget.FrameLayout root = new android.widget.FrameLayout(this);
        root.setBackgroundColor(0xff080808);
        root.addView(web, new android.widget.FrameLayout.LayoutParams(-1, -1));
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            androidx.core.graphics.Insets safe = insets.getInsets(
                androidx.core.view.WindowInsetsCompat.Type.systemBars()
                    | androidx.core.view.WindowInsetsCompat.Type.displayCutout()
                    | androidx.core.view.WindowInsetsCompat.Type.ime());
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return androidx.core.view.WindowInsetsCompat.CONSUMED;
        });
        setContentView(root);
        androidx.core.view.ViewCompat.requestApplyInsets(root);
        connection = new MediaController.Builder(this, new SessionToken(this, new ComponentName(this, PlaybackService.class))).buildAsync();
        connection.addListener(() -> {
            if (isDestroyed()) return;
            try {
                controller = connection.get();
                controller.addListener(new Player.Listener() {
                    @Override public void onPositionDiscontinuity(Player.PositionInfo oldPosition, Player.PositionInfo newPosition, int reason) {
                        positionVersion++;
                    }
                    @Override public void onPlayerError(androidx.media3.common.PlaybackException failure) {
                        error = "Playback failed. " + failure.getErrorCodeName();
                        resolving = false;
                    }
                    @Override public void onPlaybackStateChanged(int state) {
                        if (state == Player.STATE_READY) error = "";
                    }
                    @Override public void onMediaItemTransition(MediaItem item, int reason) {
                        if (item == null) return;
                        String key = item.mediaId;
                        synchronized (queueLock) {
                            for (int i = 0; i < queueMeta.size(); i++) {
                                if (queueMeta.get(i).key.equals(key)) { currentQueueIndex = i; break; }
                            }
                        }
                        resolving = false;
                    }
                });
                web.loadUrl("https://" + HOST + "/");
            } catch (Exception failure) { web.loadData("Unable to start Spotitube playback.", "text/plain", "UTF-8"); }
        }, this::runOnUiThread);
        handler.post(poll);
    }

    private void resolveQueueIndex(int index, int gen) {
        final QueueItem item;
        synchronized (queueLock) {
            if (index < 0 || index >= queueMeta.size()) return;
            item = queueMeta.get(index);
        }
        queuePool.execute(() -> {
            MediaItem media;
            try {
                media = buildMediaItem(item.key, resolveOne(item), item.title, item.artist);
            } catch (Exception failure) {
                android.util.Log.w("SpotQueue", "Could not resolve " + item.id, failure);
                media = null;
            }
            MediaItem result = media != null ? media : unresolvedItem(item);
            runOnUiThread(() -> {
                if (gen != resolveGeneration || isDestroyed()) return;
                resolved.put(index, result);
                anchorQueue(gen);
            });
        });
    }

    /** Re-anchor the player playlist as resolving completes. UI thread only. */
    private void anchorQueue(int gen) {
        if (gen != resolveGeneration || controller == null) return;
        final int size;
        final int base;
        synchronized (queueLock) {
            size = queueMeta.size();
            base = startBase;
        }

        // Everything resolved: upgrade to one absolute playlist anchored on the current track.
        if (resolved.size() == size) {
            if (!absoluteAnchored || anchoredSize != size) {
                java.util.List<MediaItem> all = new java.util.ArrayList<>(size);
                for (int i = 0; i < size; i++) all.add(resolved.get(i));
                int window = Math.max(0, Math.min(size - 1, currentQueueIndex));
                if (!prepared) {
                    controller.setMediaItems(all, window, startPositionMs);
                } else {
                    int offset = absoluteAnchored ? 0 : base;
                    int existingEnd = offset + controller.getMediaItemCount();
                    if (existingEnd < size) controller.addMediaItems(all.subList(existingEnd, size));
                    if (offset > 0) controller.addMediaItems(0, all.subList(0, offset));
                }
                absoluteAnchored = true;
                anchoredSize = size;
                if (!prepared) {
                    prepared = true;
                    startPositionMs = 0;
                    controller.prepare();
                    controller.setPlayWhenReady(wantsPlayback);
                }
                resolving = false;
                applyRepeat();
            }
            return;
        }

        // Progressive: contiguous run from the chosen base.
        int end = base;
        while (end < size && resolved.containsKey(end)) end++;
        if (end == base) return;
        java.util.List<MediaItem> fwd = new java.util.ArrayList<>(end - base);
        for (int i = base; i < end; i++) fwd.add(resolved.get(i));
        if (!prepared) {
            controller.setMediaItems(fwd, 0, startPositionMs);
            startPositionMs = 0;
            controller.prepare();
            controller.setPlayWhenReady(wantsPlayback);
            prepared = true;
            anchoredSize = fwd.size();
            resolving = false;
            applyRepeat();
            return;
        }
        if (fwd.size() > anchoredSize) {
            controller.addMediaItems(fwd.subList(anchoredSize, fwd.size()));
            anchoredSize = fwd.size();
            applyRepeat();
        }
    }

    /** Rebuild the playlist from current queue metadata after a manual move/remove. Keeps the playing track and position. UI thread only. */
    private void rebuildAfterEdit(String currentKey) {
        if (controller == null) return;
        final int size;
        final int base;
        final int currentIdx;
        synchronized (queueLock) {
            size = queueMeta.size();
            base = startBase;
            currentIdx = currentQueueIndex;
        }
        boolean complete = resolved.size() == size;
        java.util.List<MediaItem> list = new java.util.ArrayList<>();
        int window = -1;
        if (complete) {
            for (int i = 0; i < size; i++) list.add(resolved.get(i));
            for (int i = 0; i < list.size(); i++) if (currentKey.equals(list.get(i).mediaId)) { window = i; break; }
            if (window < 0) window = Math.max(0, Math.min(size - 1, currentIdx));
        } else {
            int end = base;
            while (end < size && resolved.containsKey(end)) end++;
            if (end == base) return;
            for (int i = base; i < end; i++) list.add(resolved.get(i));
            for (int i = 0; i < list.size(); i++) if (currentKey.equals(list.get(i).mediaId)) { window = i; break; }
            if (window < 0) window = Math.max(0, Math.min(list.size() - 1, currentIdx - base));
        }
        controller.setMediaItems(list, window, controller.getCurrentPosition());
        absoluteAnchored = complete;
        anchoredSize = list.size();
        if (!prepared) {
            prepared = true;
            startPositionMs = 0;
            controller.prepare();
            controller.setPlayWhenReady(wantsPlayback);
        }
        resolving = false;
        applyRepeat();
    }

    private int indexOfKey(String key) {
        for (int i = 0; i < queueMeta.size(); i++) if (queueMeta.get(i).key.equals(key)) return i;
        return -1;
    }

    private void adjustAfterRemoval(int index) {
        if (currentQueueIndex > index) currentQueueIndex--;
        if (startBase > index) startBase--;
        java.util.Map<Integer, MediaItem> copy = new java.util.HashMap<>();
        for (var entry : resolved.entrySet()) {
            int key = entry.getKey();
            if (key == index) continue;
            copy.put(key > index ? key - 1 : key, entry.getValue());
        }
        resolved.clear();
        resolved.putAll(copy);
    }

    /** Move (-1/+1) or remove (0) a queued entry without disturbing playback. */
    private void editQueue(String key, int direction) {
        if (key == null || direction < -1 || direction > 1) return;
        final String currentKey;
        synchronized (queueLock) {
            currentKey = currentQueueIndex >= 0 && currentQueueIndex < queueMeta.size()
                ? queueMeta.get(currentQueueIndex).key : null;
        }
        if (currentKey == null) return;
        synchronized (queueLock) {
            int index = indexOfKey(key);
            if (index < 0) return;
            if (direction == 0) {
                queueMeta.remove(index);
                adjustAfterRemoval(index);
            } else {
                int target = index + direction;
                if (target < 0 || target >= queueMeta.size()) return;
                java.util.Collections.swap(queueMeta, index, target);
                java.util.Map<Integer, MediaItem> copy = new java.util.HashMap<>(resolved);
                MediaItem first = copy.remove(index);
                MediaItem second = copy.remove(target);
                if (first != null) copy.put(target, first);
                if (second != null) copy.put(index, second);
                resolved.clear();
                resolved.putAll(copy);
                if (currentQueueIndex == index) currentQueueIndex = target;
                else if (currentQueueIndex == target) currentQueueIndex = index;
            }
        }
        runOnUiThread(() -> rebuildAfterEdit(currentKey));
    }

    private void applyRepeat() {
        if (controller == null) return;
        controller.setRepeatMode(repeatModeValue == 2 ? Player.REPEAT_MODE_ONE
            : repeatModeValue == 1 ? Player.REPEAT_MODE_ALL : Player.REPEAT_MODE_OFF);
    }

    /** A stream URL can go stale mid-queue; re-resolve the current track once before giving up. */
    private void retryCurrent() {
        final int index;
        final String id;
        final String key;
        final String title;
        final String artist;
        final int gen = resolveGeneration;
        synchronized (queueLock) {
            if (currentQueueIndex < 0 || currentQueueIndex >= queueMeta.size()) { error = "Playback failed."; return; }
            QueueItem item = queueMeta.get(currentQueueIndex);
            if (!retryIds.add(item.id + "@" + currentQueueIndex)) {
                error = "Playback failed. Stream rejected.";
                resolving = false;
                return;
            }
            index = currentQueueIndex;
            id = item.id;
            key = item.key;
            title = item.title;
            artist = item.artist;
        }
        queuePool.execute(() -> {
            MediaItem media = null;
            try {
                File offline = OfflineStore.fileFor(this, id);
                if (offline != null) media = buildMediaItem(key, offline.toURI().toString(), title, artist);
                else media = buildMediaItem(key, NewPipeAudioResolver.resolve(id), title, artist);
            } catch (Exception failure) {
                android.util.Log.w("SpotQueue", "Retry failed for " + id, failure);
            }
            MediaItem fresh = media;
            runOnUiThread(() -> {
                if (controller == null || gen != resolveGeneration) return;
                synchronized (queueLock) {
                    if (currentQueueIndex != index) return;
                }
                int window;
                synchronized (queueLock) { window = absoluteAnchored ? index : index - startBase; }
                if (fresh == null) {
                    error = "Playback failed. Stream rejected.";
                    resolving = false;
                    return;
                }
                resolved.put(index, fresh);
                try {
                    if (controller.getMediaItemCount() > window) {
                        controller.replaceMediaItem(window, fresh);
                        controller.prepare();
                        controller.setPlayWhenReady(wantsPlayback);
                        error = "";
                    }
                } catch (Exception failure) {
                    android.util.Log.w("SpotQueue", "Retry swap failed", failure);
                    error = "Playback failed. Stream rejected.";
                    resolving = false;
                }
            });
        });
    }

    private final class Bridge {
        @JavascriptInterface public void playQueue(String json, int startIndex, long startPositionMsParam) {
            runOnUiThread(() -> {
                java.util.List<QueueItem> items = new java.util.ArrayList<>();
                try {
                    JSONArray array = new JSONArray(json);
                    for (int i = 0; i < array.length() && items.size() < 300; i++) {
                        QueueItem item = QueueItem.fromJson(array.getJSONObject(i));
                        if (item.id != null && item.id.matches("[A-Za-z0-9_-]{11}")) items.add(item);
                    }
                } catch (Exception ignored) {}
                if (items.isEmpty() || controller == null) return;
                int base = Math.max(0, Math.min(items.size() - 1, startIndex));
                int gen = ++resolveGeneration;
                java.util.List<Integer> order = new java.util.ArrayList<>();
                synchronized (queueLock) {
                    queueMeta.clear();
                    queueMeta.addAll(items);
                    resolved.clear();
                    retryIds.clear();
                    startBase = base;
                    currentQueueIndex = base;
                    absoluteAnchored = false;
                    prepared = false;
                    anchoredSize = 0;
                }
                startPositionMs = Math.max(0, startPositionMsParam);
                resolving = true;
                wantsPlayback = true;
                error = "";
                controller.stop();
                controller.clearMediaItems();
                for (int i = base; i < items.size(); i++) order.add(i);
                for (int i = 0; i < base; i++) order.add(i);
                for (int i : order) {
                    QueueItem item = queueMeta.get(i);
                    resolved.put(i, buildMediaItem(item.key, "spotitube-stream://" + item.id, item.title, item.artist));
                }
                anchorQueue(gen);
            });
        }

        @JavascriptInterface public void enqueue(String json) {
            runOnUiThread(() -> {
                java.util.List<QueueItem> items = new java.util.ArrayList<>();
                try {
                    JSONArray array = new JSONArray(json);
                    for (int i = 0; i < array.length(); i++) {
                        QueueItem item = QueueItem.fromJson(array.getJSONObject(i));
                        if (item.id != null && item.id.matches("[A-Za-z0-9_-]{11}")) items.add(item);
                    }
                } catch (Exception ignored) {}
                int gen;
                synchronized (queueLock) {
                    int start = queueMeta.size();
                    if (start + items.size() > 300) return;
                    queueMeta.addAll(items);
                    gen = resolveGeneration;
                }
                if (items.isEmpty()) return;
                int size;
                synchronized (queueLock) { size = queueMeta.size(); }
                for (int i = size - items.size(); i < size; i++) {
                    QueueItem item = queueMeta.get(i);
                    resolved.put(i, buildMediaItem(item.key, "spotitube-stream://" + item.id, item.title, item.artist));
                }
                // Absolute-anchored playlists can simply grow at the end.
                runOnUiThread(() -> {
                    if (controller == null) return;
                    if (absoluteAnchored) {
                        for (int i = size - items.size(); i < size; i++) {
                            if (resolved.containsKey(i) && controller.getMediaItemCount() == i) {
                                controller.addMediaItem(resolved.get(i));
                            }
                        }
                        anchoredSize = size;
                        applyRepeat();
                    } else {
                        anchorQueue(gen);
                    }
                });
            });
        }

        @JavascriptInterface public void setRepeat(int mode) {
            runOnUiThread(() -> {
                repeatModeValue = mode == 2 ? 2 : mode == 1 ? 1 : 0;
                applyRepeat();
            });
        }

        @JavascriptInterface public void setNormalize(boolean enabled) {
            PlaybackService.setNormalize(enabled);
        }

        @JavascriptInterface public void artist(String url, int request) {
            if (url == null || url.length() > 300
                || !(url.startsWith("https://www.youtube.com/") || url.startsWith("https://m.youtube.com/")
                     || url.startsWith("https://music.youtube.com/"))) return;
            worker.execute(() -> {
                String payload;
                try { payload = NewPipeAudioResolver.artist(url); }
                catch (Exception failure) { android.util.Log.w("SpotArtist", "Artist load failed", failure); payload = "null"; }
                String finalPayload = payload;
                runOnUiThread(() -> {
                    if (!isDestroyed()) web.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('spotitube-artist',{detail:{request:"
                            + request + ",artist:" + finalPayload + "}}))", null);
                });
            });
        }

        @JavascriptInterface public void radio(String id, int request, boolean musicOnly) {
            if (!id.matches("[A-Za-z0-9_-]{11}")) return;
            worker.execute(() -> {
                String result;
                try { result = musicOnly ? NewPipeAudioResolver.musicRadio(id) : NewPipeAudioResolver.radio(id); }
                catch (Exception failure) { android.util.Log.w("SpotRadio", "Radio failed", failure); result = "[]"; }
                String payload = result;
                runOnUiThread(() -> {
                    if (!isDestroyed()) web.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('spotitube-radio',{detail:{request:"
                            + request + ",videos:" + payload + "}}))", null);
                });
            });
        }
        @JavascriptInterface public void importPlaylist(String id) {
            if (!id.matches("[A-Za-z0-9_-]{1,128}")) return;
            worker.execute(() -> {
                String result;
                try { result = NewPipeAudioResolver.playlist(id); }
                catch (Exception failure) { result = "null"; }
                String payload = result;
                runOnUiThread(() -> {
                    if (!isDestroyed()) web.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('spotitube-playlist',{detail:{id:"
                            + JSONObject.quote(id) + ",playlist:" + payload + "}}))", null);
                });
            });
        }
        @JavascriptInterface public void editQueue(String key, int direction) {
            if (key == null || key.length() > 64) return;
            MainActivity.this.editQueue(key, direction);
        }

        @JavascriptInterface public String appVersion() { return BuildConfig.VERSION_NAME; }
        @JavascriptInterface public void checkUpdates() {
            runOnUiThread(() -> updates.checkNow());
        }

        @JavascriptInterface public String state() {
            try {
                return new JSONObject(snapshot).put("sampleAgeMs",
                    Math.max(0, android.os.SystemClock.elapsedRealtime() - snapshotAt)).toString();
            } catch (Exception ignored) { return snapshot; }
        }
        @JavascriptInterface public void control(String action, double value) {
            runOnUiThread(() -> {
                if (controller == null || isDestroyed()) return;
                switch (action) {
                    case "play":
                        wantsPlayback = true;
                        // If the playlist ended, restart the current item.
                        if (controller.getPlaybackState() == Player.STATE_ENDED) {
                            controller.seekTo(controller.getCurrentWindowIndex(), 0);
                        }
                        if (!resolving && controller.getMediaItemCount() > 0) controller.play();
                        break;
                    case "pause":
                        wantsPlayback = false;
                        controller.pause();
                        break;
                    case "retry":
                        wantsPlayback = true;
                        error = "";
                        controller.prepare();
                        controller.play();
                        break;
                    case "seek": controller.seekTo((long)(value * 1000)); break;
                    case "next":
                        if (controller.hasNextMediaItem()) controller.seekToNextMediaItem();
                        break;
                    case "prev":
                        if (controller.getCurrentPosition() > 3000 || !controller.hasPreviousMediaItem()) {
                            controller.seekTo(0);
                        } else {
                            controller.seekToPreviousMediaItem();
                        }
                        break;
                    case "volume":
                        if (!Double.isFinite(value)) break;
                        int percent = (int)Math.round(Math.max(0, Math.min(300, value)));
                        var audio = audioManager();
                        audio.setStreamVolume(MUSIC, Math.round(Math.min(100, percent) * audio.getStreamMaxVolume(MUSIC) / 100f), 0);
                        applyBoostVolume(audio.getStreamVolume(MUSIC) == audio.getStreamMaxVolume(MUSIC) ? Math.max(100, percent) : 100);
                        break;
                }
            });
        }
        @JavascriptInterface public void search(String query, int request, boolean musicOnly) {
            if (query.isBlank() || query.length() > 120) return;
            worker.execute(() -> {
                String result;
                try {
                    try { result = NewPipeAudioResolver.search(query, musicOnly); }
                    catch (Exception first) { result = "[]"; }
                    if (!musicOnly && "[]".equals(result)) result = YouTubeAudioResolver.search(query);
                }
                catch (Exception failure) { android.util.Log.w("SpotSearch", "Search failed", failure); result = "null"; }
                String payload = result;
                runOnUiThread(() -> {
                    if (!isDestroyed()) web.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('spotitube-search',{detail:{request:"
                            + request + ",videos:" + payload + "}}))", null);
                });
            });
        }
        @JavascriptInterface public String metadata(String id) {
            if (!id.matches("[A-Za-z0-9_-]{11}")) return "";
            try {
                URL url = new URL("https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D" + id);
                java.net.URLConnection request = url.openConnection();
                request.setConnectTimeout(5000);
                request.setReadTimeout(5000);
                try (InputStream input = request.getInputStream();
                     java.util.Scanner scanner = new java.util.Scanner(input, "UTF-8").useDelimiter("\\A")) {
                    return scanner.hasNext() ? scanner.next() : "";
                }
            } catch (Exception failure) { return ""; }
        }

        @JavascriptInterface public void download(String id, String title, String artist, String thumb) {
            if (!notificationRequested && android.os.Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                notificationRequested = true;
                runOnUiThread(() -> requestPermissions(new String[] { android.Manifest.permission.POST_NOTIFICATIONS }, 73));
            }
            if (id == null || !id.matches("[A-Za-z0-9_-]{11}")) return;
            File existing = OfflineStore.fileFor(MainActivity.this, id);
            if (existing != null) {
                dispatchDownload(id, "done", 1f, existing.length(), existing.length());
                return;
            }
            DownloadService.command(MainActivity.this, "enqueue", id, title, artist, thumb);
        }

        @JavascriptInterface public String downloadQueue() { return DownloadService.snapshot(MainActivity.this); }
        @JavascriptInterface public void cancelDownload(String id) {
            DownloadService.command(MainActivity.this, "cancel", id, "", "", "");
        }
        @JavascriptInterface public void retryDownload(String id) {
            DownloadService.command(MainActivity.this, "retry", id, "", "", "");
        }

        @JavascriptInterface public void deleteDownload(String id) {
            if (id == null || !id.matches("[A-Za-z0-9_-]{11}")) return;
            OfflineStore.remove(MainActivity.this, id);
            dispatchDownload(id, "removed", 0f, 0, 0);
        }

        @JavascriptInterface public String downloads() {
            try { return OfflineStore.list(MainActivity.this); }
            catch (Exception failure) { return "[]"; }
        }
    }

    private void copyFile(File source, File target) throws java.io.IOException {
        try (InputStream input = new java.io.FileInputStream(source);
             OutputStream output = new java.io.FileOutputStream(target)) {
            byte[] buffer = new byte[8192];
            for (int count; (count = input.read(buffer)) != -1;) output.write(buffer, 0, count);
        }
    }

    private void dispatchDownload(String id, String status, float progress, long received, long total) {
        String payload = "{\"id\":\"" + id + "\",\"status\":\"" + status
            + "\",\"progress\":" + progress + ",\"received\":" + received + ",\"total\":" + total + "}";
        runOnUiThread(() -> {
            if (isDestroyed()) return;
            web.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('spotitube-download',{detail:" + payload + "}))", null);
        });
    }

    public boolean canShowUpdate() { return resumed && !isFinishing() && !isDestroyed() && !resolving && (controller == null || !controller.getPlayWhenReady()); }
    @Override protected void onResume() { super.onResume(); resumed = true; updates.onStart(); }
    @Override protected void onPause() { resumed = false; super.onPause(); }
    @Override public void onDestroy() {
        updates.close();
        handler.removeCallbacks(poll);
        queuePool.shutdownNow();
        worker.shutdownNow();
        MediaController.releaseFuture(connection);
        web.destroy();
        super.onDestroy();
    }
}
