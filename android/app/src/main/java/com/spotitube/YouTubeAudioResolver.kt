package com.spotitube

import com.metrolist.innertubex.InnerTube
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import kotlinx.coroutines.runBlocking
import io.ktor.client.statement.bodyAsText
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.serialization.kotlinx.json.json
import io.ktor.client.request.header
import com.metrolist.innertubex.models.YouTubeClient
import org.json.JSONArray
import org.json.JSONObject

object YouTubeAudioResolver {
    @JvmStatic
    fun search(query: String): String = runBlocking {
        HttpClient(CIO) { install(ContentNegotiation) { json() }; defaultRequest { url("https://www.youtube.com/youtubei/v1/"); header("Content-Type", "application/json") } }.use { http ->
            val client = InnerTube(httpClient = http)
            try {
                val body = JSONObject(client.search(YouTubeClient.WEB, query = query, setLogin = false).bodyAsText())
                val results = JSONArray()
                val seen = mutableSetOf<String>()
                fun label(value: JSONObject?): String {
                    if (value == null) return ""
                    val runs = value.optJSONArray("runs") ?: return value.optString("simpleText")
                    return (0 until runs.length()).joinToString("") { runs.optJSONObject(it)?.optString("text").orEmpty() }
                }
                fun durationSeconds(text: String): Long {
                    val parts = text.trim().split(":")
                    if (parts.isEmpty() || parts.any { it.isBlank() || it.toIntOrNull() == null }) return 0
                    return parts.fold(0L) { acc, part -> acc * 60L + part.trim().toLong() }
                }
                fun visit(node: Any?) {
                    if (results.length() >= 20) return
                    when (node) {
                        is JSONObject -> {
                            val video = node.optJSONObject("videoRenderer")
                            val id = video?.optString("videoId").orEmpty()
                            val title = label(video?.optJSONObject("title"))
                            val browse = video
                                ?.optJSONObject("ownerText")
                                ?.optJSONArray("runs")
                                ?.optJSONObject(0)
                                ?.optJSONObject("navigationEndpoint")
                                ?.optJSONObject("browseEndpoint")
                            val channelUrl = browse
                                ?.optString("canonicalBaseUrl")
                                ?.takeIf { it.isNotBlank() }
                                ?.let { "https://www.youtube.com$it" }
                                ?: ""
                            val duration = durationSeconds(label(video?.optJSONObject("lengthText")))
                            if (id.matches(Regex("[A-Za-z0-9_-]{11}")) && title.isNotBlank() && seen.add(id)) {
                                results.put(JSONObject().put("id", id).put("title", title)
                                    .put("author_name", label(video?.optJSONObject("ownerText")))
                                    .put("thumbnail_url", "https://i.ytimg.com/vi/$id/mqdefault.jpg")
                                    .put("duration", duration)
                                    .put("channel_url", channelUrl))
                            }
                            node.keys().forEach { visit(node.opt(it)) }
                        }
                        is JSONArray -> for (index in 0 until node.length()) visit(node.opt(index))
                    }
                }
                visit(body.optJSONObject("contents"))
                android.util.Log.d("SpotSearch", "innertube results=${results.length()}")
                results.toString()
            } finally {
                client.close()
            }
        }
    }
}

