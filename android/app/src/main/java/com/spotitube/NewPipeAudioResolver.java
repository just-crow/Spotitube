package com.spotitube;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.ServiceList;
import org.schabi.newpipe.extractor.downloader.Downloader;
import org.schabi.newpipe.extractor.downloader.Request;
import org.schabi.newpipe.extractor.downloader.Response;
import org.schabi.newpipe.extractor.stream.AudioStream;
import org.schabi.newpipe.extractor.stream.StreamInfo;

final class NewPipeAudioResolver {
    static {
        NewPipe.init(new Downloader() {
            @Override public Response execute(Request request) throws java.io.IOException {
                HttpURLConnection connection = (HttpURLConnection) new URL(request.url()).openConnection();
                try {
                    connection.setConnectTimeout(10000);
                    connection.setReadTimeout(15000);
                    connection.setRequestMethod(request.httpMethod());
                    request.headers().forEach((name, values) ->
                        values.forEach(value -> connection.addRequestProperty(name, value)));
                    byte[] data = request.dataToSend();
                    if (data != null) {
                        connection.setDoOutput(true);
                        try (java.io.OutputStream output = connection.getOutputStream()) {
                            output.write(data);
                        }
                    }
                    int code = connection.getResponseCode();
                    String body = "";
                    try (InputStream input = code >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
                        if (input != null) {
                            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                            byte[] buffer = new byte[8192];
                            for (int count; (count = input.read(buffer)) != -1;) {
                                if (bytes.size() + count > 8 * 1024 * 1024) throw new java.io.IOException("Response too large");
                                bytes.write(buffer, 0, count);
                            }
                            body = new String(bytes.toByteArray(), StandardCharsets.UTF_8);
                        }
                    }
                    return new Response(code, connection.getResponseMessage(),
                        connection.getHeaderFields(), body, connection.getURL().toString());
                } finally {
                    connection.disconnect();
                }
            }
        });
    }

    static String playlist(String id) throws Exception {
        String url = "https://www.youtube.com/playlist?list=" + id;
        var info = org.schabi.newpipe.extractor.playlist.PlaylistInfo.getInfo(ServiceList.YouTube, url);
        var items = new org.json.JSONArray();
        var page = info.getNextPage();
        appendPlaylistItems(items, info.getRelatedItems());
        for (int i = 0; org.schabi.newpipe.extractor.Page.isValid(page); i++) {
            if (i >= 100) throw new java.io.IOException("Playlist is too large");
            var more = org.schabi.newpipe.extractor.playlist.PlaylistInfo.getMoreItems(ServiceList.YouTube, url, page);
            appendPlaylistItems(items, more.getItems());
            page = more.getNextPage();
        }
        return new org.json.JSONObject().put("name", info.getName()).put("videos", items).toString();
    }

    private static String uploaderUrl(org.schabi.newpipe.extractor.stream.StreamInfoItem item) {
        try {
            String url = item.getUploaderUrl();
            return url == null ? "" : url;
        } catch (Throwable ignored) {
            return "";
        }
    }

    static String playlistIdOfUrl(String url) {
        if (url == null) return "";
        var matcher = java.util.regex.Pattern.compile("[?&]list=([A-Za-z0-9_-]+)").matcher(url);
        return matcher.find() ? matcher.group(1) : "";
    }

    private static void appendPlaylistItems(org.json.JSONArray result,
        java.util.List<org.schabi.newpipe.extractor.stream.StreamInfoItem> items) throws Exception {
        for (var item : items) {
            String id;
            try { id = ServiceList.YouTube.getStreamLHFactory().getId(item.getUrl()); }
            catch (org.schabi.newpipe.extractor.exceptions.ParsingException invalid) { continue; }
            result.put(new org.json.JSONObject().put("id", id).put("title", item.getName())
                .put("author_name", item.getUploaderName() == null ? "" : item.getUploaderName())
                .put("thumbnail_url", "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg")
                .put("duration", Math.max(0, item.getDuration()))
                .put("channel_url", uploaderUrl(item)));
        }
    }

    static String search(String query) throws Exception { return search(query, false); }
    static String search(String query, boolean musicOnly) throws Exception {
        org.json.JSONArray results = new org.json.JSONArray();
        var info = org.schabi.newpipe.extractor.search.SearchInfo.getInfo(
            ServiceList.YouTube.getSearchExtractor(query, java.util.Collections.singletonList(musicOnly ? "music_songs" : "videos"), ""));
        for (var item : info.getRelatedItems()) {
            if (!(item instanceof org.schabi.newpipe.extractor.stream.StreamInfoItem)) continue;
            var stream = (org.schabi.newpipe.extractor.stream.StreamInfoItem) item;
            String id = ServiceList.YouTube.getStreamLHFactory().getId(stream.getUrl());
            if (id == null || !id.matches("[A-Za-z0-9_-]{11}")) continue;
            results.put(new org.json.JSONObject().put("id", id).put("title", stream.getName())
                .put("author_name", stream.getUploaderName() == null ? "" : stream.getUploaderName())
                .put("thumbnail_url", stream.getThumbnails().isEmpty() ? "" : stream.getThumbnails().get(0).getUrl())
                .put("duration", Math.max(0, stream.getDuration()))
                .put("channel_url", uploaderUrl(stream)));
            if (results.length() == 20) break;
        }
        android.util.Log.d("SpotSearch", "newpipe results=" + results.length());
        if (musicOnly && results.length() == 0) return verifiedMusicSearch(query);
        return results.toString();
    }

    private static final java.util.Map<String, Boolean> musicCategories = new java.util.concurrent.ConcurrentHashMap<>();

    private static String verifiedMusicSearch(String query) throws Exception {
        String raw = search(query, false);
        if ("[]".equals(raw)) raw = YouTubeAudioResolver.search(query);
        org.json.JSONArray candidates = new org.json.JSONArray(raw);
        var pool = java.util.concurrent.Executors.newFixedThreadPool(3);
        java.util.List<java.util.concurrent.Callable<org.json.JSONObject>> tasks = new java.util.ArrayList<>();
        for (int i = 0; i < Math.min(12, candidates.length()); i++) {
            var candidate = candidates.getJSONObject(i);
            tasks.add(() -> {
                String id = candidate.getString("id");
                Boolean music = musicCategories.get(id);
                if (music == null) {
                    var info = StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=" + id);
                    music = "Music".equalsIgnoreCase(info.getCategory());
                    if (musicCategories.size() > 500) musicCategories.clear();
                    musicCategories.put(id, music);
                }
                return music ? candidate : null;
            });
        }
        org.json.JSONArray verified = new org.json.JSONArray();
        try {
            for (var task : pool.invokeAll(tasks, 18, java.util.concurrent.TimeUnit.SECONDS)) {
                if (task.isCancelled()) continue;
                try { var item = task.get(); if (item != null) verified.put(item); }
                catch (Exception ignored) {}
            }
        } finally { pool.shutdownNow(); }
        return verified.toString();
    }

    static String musicRadio(String id) throws Exception {
        StreamInfo seed = StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=" + id);
        org.json.JSONArray output = new org.json.JSONArray();
        java.util.Set<String> seen = new java.util.HashSet<>();
        seen.add(id);
        // Fetch song-catalog results rather than queueing ordinary related videos.
        // Prefer the artist from the title ("Artist - Song") when the uploader is a
        // topic/lyrics channel that doesn't belong to the artist.
        String uploader = seed.getUploaderName() == null ? "" : seed.getUploaderName()
            .replaceAll("(?i)( - Topic|VEVO| Official)$", "").trim();
        String title = seed.getName() == null ? "" : seed.getName();
        int dash = title.indexOf(" - ");
        String titleArtist = dash > 0 ? title.substring(0, dash).trim() : "";
        String artist;
        if (!titleArtist.isEmpty()
            && !uploader.toLowerCase().replaceAll("\\s+", "").contains(titleArtist.toLowerCase().replaceAll("\\s+", ""))) {
            artist = titleArtist;
        } else {
            artist = uploader.isEmpty() ? titleArtist : uploader;
        }
        if (artist.isEmpty()) artist = title;
        org.json.JSONArray songs = new org.json.JSONArray(search(artist, true));
        for (int i = 0; i < songs.length(); i++) {
            var song = songs.getJSONObject(i);
            if (seen.add(song.getString("id"))) output.put(song);
        }
        return output.toString();
    }

    /** Related streams from a seed track: the Android equivalent of "start radio". */
    static String radio(String id) throws Exception {
        StreamInfo info = StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=" + id);
        org.json.JSONArray results = new org.json.JSONArray();
        collectRelated(results, info.getRelatedStreams(), 25);
        android.util.Log.d("SpotRadio", "related=" + results.length());
        if (results.length() == 0) {
            // Mix playlists (RD<videoId>) are the "start radio" list YouTube builds.
            try {
                var mix = org.schabi.newpipe.extractor.playlist.PlaylistInfo.getInfo(
                    ServiceList.YouTube, "https://www.youtube.com/watch?v=" + id + "&list=RD" + id);
                appendPlaylistItems(results, mix.getRelatedItems());
                android.util.Log.d("SpotRadio", "mix=" + results.length());
            } catch (Exception ignored) {}
        }
        if (results.length() == 0) {
            // Last resort: search by the seed's own title and channel.
            String query = info.getName() + " " + (info.getUploaderName() == null ? "" : info.getUploaderName());
            try {
                var search = org.schabi.newpipe.extractor.search.SearchInfo.getInfo(
                    ServiceList.YouTube.getSearchExtractor(query.trim(), java.util.Collections.singletonList("videos"), ""));
                collectRelated(results, search.getRelatedItems(), 25);
                android.util.Log.d("SpotRadio", "search=" + results.length());
            } catch (Exception ignored) {}
        }
        return results.toString();
    }

    private static void collectRelated(org.json.JSONArray results, java.util.List<?> items, int limit) throws Exception {
        for (var related : items) {
            if (results.length() >= limit) return;
            if (!(related instanceof org.schabi.newpipe.extractor.stream.StreamInfoItem)) continue;
            var item = (org.schabi.newpipe.extractor.stream.StreamInfoItem) related;
            String videoId;
            try { videoId = ServiceList.YouTube.getStreamLHFactory().getId(item.getUrl()); }
            catch (org.schabi.newpipe.extractor.exceptions.ParsingException invalid) { continue; }
            if (videoId == null || !videoId.matches("[A-Za-z0-9_-]{11}")) continue;
            results.put(new org.json.JSONObject().put("id", videoId).put("title", item.getName())
                .put("author_name", item.getUploaderName() == null ? "" : item.getUploaderName())
                .put("thumbnail_url", item.getThumbnails().isEmpty()
                    ? "https://i.ytimg.com/vi/" + videoId + "/mqdefault.jpg"
                    : item.getThumbnails().get(0).getUrl())
                .put("duration", Math.max(0, item.getDuration()))
                .put("channel_url", uploaderUrl(item)));
        }
    }

    /** Channel page payload: name, avatar, uploads (and YouTube Music tracks) + albums/playlists tabs. */
    static String artist(String url) throws Exception {
        var info = org.schabi.newpipe.extractor.channel.ChannelInfo.getInfo(ServiceList.YouTube, url);
        org.json.JSONObject out = new org.json.JSONObject();
        out.put("name", info.getName());
        out.put("description", info.getDescription() == null ? "" : info.getDescription());
        out.put("avatar_url", info.getAvatars().isEmpty() ? "" : info.getAvatars().get(0).getUrl());
        out.put("channel_url", info.getUrl());
        out.put("subscribers", info.getSubscriberCount());

        org.json.JSONArray uploads = new org.json.JSONArray();
        org.json.JSONArray playlists = new org.json.JSONArray();

        for (var tab : info.getTabs()) {
            java.util.List<String> filters = tab.getContentFilters();
            String joined = String.join(" ", filters == null ? java.util.List.of() : filters).toLowerCase();
            boolean videoTab = joined.contains("videos") || joined.contains("tracks");
            boolean playlistTab = joined.contains("playlists") || joined.contains("albums");
            if (!videoTab && !playlistTab) continue;
            if ((videoTab && uploads.length() >= 12) || (playlistTab && playlists.length() >= 12)) continue;
            org.schabi.newpipe.extractor.channel.tabs.ChannelTabInfo tabInfo;
            try {
                tabInfo = org.schabi.newpipe.extractor.channel.tabs.ChannelTabInfo.getInfo(ServiceList.YouTube, tab);
            } catch (Exception failure) {
                android.util.Log.w("SpotArtist", "Could not load tab " + joined, failure);
                continue;
            }
            for (var item : tabInfo.getRelatedItems()) {
                if (item instanceof org.schabi.newpipe.extractor.stream.StreamInfoItem && videoTab && uploads.length() < 12) {
                    var stream = (org.schabi.newpipe.extractor.stream.StreamInfoItem) item;
                    String id;
                    try { id = ServiceList.YouTube.getStreamLHFactory().getId(stream.getUrl()); }
                    catch (org.schabi.newpipe.extractor.exceptions.ParsingException invalid) { continue; }
                    if (id == null || !id.matches("[A-Za-z0-9_-]{11}")) continue;
                    uploads.put(new org.json.JSONObject().put("id", id).put("title", stream.getName())
                        .put("author_name", info.getName())
                        .put("thumbnail_url", stream.getThumbnails().isEmpty()
                            ? "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg"
                            : stream.getThumbnails().get(0).getUrl())
                        .put("duration", Math.max(0, stream.getDuration()))
                        .put("channel_url", info.getUrl()));
                } else if (item instanceof org.schabi.newpipe.extractor.playlist.PlaylistInfoItem && playlistTab && playlists.length() < 12) {
                    var playlist = (org.schabi.newpipe.extractor.playlist.PlaylistInfoItem) item;
                    String listId = playlistIdOfUrl(playlist.getUrl());
                    if (listId.isEmpty()) listId = playlistIdOfUrl(String.valueOf(item));
                    if (listId.isEmpty()) continue;
                    playlists.put(new org.json.JSONObject().put("id", listId)
                        .put("title", playlist.getName())
                        .put("count", Math.max(0, playlist.getStreamCount()))
                        .put("thumbnail_url", playlist.getThumbnails().isEmpty()
                            ? ""
                            : playlist.getThumbnails().get(0).getUrl()));
                }
            }
        }
        out.put("uploads", uploads);
        out.put("playlists", playlists);
        return out.toString();
    }

    static String resolve(String id) throws Exception {
        StreamInfo info = StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=" + id);
        AudioStream best = null;
        for (AudioStream stream : info.getAudioStreams()) {
            if (stream.isUrl() && stream.getContent().startsWith("https://")
                && (best == null || stream.getAverageBitrate() > best.getAverageBitrate())) best = stream;
        }
        if (best == null) throw new java.io.IOException("No direct audio stream");
        return best.getContent();
    }
}



