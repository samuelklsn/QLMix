import Foundation
import Observation
import YamahaQLNetwork
import YamahaQLProtocol

/// What the faders of input strips control.
enum FaderMode: Hashable {
    /// Channel faders (main mix).
    case main
    /// "Sends on fader": input faders control the send level to mix bus `n` (zero-based).
    case mix(Int)
}

/// A bank of strips shown in the main area.
enum Layer: Hashable, Identifiable {
    case inputs(page: Int)
    case stereoInputs
    case mixes
    case matrices
    case dcas

    static let inputsPerPage = 16

    var id: Self { self }

    static func available(for model: ConsoleModel) -> [Layer] {
        let pages = (model.count(.input) + inputsPerPage - 1) / inputsPerPage
        return (0..<pages).map { .inputs(page: $0) } + [.stereoInputs, .mixes, .matrices, .dcas]
    }

    func title(for model: ConsoleModel) -> String {
        switch self {
        case .inputs(let page):
            let first = page * Self.inputsPerPage + 1
            let last = min(first + Self.inputsPerPage - 1, model.count(.input))
            return "CH \(first)–\(last)"
        case .stereoInputs: return "ST IN"
        case .mixes: return "MIX"
        case .matrices: return "MATRIX"
        case .dcas: return "DCA"
        }
    }

    func channels(for model: ConsoleModel) -> [ChannelID] {
        switch self {
        case .inputs(let page):
            let range = (page * Self.inputsPerPage)..<min((page + 1) * Self.inputsPerPage, model.count(.input))
            return range.map { ChannelID(.input, $0) }
        case .stereoInputs: return model.channels(.stereoInput)
        case .mixes: return model.channels(.mix)
        case .matrices: return model.channels(.matrix)
        case .dcas: return model.channels(.dca)
        }
    }
}

enum EQStatus: Equatable {
    case unknown
    case probing
    case available(EQSchema)
    case unavailable
}

enum MeterStatus: Equatable {
    case disabled
    case requested
    case active
    case unsupported(String)
}

/// Central app state: mirrors the console parameters and translates UI actions
/// into RCP commands.
@MainActor
@Observable
final class MixerStore {
    let settings: AppSettings
    let log = ProtocolLog()

    private(set) var connectionState: ConnectionState = .idle
    private(set) var model: ConsoleModel = .ql5
    private(set) var productName: String?
    private(set) var firmwareVersion: String?
    private(set) var channels: [ChannelID: ChannelState] = [:]
    private(set) var currentScene: Int?
    private(set) var meterStatus: MeterStatus = .disabled
    private(set) var isSyncing = false
    private(set) var lastError: String?

    var layer: Layer = .inputs(page: 0) {
        didSet { if layer != oldValue { syncVisibleEQ() } }
    }
    private(set) var eqStatus: EQStatus = .unknown
    /// Channel shown in the EQ inspector.
    var eqChannel: ChannelID? {
        didSet { if let id = eqChannel { syncEQ([id]) } }
    }
    private(set) var dumpProgress: DumpProgress?
    var faderMode: FaderMode = .main {
        didSet { if faderMode != oldValue { syncSendsIfNeeded() } }
    }

    // MARK: Private plumbing

    @ObservationIgnored private let connection = ConsoleConnection()
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var outboxTask: Task<Void, Never>?
    @ObservationIgnored private var outbox: AsyncStream<OutboxItem>.Continuation?
    @ObservationIgnored private var syncGeneration = 0

    /// Identity of an outgoing value for coalescing.
    private enum OutKey: Hashable {
        case param(ParameterKey)
        case eq(EQKey)
    }

    /// Coalesced outgoing `set`s (latest value wins).
    @ObservationIgnored private var pending: [OutKey: [RCPCommand]] = [:]
    @ObservationIgnored private var pendingOrder: [OutKey] = []
    @ObservationIgnored private var flushTask: Task<Void, Never>?

    /// Parameters currently held by the user – incoming values are ignored to avoid jitter.
    @ObservationIgnored private var touching: Set<OutKey> = []
    @ObservationIgnored private var eqRequested: Set<ChannelID> = []
    @ObservationIgnored private var dumpLines: [String] = []
    @ObservationIgnored private var lastDumpLine = ContinuousClock.now
    @ObservationIgnored private var syncedSendMixes: Set<Int> = []
    @ObservationIgnored private var awaitingModel = false
    @ObservationIgnored private var lastMeterUpdate = ContinuousClock.now
    @ObservationIgnored private var meterWatchdog: Task<Void, Never>?

    private enum OutboxItem {
        case commands([RCPCommand])
        /// Part of a (re)sync; dropped if a newer sync started in the meantime.
        case sync(generation: Int, [RCPCommand])
        case pause(Duration)
        case syncFinished(generation: Int)
    }

    init(settings: AppSettings) {
        self.settings = settings
        rebuildChannels()
        startEventLoop()
        startOutbox()
        if settings.autoConnect, !settings.host.isEmpty {
            connect()
        }
    }

    // MARK: Connection

    var isConnected: Bool { connectionState.isConnected }

    func connect() {
        let config = settings.connectionConfiguration
        lastError = nil
        meterStatus = .disabled
        log.append(.info, "Verbinde mit \(config.host):\(config.port)")
        Task { await connection.connect(config) }
    }

    func disconnect() {
        Task { await connection.disconnect() }
    }

    private func startEventLoop() {
        let events = connection.events
        eventTask = Task { [weak self] in
            for await event in events {
                guard let self else { return }
                self.handle(event)
            }
        }
    }

    /// A single consumer guarantees that commands go out in the order they were issued.
    private func startOutbox() {
        let (stream, continuation) = AsyncStream.makeStream(of: OutboxItem.self)
        outbox = continuation
        let connection = connection
        outboxTask = Task { [weak self] in
            for await item in stream {
                switch item {
                case .commands(let commands):
                    await connection.send(commands)
                case let .sync(generation, commands):
                    guard self?.syncGeneration == generation else { continue }
                    await connection.send(commands)
                case .pause(let duration):
                    try? await Task.sleep(for: duration)
                case .syncFinished(let generation):
                    if self?.syncGeneration == generation { self?.isSyncing = false }
                }
            }
        }
    }

    private func send(_ commands: [RCPCommand]) {
        guard !commands.isEmpty else { return }
        outbox?.yield(.commands(commands))
    }

    /// Sends a free-form line (log window console).
    func sendRaw(_ line: String) {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        send([.raw(trimmed)])
    }

    // MARK: Event handling

    private func handle(_ event: ConnectionEvent) {
        switch event {
        case .stateChanged(let state):
            connectionState = state
            log.append(.info, "Status: \(state.logDescription)")
            switch state {
            case .connected:
                didConnect()
            case .failed(let reason):
                lastError = reason
                didDisconnect()
            case .reconnecting(_, _, let reason):
                lastError = reason
                didDisconnect()
            case .idle:
                didDisconnect()
            case .connecting:
                break
            }

        case .sent(let line):
            if settings.hideKeepAlive, line == "devstatus runmode" { return }
            log.append(.outgoing, line)

        case let .received(message, raw):
            if dumpProgress?.isRunning == true, Self.isDumpLine(raw) {
                dumpLines.append(raw)
                lastDumpLine = .now
                dumpProgress = .running(received: dumpLines.count)
            }
            if case .meter = message {
                if settings.logMeters { log.append(.incoming, raw) }
            } else if !(settings.hideKeepAlive && raw.hasPrefix("OK devstatus runmode")) {
                log.append(.incoming, raw)
            }
            handle(message)

        case .diagnostic(let text):
            log.append(.info, text)
        }
    }

    private func handle(_ message: RCPMessage) {
        switch message {
        case let .parameter(status, _, report):
            guard status != .error else { return }
            if eqStatus == .probing, report.x == 0,
               let schema = EQSchema.candidates.first(where: { $0.probeAddress() == report.address }) {
                eqStatus = .available(schema)
                log.append(.info, "EQ verfügbar (Adressschema \(schema.name))")
                syncVisibleEQ()
                if let id = eqChannel { syncEQ([id]) }
            }
            if case .available(let schema) = eqStatus,
               let key = EQKey.decode(address: report.address, x: report.x, y: report.y, schema: schema) {
                applyEQ(key, report.value, schema: schema)
                return
            }
            guard let key = ParameterKey.decode(address: report.address, x: report.x, y: report.y) else { return }
            apply(key, report.value)

        case let .meter(address, values):
            guard let source = MeterSource(address: address) else { return }
            lastMeterUpdate = .now
            if meterStatus != .active { meterStatus = .active }
            for (i, raw) in values.enumerated() {
                channels[ChannelID(source.kind, i)]?.updateMeter(MeterScale.normalized(raw: raw))
            }

        case let .scene(status, command, _, number):
            let changed = currentScene != number
            currentScene = number
            // Someone recalled a scene (console, other app or us) → refresh everything.
            if status == .notify || (command.hasPrefix("ssrecall") && status == .ok) {
                if changed || command.hasPrefix("ssrecall") {
                    log.append(.info, "Szene \(number) aufgerufen – synchronisiere …")
                    fullSync()
                }
            }

        case let .info(status, command, arguments):
            guard status == .ok || status == .notify else { return }
            if command == "devinfo", arguments.first == "productname", arguments.count >= 2 {
                productName = arguments[1]
                let detected = ConsoleModel.from(productName: arguments[1])
                if detected != model {
                    model = detected
                    rebuildChannels()
                }
                if awaitingModel {
                    awaitingModel = false
                    fullSync()
                }
            } else if command == "devinfo", arguments.first == "version", arguments.count >= 2 {
                firmwareVersion = arguments[1]
            }

        case let .error(command, reason):
            if command == "mtrstart" {
                meterStatus = .unsupported(reason)
                log.append(.info, "Meter werden vom Pult nicht unterstützt (\(reason))")
            }

        case .unknown:
            break
        }
    }

    private func apply(_ key: ParameterKey, _ value: RCPValue) {
        guard !touching.contains(.param(key)), pending[.param(key)] == nil else { return }
        guard let channel = channels[key.channel] else { return }
        switch key {
        case .channel(_, .level):
            if let raw = value.intValue { channel.level = FaderLevel(raw: raw) }
        case .channel(_, .on):
            if let v = value.intValue { channel.isOn = v != 0 }
        case .channel(_, .cue):
            if let v = value.intValue { channel.cue = v != 0 }
        case .channel(_, .name):
            channel.name = value.stringValue ?? value.encoded
        case .channel(_, .color):
            channel.color = LabelColor(wireValue: value.stringValue ?? "")
        case let .send(_, mix, .level):
            if let raw = value.intValue { channel.sendLevels[mix] = FaderLevel(raw: raw) }
        case let .send(_, mix, .on):
            if let v = value.intValue { channel.sendOn[mix] = v != 0 }
        }
    }

    // MARK: Sync

    private func didConnect() {
        lastError = nil
        syncedSendMixes.removeAll()
        awaitingModel = true
        send([.devinfo("productname"), .devinfo("version")])
        // Fall back to the current model if the console doesn't answer `devinfo`.
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(1500))
            guard let self, self.awaitingModel, self.isConnected else { return }
            self.awaitingModel = false
            self.fullSync()
        }
        startMeters()
        probeEQ()
    }

    private func didDisconnect() {
        eqStatus = .unknown
        eqRequested.removeAll()
        for channel in channels.values { channel.eqSynced = false }
        syncGeneration += 1
        isSyncing = false
        touching.removeAll()
        pending.removeAll()
        pendingOrder.removeAll()
        meterWatchdog?.cancel()
        if case .unsupported = meterStatus {} else {
            meterStatus = settings.metersEnabled ? .requested : .disabled
        }
        for channel in channels.values { channel.resetMeter() }
    }

    /// Requests every parameter the app displays. Paced to avoid flooding the console.
    func fullSync() {
        guard isConnected else { return }
        syncGeneration += 1
        let generation = syncGeneration
        isSyncing = true
        syncedSendMixes.removeAll()

        var commands: [RCPCommand] = [.sceneCurrent]
        for id in model.allChannels {
            for parameter in ChannelParameter.allCases {
                commands.append(.get(.channel(id, parameter)))
            }
        }
        if case .mix(let mix) = faderMode {
            commands += sendSyncCommands(mix: mix)
            syncedSendMixes.insert(mix)
        }
        enqueueSync(commands, generation: generation)

        // EQ is fetched lazily (visible strips + inspector) – invalidate what we have.
        eqRequested.removeAll()
        for channel in channels.values { channel.eqSynced = false }
        syncVisibleEQ()
        if let id = eqChannel { syncEQ([id]) }
    }

    private func sendSyncCommands(mix: Int) -> [RCPCommand] {
        let sources = model.channels(.input) + model.channels(.stereoInput)
        return sources.flatMap { id in
            [RCPCommand.get(.send(id, mix: mix, .level)), .get(.send(id, mix: mix, .on))]
        }
    }

    private func syncSendsIfNeeded() {
        guard case .mix(let mix) = faderMode, isConnected, !syncedSendMixes.contains(mix) else { return }
        syncedSendMixes.insert(mix)
        let commands = sendSyncCommands(mix: mix)
        for chunk in commands.chunked(into: 32) {
            outbox?.yield(.commands(chunk))
            outbox?.yield(.pause(.milliseconds(10)))
        }
    }

    private func enqueueSync(_ commands: [RCPCommand], generation: Int) {
        for chunk in commands.chunked(into: 32) {
            outbox?.yield(.sync(generation: generation, chunk))
            outbox?.yield(.pause(.milliseconds(12)))
        }
        outbox?.yield(.syncFinished(generation: generation))
    }

    // MARK: Meters

    func startMeters() {
        guard isConnected else { return }
        guard settings.metersEnabled else {
            meterStatus = .disabled
            return
        }
        if case .unsupported = meterStatus { return }
        meterStatus = .requested
        let interval = max(50, settings.meterIntervalMs)
        send(MeterSource.allCases.map { .meterStart(address: $0.rawValue, intervalMs: interval) })

        // Re-subscribe if the stream stalls.
        meterWatchdog?.cancel()
        meterWatchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self, !Task.isCancelled, self.isConnected, self.meterStatus == .active else { continue }
                if ContinuousClock.now - self.lastMeterUpdate > .seconds(3) {
                    self.send(MeterSource.allCases.map { .meterStart(address: $0.rawValue, intervalMs: interval) })
                }
            }
        }
    }

    func stopMeters() {
        meterWatchdog?.cancel()
        if isConnected {
            send(MeterSource.allCases.map { .meterStop(address: $0.rawValue) })
        }
        meterStatus = .disabled
        for channel in channels.values { channel.resetMeter() }
    }

    func retryMeters() {
        meterStatus = .disabled
        startMeters()
    }

    // MARK: Model helpers

    private func rebuildChannels() {
        var new: [ChannelID: ChannelState] = [:]
        for id in model.allChannels {
            new[id] = channels[id] ?? ChannelState(id: id)
        }
        channels = new
        if !Layer.available(for: model).contains(layer) { layer = .inputs(page: 0) }
        if case .mix(let m) = faderMode, m >= model.count(.mix) { faderMode = .main }
    }

    func channel(_ id: ChannelID) -> ChannelState? { channels[id] }

    func strips(for layer: Layer) -> [ChannelState] {
        layer.channels(for: model).compactMap { channels[$0] }
    }

    var layers: [Layer] { Layer.available(for: model) }

    /// Whether the strip's fader currently controls a send instead of the channel fader.
    func isSendMode(_ id: ChannelID) -> Bool {
        if case .mix = faderMode, id.kind.canSendToMix { return true }
        return false
    }

    func levelKey(for id: ChannelID) -> ParameterKey {
        if case .mix(let mix) = faderMode, id.kind.canSendToMix { return .send(id, mix: mix, .level) }
        return .channel(id, .level)
    }

    func onKey(for id: ChannelID) -> ParameterKey {
        if case .mix(let mix) = faderMode, id.kind.canSendToMix { return .send(id, mix: mix, .on) }
        return .channel(id, .on)
    }

    func displayedLevel(_ channel: ChannelState) -> FaderLevel {
        if case .mix(let mix) = faderMode, channel.id.kind.canSendToMix {
            return channel.sendLevels[mix] ?? .off
        }
        return channel.level
    }

    func displayedOn(_ channel: ChannelState) -> Bool {
        if case .mix(let mix) = faderMode, channel.id.kind.canSendToMix {
            return channel.sendOn[mix] ?? true
        }
        return channel.isOn
    }

    func mixName(_ mix: Int) -> String {
        channels[ChannelID(.mix, mix)]?.name ?? "MIX \(mix + 1)"
    }

    // MARK: User actions

    func setLevel(_ level: FaderLevel, for channel: ChannelState) {
        let key = levelKey(for: channel.id)
        switch key {
        case .send(_, let mix, _):
            guard channel.sendLevels[mix] != level else { return }
            channel.sendLevels[mix] = level
        default:
            guard channel.level != level else { return }
            channel.level = level
        }
        enqueue(key, .int(level.raw))
    }

    func toggleOn(_ channel: ChannelState) {
        let key = onKey(for: channel.id)
        let newValue = !displayedOn(channel)
        switch key {
        case .send(_, let mix, _): channel.sendOn[mix] = newValue
        default: channel.isOn = newValue
        }
        enqueue(key, .int(newValue ? 1 : 0), immediate: true)
    }

    func toggleCue(_ channel: ChannelState) {
        channel.cue.toggle()
        enqueue(.channel(channel.id, .cue), .int(channel.cue ? 1 : 0), immediate: true)
    }

    func rename(_ channel: ChannelState, to name: String) {
        let trimmed = String(name.prefix(8))
        channel.name = trimmed
        enqueue(.channel(channel.id, .name), .string(trimmed), immediate: true)
    }

    func setColor(_ color: LabelColor, for channel: ChannelState) {
        channel.color = color
        enqueue(.channel(channel.id, .color), .string(color.rawValue), immediate: true)
    }

    func beginTouch(_ channel: ChannelState) {
        touching.insert(.param(levelKey(for: channel.id)))
    }

    func endTouch(_ channel: ChannelState) {
        releaseTouch([.param(levelKey(for: channel.id))])
    }

    private func releaseTouch(_ keys: [OutKey]) {
        flush()
        // Keep ignoring echoes briefly so in-flight responses don't snap the control back.
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            for key in keys { self?.touching.remove(key) }
        }
    }

    func recallScene(_ number: Int) {
        guard (0...300).contains(number) else { return }
        send([.sceneRecall(number: number)])
    }

    // MARK: Outgoing coalescing

    private func enqueue(_ key: ParameterKey, _ value: RCPValue, immediate: Bool = false) {
        enqueue(.param(key), RCPCommand.set(key, value), immediate: immediate)
    }

    private func enqueue(_ key: OutKey, _ commands: [RCPCommand], immediate: Bool = false) {
        guard isConnected else { return }
        if pending[key] == nil { pendingOrder.append(key) }
        pending[key] = commands
        if immediate {
            flush()
        } else if flushTask == nil {
            let interval = max(10, settings.faderSendIntervalMs)
            flushTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(interval))
                guard !Task.isCancelled else { return }
                self?.flush()
            }
        }
    }

    private func flush() {
        flushTask?.cancel()
        flushTask = nil
        guard !pendingOrder.isEmpty else { return }
        let commands = pendingOrder.flatMap { pending[$0] ?? [] }
        pending.removeAll()
        pendingOrder.removeAll()
        send(commands)
    }
}

// MARK: - EQ

extension MixerStore {
    var eqSchema: EQSchema? {
        if case .available(let schema) = eqStatus { return schema }
        return nil
    }

    /// Asks for the EQ "On" parameter in every candidate schema; the first OK wins.
    fileprivate func probeEQ() {
        eqStatus = .probing
        send(EQSchema.candidates.map { .get(address: $0.probeAddress(), x: 0, y: 0) })
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard let self, self.eqStatus == .probing else { return }
            self.eqStatus = .unavailable
            self.log.append(.info, "EQ-Parameter werden vom Pult über RCP nicht beantwortet")
        }
    }

    func retryEQProbe() {
        guard isConnected else { return }
        probeEQ()
    }

    /// Requests all EQ parameters for channels that don't have them yet.
    func syncEQ(_ ids: [ChannelID]) {
        guard isConnected, let schema = eqSchema else { return }
        let targets = ids.filter { $0.kind.hasEQ && !eqRequested.contains($0) }
        guard !targets.isEmpty else { return }
        eqRequested.formUnion(targets)
        let commands = targets.flatMap { id in
            EQKey.Parameter.all.map { RCPCommand.get(EQKey(id, $0), schema: schema) }
        }
        for chunk in commands.chunked(into: 34) {
            outbox?.yield(.commands(chunk))
            outbox?.yield(.pause(.milliseconds(10)))
        }
    }

    func syncVisibleEQ() {
        var ids = layer.channels(for: model) + [ChannelID(.stereo, 0), ChannelID(.mono, 0)]
        if case .mix(let mix) = faderMode { ids.append(ChannelID(.mix, mix)) }
        syncEQ(ids)
    }

    fileprivate func applyEQ(_ key: EQKey, _ value: RCPValue, schema: EQSchema) {
        guard !touching.contains(.eq(key)), pending[.eq(key)] == nil,
              let channel = channels[key.channel], let raw = value.intValue
        else { return }
        channel.eq.apply(key.parameter, raw: raw, schema: schema)
        if !channel.eqSynced { channel.eqSynced = true }
    }

    /// Changes EQ values locally and sends the given parameters.
    func updateEQ(
        _ channel: ChannelState,
        _ parameters: [EQKey.Parameter],
        immediate: Bool = false,
        _ mutate: (inout EQSettings) -> Void
    ) {
        guard let schema = eqSchema else { return }
        var eq = channel.eq
        mutate(&eq)
        eq.clamp()
        guard eq != channel.eq else { return }
        let old = channel.eq
        channel.eq = eq
        for parameter in parameters where eq.rawValue(for: parameter, schema: schema) != old.rawValue(for: parameter, schema: schema) {
            let key = EQKey(channel.id, parameter)
            enqueue(.eq(key), RCPCommand.set(key, eq.rawValue(for: parameter, schema: schema), schema: schema), immediate: immediate)
        }
    }

    func beginEQTouch(_ channel: ChannelState, _ parameters: [EQKey.Parameter]) {
        for p in parameters { touching.insert(.eq(EQKey(channel.id, p))) }
    }

    func endEQTouch(_ channel: ChannelState, _ parameters: [EQKey.Parameter]) {
        releaseTouch(parameters.map { .eq(EQKey(channel.id, $0)) })
    }

    /// Resets all band gains to 0 dB.
    func flattenEQ(_ channel: ChannelState) {
        updateEQ(channel, (0..<eqBandCount).map { .bandGain($0) }, immediate: true) { eq in
            for i in eq.bands.indices { eq.bands[i].gain = 0 }
        }
    }

    /// Channels that have an EQ, in console order (for prev/next in the inspector).
    var eqChannels: [ChannelID] {
        model.allChannels.filter { $0.kind.hasEQ }
    }
}

// MARK: - Parameter list dump

enum DumpProgress: Equatable {
    case running(received: Int)
    case finished(URL, lines: Int)
    case failed(String)

    var isRunning: Bool {
        if case .running = self { return true }
        return false
    }
}

extension MixerStore {
    fileprivate static func isDumpLine(_ raw: String) -> Bool {
        let tokens = raw.split(separator: " ", maxSplits: 2)
        guard tokens.count >= 2 else { return false }
        // Only real answers – "ERROR prminfo …" just marks unused indices.
        return tokens[0] != "ERROR" && ["prminfo", "scninfo", "mtrinfo"].contains(tokens[1])
    }

    /// Asks the console for its complete RCP parameter list (`prminfo n`, `scninfo n`, `mtrinfo n`)
    /// and writes the answers to ~/Documents/QLMix/.
    func dumpParameterList() {
        guard isConnected, dumpProgress?.isRunning != true else { return }
        dumpLines = []
        lastDumpLine = .now
        dumpProgress = .running(received: 0)
        let commands: [RCPCommand] =
            (0..<1000).map { .raw("prminfo \($0)") }
            + (1000..<1100).map { .raw("scninfo \($0)") }
            + (2000..<2400).map { .raw("mtrinfo \($0)") }
        for chunk in commands.chunked(into: 20) {
            outbox?.yield(.commands(chunk))
            outbox?.yield(.pause(.milliseconds(25)))
        }
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            while let self, self.dumpProgress?.isRunning == true {
                if ContinuousClock.now - self.lastDumpLine > .seconds(3) || !self.isConnected {
                    self.finishDump()
                    return
                }
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
    }

    private func finishDump() {
        let header = [
            "# QLMix RCP-Parameterliste",
            "# Pult: \(productName ?? "?")  Firmware: \(firmwareVersion ?? "?")",
            "# Datum: \(Date.now.formatted(date: .numeric, time: .standard))",
            "",
        ]
        let text = (header + dumpLines).joined(separator: "\n") + "\n"
        do {
            let dir = URL.documentsDirectory.appending(path: "QLMix", directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd_HH-mm-ss"
            let stamp = formatter.string(from: .now)
            let url = dir.appending(path: "prminfo-\(productName ?? "console")-\(stamp).txt")
            try text.write(to: url, atomically: true, encoding: .utf8)
            dumpProgress = .finished(url, lines: dumpLines.count)
            log.append(.info, "Parameterliste gespeichert: \(url.path) (\(dumpLines.count) Zeilen)")
        } catch {
            dumpProgress = .failed(error.localizedDescription)
        }
    }
}

extension ConnectionState {
    var logDescription: String {
        switch self {
        case .idle: "getrennt"
        case .connecting: "verbinde …"
        case .connected: "verbunden"
        case let .reconnecting(attempt, delay, reason):
            "neuer Versuch #\(attempt) in \(delay.components.seconds) s (\(reason))"
        case .failed(let reason): "fehlgeschlagen: \(reason)"
        }
    }
}

extension Array {
    func chunked(into size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
    }
}
