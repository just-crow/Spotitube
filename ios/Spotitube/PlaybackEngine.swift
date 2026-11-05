import AVFoundation
import MediaPlayer
import Foundation
import YouTubeKit

@MainActor
final class PlaybackEngine {
    let player = AVPlayer()
    var queue: [QueueEntry] = []
    var index = 0
    var repeatMode = 0
    var error = ""
    var resolving = false
    var wantsPlayback = false
    var positionVersion = 0
    var onChange: (() -> Void)?
    private var generation = 0
    private var loadTask: Task<Void, Never>?
    private var nextTask: Task<Void, Never>?
    private var observations: [NSKeyValueObservation] = []
    private var endObserver: NSObjectProtocol?
    private var interruptionObserver: NSObjectProtocol?
    private var routeObserver: NSObjectProtocol?
    private var timeObserver: Any?
    private let resolve: (String) async throws -> URL
    private var nextURL: (id: String, url: URL)?
    private var ended = false

    init(resolve: @escaping (String) async throws -> URL) {
        self.resolve = resolve
        player.automaticallyWaitsToMinimizeStalling = true
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.1, preferredTimescale: 1000),
                                                       queue: .main) { [weak self] _ in
            Task { @MainActor in self?.publish() }
        }
        observations.append(player.observe(\.timeControlStatus) { [weak self] _, _ in
            Task { @MainActor in self?.publish() }
        })
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime,
                                                             object: nil, queue: .main) { [weak self] note in
            Task { @MainActor in
                guard let self, let item = note.object as? AVPlayerItem, item === self.player.currentItem else { return }
                if self.repeatMode == 2 { self.seek(0); self.play() }
                else if self.index + 1 < self.queue.count { self.load(self.index + 1) }
                else if self.repeatMode == 1 { self.load(0) }
                else { self.ended = true; self.wantsPlayback = false; self.publish() }
            }
        }
        interruptionObserver = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification,
                                                                      object: nil, queue: .main) { [weak self] note in
            let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            Task { @MainActor in
                if type == AVAudioSession.InterruptionType.began.rawValue { self?.pause() }
            }
        }
        routeObserver = NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification,
                                                               object: nil, queue: .main) { [weak self] note in
            let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            Task { @MainActor in
                if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { self?.pause() }
            }
        }
        let remote = MPRemoteCommandCenter.shared()
        remote.playCommand.addTarget { [weak self] _ in Task { @MainActor in self?.play() }; return .success }
        remote.pauseCommand.addTarget { [weak self] _ in Task { @MainActor in self?.pause() }; return .success }
        remote.nextTrackCommand.addTarget { [weak self] _ in Task { @MainActor in self?.step(1) }; return .success }
        remote.previousTrackCommand.addTarget { [weak self] _ in Task { @MainActor in self?.step(-1) }; return .success }
        remote.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            Task { @MainActor in self?.seek(event.positionTime) }
            return .success
        }
    }

    func replaceQueue(_ entries: [QueueEntry], start: Int, position: Double) {
        guard !entries.isEmpty else { return }
        queue = Array(entries.prefix(300))
        wantsPlayback = true
        load(min(max(0, start), queue.count - 1), position: max(0, position))
    }

    func enqueue(_ entries: [QueueEntry]) {
        queue.append(contentsOf: entries.prefix(max(0, 300 - queue.count)))
        preloadNext()
        publish()
    }

    func edit(key: String, direction: Int) {
        guard let from = queue.firstIndex(where: { $0.key == key }), from > index else { return }
        if direction == 0 { queue.remove(at: from) }
        else {
            let target = from + direction
            guard target > index, target < queue.count else { return }
            queue.insert(queue.remove(at: from), at: target)
        }
        preloadNext()
        publish()
    }

    private func load(_ target: Int, position: Double = 0) {
        guard queue.indices.contains(target) else { return }
        loadTask?.cancel()
        nextTask?.cancel()
        generation += 1
        let token = generation
        index = target
        let entry = queue[target]
        resolving = true
        error = ""
        ended = false
        player.pause()
        player.replaceCurrentItem(with: nil)
        publish()
        loadTask = Task { [weak self] in
            guard let self else { return }
            do {
                let url: URL
                if let cached = self.nextURL, cached.id == entry.id { url = cached.url }
                else { url = try await self.resolve(entry.id) }
                try Task.checkCancellation()
                guard token == self.generation else { return }
                let item = AVPlayerItem(url: url)
                item.preferredForwardBufferDuration = 60
                self.observations.removeAll(where: { !$0.isValid })
                let observation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
                    Task { @MainActor in
                        guard let self, token == self.generation else { return }
                        if item.status == .failed {
                            self.error = "Playback failed. " + (item.error?.localizedDescription ?? "Stream unavailable.")
                            self.resolving = false
                            self.publish()
                        }
                    }
                }
                // Retain only the player-status and the current item-status observers.
                self.observations = Array(self.observations.prefix(1)) + [observation]
                self.player.replaceCurrentItem(with: item)
                self.positionVersion += 1
                if position > 0 {
                    await self.player.seek(to: CMTime(seconds: position, preferredTimescale: 1000),
                                           toleranceBefore: .zero, toleranceAfter: .zero)
                }
                guard token == self.generation else { return }
                self.resolving = false
                if self.wantsPlayback { self.activateAudio(); self.player.play() }
                self.preloadNext()
                self.publish()
            } catch is CancellationError {} catch {
                guard token == self.generation else { return }
                self.resolving = false
                self.error = "Playback failed. " + error.localizedDescription
                self.publish()
            }
        }
    }

    private func preloadNext() {
        nextTask?.cancel()
        nextURL = nil
        let next = index + 1 < queue.count ? index + 1 : repeatMode == 1 && !queue.isEmpty ? 0 : nil
        guard let next else { return }
        let id = queue[next].id
        let token = generation
        nextTask = Task { [weak self] in
            guard let self, let url = try? await self.resolve(id), !Task.isCancelled,
                  token == self.generation else { return }
            self.nextURL = (id, url)
        }
    }

    private func activateAudio() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch { self.error = "Playback failed. " + error.localizedDescription }
    }

    func play() {
        wantsPlayback = true
        ended = false
        activateAudio()
        if player.currentItem == nil || player.currentItem?.status == .failed { load(index) }
        else { player.play() }
        publish()
    }
    func pause() { wantsPlayback = false; player.pause(); publish() }
    func stop() {
        wantsPlayback = false
        generation += 1
        loadTask?.cancel()
        nextTask?.cancel()
        player.pause()
        player.replaceCurrentItem(with: nil)
        publish()
    }
    func seek(_ seconds: Double) {
        guard seconds.isFinite else { return }
        positionVersion += 1
        player.seek(to: CMTime(seconds: max(0, seconds), preferredTimescale: 1000),
                    toleranceBefore: .zero, toleranceAfter: .zero)
        publish()
    }
    func retry() { wantsPlayback = true; load(index, position: finite(player.currentTime().seconds)) }
    func step(_ direction: Int) {
        if direction < 0 && player.currentTime().seconds > 3 { seek(0); return }
        let target = index + direction
        if queue.indices.contains(target) { load(target) }
        else if repeatMode == 1 && !queue.isEmpty { load(direction > 0 ? 0 : queue.count - 1) }
    }
    func setRepeat(_ mode: Int) { repeatMode = min(2, max(0, mode)); preloadNext() }
    private func finite(_ value: Double) -> Double { value.isFinite ? max(0, value) : 0 }

    var state: [String: Any] {
        let time = finite(player.currentTime().seconds)
        let duration = finite(player.currentItem?.duration.seconds ?? 0)
        let buffered = player.currentItem?.loadedTimeRanges.compactMap { value -> Double? in
            let range = value.timeRangeValue
            return range.start.seconds <= time + 0.5 ? finite(CMTimeRangeGetEnd(range).seconds) : nil
        }.max() ?? time
        return ["key": queue.indices.contains(index) ? queue[index].key : "",
                "playing": player.rate > 0, "time": time, "duration": duration,
                "loading": resolving || player.timeControlStatus == .waitingToPlayAtSpecifiedRate,
                "preparing": resolving, "error": error, "ended": ended, "buffered": buffered,
                "editableQueue": !queue.isEmpty, "positionVersion": positionVersion,
                "index": index, "count": queue.count, "volume": Int(player.volume * 100)]
    }
    private func publish() {
        if queue.indices.contains(index) {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = [
                MPMediaItemPropertyTitle: queue[index].title,
                MPMediaItemPropertyArtist: queue[index].authorName,
                MPNowPlayingInfoPropertyElapsedPlaybackTime: finite(player.currentTime().seconds),
                MPMediaItemPropertyPlaybackDuration: finite(player.currentItem?.duration.seconds ?? 0),
                MPNowPlayingInfoPropertyPlaybackRate: player.rate
            ]
        }
        onChange?()
    }
}

enum StreamResolver {
    static func resolve(_ id: String) async throws -> URL {
        guard validVideoID(id) else { throw SpotError.message("Invalid video link.") }
        let streams = try await YouTube(videoID: id, methods: [.local, .remote]).streams
        guard let stream = streams.filterAudioOnly().filter({ $0.isNativelyPlayable })
            .max(by: { ($0.bitrate ?? 0) < ($1.bitrate ?? 0) }) else {
            throw SpotError.message("No playable audio is available for this video.")
        }
        try await stream.waitUntilAvailable()
        return stream.url
    }
}
