package com.spotitube;

import android.app.*;
import android.content.*;
import android.os.*;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

public final class DownloadService extends Service {
    private static DownloadService active;
    private final Map<String, JSONObject> jobs = new LinkedHashMap<>();
    private final Set<String> running = new HashSet<>();
    private final Set<String> canceled = ConcurrentHashMap.newKeySet();
    private final ExecutorService pool = Executors.newFixedThreadPool(3);
    private final Handler handler = new Handler(Looper.getMainLooper());
    private File stateFile() { return new File(getFilesDir(), "download-queue.json"); }

    public static String snapshot(Context context) {
        if (active != null) return active.snapshot();
        try { return new String(Files.readAllBytes(new File(context.getFilesDir(), "download-queue.json").toPath()), java.nio.charset.StandardCharsets.UTF_8); }
        catch (Exception ignored) { return "[]"; }
    }
    private synchronized String snapshot() { return new JSONArray(jobs.values()).toString(); }
    private synchronized void save() {
        try {
            File temp = new File(getFilesDir(), "download-queue.tmp");
            Files.write(temp.toPath(), snapshot().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            Files.move(temp.toPath(), stateFile().toPath(), StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception failure) { android.util.Log.w("SpotDownloads", "Queue persistence failed"); }
    }
    public static void command(Context context, String action, String id, String title, String artist, String thumb) {
        Intent intent = new Intent(context, DownloadService.class).setAction(action)
            .putExtra("id", id).putExtra("title", title).putExtra("artist", artist).putExtra("thumb", thumb);
        context.startForegroundService(intent);
    }
    @Override public void onCreate() {
        super.onCreate();
        ((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(
            new NotificationChannel("downloads", "Music downloads", NotificationManager.IMPORTANCE_LOW));
        try {
            JSONArray stored = new JSONArray(snapshot(this));
            for (int i = 0; i < stored.length(); i++) {
                JSONObject job = stored.getJSONObject(i);
                if (Arrays.asList("queued", "preparing", "downloading").contains(job.optString("status"))) {
                    job.put("status", "queued").put("received", 0).put("total", 0);
                }
                jobs.put(job.getString("id"), job);
            }
        } catch (Exception ignored) {}
        active = this;
        notifyProgress();
    }
    private void notifyProgress() {
        long count;
        synchronized (this) {
            count = jobs.values().stream().filter(j -> Arrays.asList("queued","preparing","downloading").contains(j.optString("status"))).count();
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        startForeground(52, new Notification.Builder(this, "downloads")
            .setSmallIcon(android.R.drawable.stat_sys_download).setContentTitle("Spotitube downloads")
            .setContentText(count + " active or queued").setContentIntent(open).setOngoing(count > 0).build());
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String id = intent.getStringExtra("id");
            if (id != null && id.matches("[A-Za-z0-9_-]{11}")) {
                synchronized (this) {
                    JSONObject old = jobs.get(id);
                    try {
                        if ("cancel".equals(intent.getAction())) {
                            canceled.add(id);
                            if (old != null) old.put("status", "canceled");
                        } else if (old == null || !Arrays.asList("queued","preparing","downloading").contains(old.optString("status"))) {
                            JSONObject job = old == null ? new JSONObject().put("id", id)
                                .put("title", intent.getStringExtra("title")).put("author_name", intent.getStringExtra("artist"))
                                .put("thumbnail_url", intent.getStringExtra("thumb")) : old;
                            job.put("status", "queued").put("received", 0).put("total", 0);
                            jobs.put(id, job);
                        }
                    } catch (JSONException ignored) {}
                }
            }
        }
        save(); pump();
        return START_STICKY;
    }
    private synchronized void pump() {
        for (JSONObject job : jobs.values()) {
            if (running.size() >= 3) break;
            String id = job.optString("id");
            if (!"queued".equals(job.optString("status")) || running.contains(id)) continue;
            running.add(id); canceled.remove(id);
            update(id, "preparing", 0, 0);
            pool.execute(() -> transfer(id));
        }
        notifyProgress();
        if (running.isEmpty()) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
        }
    }
    private synchronized void update(String id, String status, long received, long total) {
        try { jobs.get(id).put("status", status).put("received", received).put("total", total); }
        catch (Exception ignored) {}
        save();
    }
    private void transfer(String id) {
        File temp = new File(OfflineStore.dir(this), id + ".part");
        HttpURLConnection connection = null;
        long received = 0, total = 0;
        try {
            String url = NewPipeAudioResolver.resolve(id);
            if (canceled.contains(id)) throw new InterruptedIOException();
            connection = (HttpURLConnection)new URL(url).openConnection();
            connection.setConnectTimeout(10000); connection.setReadTimeout(15000);
            if (connection.getResponseCode() != 200) throw new IOException("HTTP response rejected");
            total = connection.getContentLengthLong();
            update(id, "downloading", 0, total);
            try (InputStream input = connection.getInputStream(); OutputStream out = new FileOutputStream(temp)) {
                byte[] buffer = new byte[32768];
                long last = 0;
                for (int count; (count = input.read(buffer)) != -1;) {
                    if (canceled.contains(id) || Thread.currentThread().isInterrupted()) throw new InterruptedIOException();
                    out.write(buffer, 0, count); received += count;
                    if (System.currentTimeMillis() - last > 300) {
                        update(id, "downloading", received, total); last = System.currentTimeMillis();
                    }
                }
            }
            if (received == 0 || (total > 0 && received != total)) throw new IOException("Incomplete transfer");
            if (canceled.contains(id)) throw new InterruptedIOException();
            Files.move(temp.toPath(), OfflineStore.target(this, id).toPath(), StandardCopyOption.REPLACE_EXISTING);
            JSONObject job;
            synchronized (this) { job = jobs.get(id); }
            OfflineStore.put(this, id, job.optString("title"), job.optString("author_name"), job.optString("thumbnail_url"));
            update(id, "completed", received, received);
        } catch (Exception failure) {
            temp.delete();
            update(id, canceled.contains(id) ? "canceled" : "failed", received, total);
        } finally {
            if (connection != null) connection.disconnect();
            handler.post(() -> { synchronized (this) { running.remove(id); } pump(); });
        }
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onDestroy() { active = null; pool.shutdownNow(); super.onDestroy(); }
}
