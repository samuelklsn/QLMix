import Foundation
import Observation
import YamahaQLNetwork

/// User preferences, persisted in `UserDefaults`.
@MainActor
@Observable
final class AppSettings {
    private let defaults: UserDefaults

    var host: String { didSet { defaults.set(host, forKey: Keys.host) } }
    var port: Int { didSet { defaults.set(port, forKey: Keys.port) } }
    var autoConnect: Bool { didSet { defaults.set(autoConnect, forKey: Keys.autoConnect) } }
    var metersEnabled: Bool { didSet { defaults.set(metersEnabled, forKey: Keys.metersEnabled) } }
    var meterIntervalMs: Int { didSet { defaults.set(meterIntervalMs, forKey: Keys.meterInterval) } }
    var logMeters: Bool { didSet { defaults.set(logMeters, forKey: Keys.logMeters) } }
    var hideKeepAlive: Bool { didSet { defaults.set(hideKeepAlive, forKey: Keys.hideKeepAlive) } }
    /// Fader moves are coalesced and sent at most every N ms.
    var faderSendIntervalMs: Int { didSet { defaults.set(faderSendIntervalMs, forKey: Keys.faderInterval) } }
    var confirmSceneRecall: Bool { didSet { defaults.set(confirmSceneRecall, forKey: Keys.confirmScene) } }

    private enum Keys {
        static let host = "host"
        static let port = "port"
        static let autoConnect = "autoConnect"
        static let metersEnabled = "metersEnabled"
        static let meterInterval = "meterIntervalMs"
        static let logMeters = "logMeters"
        static let hideKeepAlive = "hideKeepAlive"
        static let faderInterval = "faderSendIntervalMs"
        static let confirmScene = "confirmSceneRecall"
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        defaults.register(defaults: [
            Keys.host: "192.168.0.128",
            Keys.port: Int(ConnectionConfiguration.defaultPort),
            Keys.autoConnect: false,
            Keys.metersEnabled: true,
            Keys.meterInterval: 100,
            Keys.logMeters: false,
            Keys.hideKeepAlive: true,
            Keys.faderInterval: 30,
            Keys.confirmScene: true,
        ])
        host = defaults.string(forKey: Keys.host) ?? ""
        port = defaults.integer(forKey: Keys.port)
        autoConnect = defaults.bool(forKey: Keys.autoConnect)
        metersEnabled = defaults.bool(forKey: Keys.metersEnabled)
        meterIntervalMs = defaults.integer(forKey: Keys.meterInterval)
        logMeters = defaults.bool(forKey: Keys.logMeters)
        hideKeepAlive = defaults.bool(forKey: Keys.hideKeepAlive)
        faderSendIntervalMs = defaults.integer(forKey: Keys.faderInterval)
        confirmSceneRecall = defaults.bool(forKey: Keys.confirmScene)
    }

    var connectionConfiguration: ConnectionConfiguration {
        ConnectionConfiguration(
            host: host.trimmingCharacters(in: .whitespacesAndNewlines),
            port: UInt16(clamping: port)
        )
    }
}
