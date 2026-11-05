package com.spotitube;

import android.content.Context;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONObject;

/** On-disk cache of downloaded audio, so tracks play with no network at all. */
final class OfflineStore {
    private OfflineStore() {}

    static File dir(Context context) {
        File dir = new File(context.getFilesDir(), "offline");
        if (!dir.exists() && !dir.mkdirs()) android.util.Log.w("SpotOffline", "Could not create offline dir");
        return dir;
    }

    static File target(Context context, String id) {
        return new File(dir(context), id + ".m4a");
    }

    /** The downloaded file, or null when missing/suspiciously small. */
    static File fileFor(Context context, String id) {
        File file = target(context, id);
        return file.exists() && file.length() > 0 ? file : null;
    }

    static synchronized JSONObject index(Context context) {
        try {
            File file = new File(dir(context), "index.json");
            if (!file.exists()) return new JSONObject();
            String content = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
            JSONObject parsed = new JSONObject(content);
            return parsed;
        } catch (Exception ignored) {
            return new JSONObject();
        }
    }

    private static synchronized void store(Context context, JSONObject index) {
        try {
            File temp = new File(dir(context), "index.tmp");
            Files.write(temp.toPath(), index.toString().getBytes(StandardCharsets.UTF_8));
            Files.move(temp.toPath(), new File(dir(context), "index.json").toPath(),
                java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception ignored) {
            android.util.Log.w("SpotOffline", "Could not persist offline index");
        }
    }

    static synchronized void put(Context context, String id, String title, String artist, String thumb) {
        try {
            File file = target(context, id);
            JSONObject index = index(context);
            index.put(id, new JSONObject()
                .put("title", title)
                .put("artist", artist)
                .put("thumb", thumb)
                .put("size", file.length())
                .put("at", System.currentTimeMillis()));
            store(context, index);
        } catch (Exception ignored) {}
    }

    static synchronized boolean remove(Context context, String id) {
        boolean deleted = target(context, id).delete();
        try {
            JSONObject index = index(context);
            index.remove(id);
            store(context, index);
        } catch (Exception ignored) {}
        return deleted;
    }

    /** JSON array of {id,title,artist,thumb,size,at} for the JS "Downloaded" page. */
    static synchronized String list(Context context) {
        JSONObject index = index(context);
        org.json.JSONArray out = new org.json.JSONArray();
        try {
            for (java.util.Iterator<String> keys = index.keys(); keys.hasNext();) {
                String id = keys.next();
                File file = fileFor(context, id);
                if (file == null) { index.remove(id); continue; }
                JSONObject entry = index.getJSONObject(id);
                out.put(new JSONObject()
                    .put("id", id)
                    .put("title", entry.optString("title"))
                    .put("author_name", entry.optString("artist"))
                    .put("thumbnail_url", entry.optString("thumb"))
                    .put("size", file.length())
                    .put("at", entry.optLong("at")));
            }
            store(context, index);
        } catch (Exception ignored) {}
        return out.toString();
    }

    static synchronized long totalBytes(Context context) {
        long total = 0;
        for (File file : dir(context).listFiles()) {
            if (file.isFile() && !file.getName().equals("index.json")) total += file.length();
        }
        return total;
    }
}
