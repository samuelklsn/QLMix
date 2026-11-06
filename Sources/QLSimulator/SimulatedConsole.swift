import Foundation
import Network
import YamahaQLProtocol

/// A minimal fake Yamaha CL/QL console speaking the RCP text protocol.
///
/// All mutable state lives on `queue` (hence `@unchecked Sendable`).
final class SimulatedConsole: @unchecked Sendable {
    struct Options {
        var port: UInt16 = 49280
        var model: ConsoleModel = .ql5
        var animate = false
        var verbose = false
        /// Simulate a console without EQ over RCP.
        var noEQ = false
        /// Reported by `devinfo version`.
        var firmware = "V5.81 (Simulator)"
    }

    private final class Client: @unchecked Sendable {
        let id: Int
        let connection: NWConnection
        var framer = LineFramer()
        var meterTimers: [String: DispatchSourceTimer] = [:]
        init(id: Int, connection: NWConnection) {
            self.id = id
            self.connection = connection
        }
    }

    private let options: Options
    private let queue = DispatchQueue(label: "QLSimulator")
    private var listener: NWListener?
    private var clients: [Int: Client] = [:]
    private var nextClientID = 1
    private var values: [String: RCPValue] = [:]
    private var currentScene = 1
    private var animationTimer: DispatchSourceTimer?

    init(options: Options) {
        self.options = options
        seedDefaults()
    }

    func start() throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        guard let port = NWEndpoint.Port(rawValue: options.port) else { throw POSIXError(.EINVAL) }
        let listener = try NWListener(using: params, on: port)
        listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        listener.stateUpdateHandler = { [options] state in
            switch state {
            case .ready: print("▶︎ \(options.model.name)-Simulator lauscht auf TCP \(options.port)")
            case .failed(let error): print("✖︎ Listener-Fehler: \(error)"); exit(1)
            default: break
            }
        }
        listener.start(queue: queue)
        self.listener = listener

        if options.animate {
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + 2, repeating: 1.5)
            timer.setEventHandler { [weak self] in self?.animateRandomParameter() }
            timer.resume()
            animationTimer = timer
        }
    }

    // MARK: State

    private func key(_ address: String, _ x: Int, _ y: Int) -> String { "\(address) \(x) \(y)" }

    private func seedDefaults() {
        let names = ["Kick", "Snare", "HiHat", "Tom 1", "Tom 2", "OH L", "OH R", "Bass",
                     "Git 1", "Git 2", "Keys L", "Keys R", "Vox 1", "Vox 2", "Vox 3", "Talk"]
        let colors: [LabelColor] = [.red, .red, .red, .red, .red, .red, .red, .orange,
                                    .yellow, .yellow, .green, .green, .cyan, .cyan, .cyan, .purple]
        for id in options.model.allChannels {
            let primary = id.kind.primaryWireIndex(for: id.index)
            for x in id.kind.wireIndices(for: id.index) {
                func set(_ p: ChannelParameter, _ v: RCPValue) {
                    values[key(ParameterKey.channel(id, p).address, x, 0)] = v
                }
                let level: Int = switch id.kind {
                case .input: id.index < 16 ? [-500, -300, -1000, -800, 0][id.index % 5] : FaderLevel.negativeInfinityRaw
                case .dca, .mix, .matrix, .stereo: 0
                default: FaderLevel.negativeInfinityRaw
                }
                set(.level, .int(level))
                set(.on, .int(1))
                set(.cue, .int(0))
                let name: String = switch id.kind {
                case .input: id.index < names.count ? names[id.index] : "ch \(id.number)"
                case .stereoInput: "StIn\(id.number)" + (x == primary ? "L" : "R")
                case .mix: id.index < 4 ? "Mon \(id.number)" : "MX \(id.number)"
                case .matrix: "MT \(id.number)"
                case .stereo: x == 0 ? "ST L" : "ST R"
                case .mono: "MONO"
                case .dca: ["Drums", "Bass", "Git", "Keys", "Vox"].indices.contains(id.index)
                    ? ["Drums", "Bass", "Git", "Keys", "Vox"][id.index] : "DCA \(id.number)"
                }
                set(.name, .string(name))
                let color: LabelColor = switch id.kind {
                case .input: id.index < colors.count ? colors[id.index] : .blue
                case .stereoInput: .blue
                case .mix, .matrix, .stereo, .mono: .orange
                case .dca: .yellow
                }
                set(.color, .string(color.rawValue))
                if id.kind == .input || id.kind == .stereoInput {
                    // Head amp gain (0.01 dB, −6 … +66 dB) – available on real CL/QL consoles.
                    values[key("MIXER:Current/\(id.kind.addressSegment)/Port/HA/Gain", x, 0)] = .int([2400, 3000, 1800, 4200][id.index % 4])
                }
                if id.kind.hasEQ, !options.noEQ {
                    let schema = EQSchema.peq
                    var eq = EQSettings()
                    if id.kind == .input, id.index < 16 {
                        eq.hpfOn = true
                        eq.hpfFrequency = [100, 120, 200, 80, 80, 150, 150, 40][id.index % 8]
                        eq.bands[1].gain = [-3, 2, -4.5, 0][id.index % 4]
                        eq.bands[2].gain = [2.5, -2, 3, 1.5][id.index % 4]
                        eq.bands[3].gain = id.index % 3 == 0 ? 3 : 0
                        eq.highShelf = id.index % 2 == 0
                    }
                    for p in EQKey.Parameter.all {
                        let k = EQKey(id, p)
                        values[key(k.address(schema: schema), x, k.wireTargets()[0].y)] = .int(eq.rawValue(for: p, schema: schema))
                    }
                }
                if id.kind.canSendToMix {
                    for mix in 0..<options.model.count(.mix) {
                        let lv = ParameterKey.send(id, mix: mix, .level).address
                        let on = ParameterKey.send(id, mix: mix, .on).address
                        values[key(lv, x, mix)] = .int(id.index < 16 && mix < 4 ? -1000 : FaderLevel.negativeInfinityRaw)
                        values[key(on, x, mix)] = .int(1)
                    }
                }
            }
        }
    }

    // MARK: Connections

    private func accept(_ connection: NWConnection) {
        let client = Client(id: nextClientID, connection: connection)
        nextClientID += 1
        clients[client.id] = client
        print("＋ Client \(client.id) verbunden: \(connection.endpoint)")
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.drop(client.id)
            default: break
            }
        }
        connection.start(queue: queue)
        receive(client)
    }

    private func drop(_ id: Int) {
        guard let client = clients.removeValue(forKey: id) else { return }
        client.meterTimers.values.forEach { $0.cancel() }
        client.connection.cancel()
        print("－ Client \(id) getrennt")
    }

    private func receive(_ client: Client) {
        client.connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self else { return }
            if let data {
                for line in client.framer.append(data) { self.handle(line, from: client) }
            }
            if complete || error != nil {
                self.drop(client.id)
            } else {
                self.receive(client)
            }
        }
    }

    private func send(_ line: String, to client: Client) {
        if options.verbose { print("→\(client.id) \(line)") }
        client.connection.send(content: Data((line + "\n").utf8), completion: .contentProcessed { _ in })
    }

    private func broadcast(_ line: String, except: Int? = nil) {
        for (id, client) in clients where id != except { send(line, to: client) }
    }

    // MARK: Command handling

    private func handle(_ line: String, from client: Client) {
        if options.verbose { print("←\(client.id) \(line)") }
        let t = RCPTokenizer.tokenize(line).map(\.text)
        guard let command = t.first else { return }

        switch command {
        case "get":
            guard t.count >= 4, let x = Int(t[2]), let y = Int(t[3]) else {
                return send("ERROR get WrongFormat", to: client)
            }
            guard let value = values[key(t[1], x, y)] else {
                return send("ERROR get UnknownAddress", to: client)
            }
            send("OK get \(t[1]) \(x) \(y) \(value.encoded)", to: client)

        case "set":
            let tokens = RCPTokenizer.tokenize(line)
            guard tokens.count >= 5, let x = Int(t[2]), let y = Int(t[3]) else {
                return send("ERROR set WrongFormat", to: client)
            }
            let k = key(t[1], x, y)
            guard let old = values[k] else { return send("ERROR set UnknownAddress", to: client) }
            let value: RCPValue
            switch old {
            case .int:
                guard var v = Int(t[4]) else { return send("ERROR set WrongFormat", to: client) }
                if t[1].hasSuffix("/Level") { v = FaderLevel(raw: v).raw }
                if t[1].hasSuffix("/On") { v = v == 0 ? 0 : 1 }
                value = .int(v)
            case .string:
                value = .string(String(t[4].prefix(8)))
            }
            values[k] = value
            send("OK set \(t[1]) \(x) \(y) \(value.encoded)", to: client)
            broadcast("NOTIFY set \(t[1]) \(x) \(y) \(value.encoded)", except: client.id)

        case "devinfo":
            switch t.dropFirst().first {
            case "productname": send("OK devinfo productname \"\(options.model.name)\"", to: client)
            case "version": send("OK devinfo version \"\(options.firmware)\"", to: client)
            default: send("ERROR devinfo UnknownAddress", to: client)
            }

        case "prminfo":
            let addresses = Array(Set(values.keys.map { String($0.split(separator: " ")[0]) })).sorted()
            guard t.count >= 2, let i = Int(t[1]), addresses.indices.contains(i) else {
                return send("ERROR prminfo InvalidArgument", to: client)
            }
            send("OK prminfo \(i) \"\(addresses[i])\" 0 0 0 0 0 \"\" integer any rw 1", to: client)

        case "devstatus":
            send("OK devstatus runmode \"normal\"", to: client)

        case "sscurrent_ex":
            send("OK sscurrent_ex \(RCPCommand.sceneBank) \(currentScene)", to: client)

        case "ssrecall_ex":
            guard t.count >= 3, let n = Int(t[2]) else { return send("ERROR ssrecall_ex WrongFormat", to: client) }
            currentScene = n
            recallScene(n)
            send("OK ssrecall_ex \(RCPCommand.sceneBank) \(n)", to: client)
            broadcast("NOTIFY sscurrent_ex \(RCPCommand.sceneBank) \(n)")

        case "mtrstart":
            guard t.count >= 3, let source = MeterSource(address: t[1]) else {
                return send("ERROR mtrstart UnknownAddress", to: client)
            }
            let interval = max(50, Int(t[2]) ?? 100)
            startMeters(source, address: t[1], interval: interval, client: client)
            send("OK mtrstart \(t[1]) \(interval)", to: client)

        case "mtrstop":
            if t.count >= 2 { client.meterTimers.removeValue(forKey: t[1])?.cancel() }
            send("OK mtrstop \(t.dropFirst().joined(separator: " "))", to: client)

        default:
            send("ERROR \(command) UnknownCommand", to: client)
        }
    }

    private func recallScene(_ n: Int) {
        // Deterministically "recall" different input fader positions.
        for i in 0..<min(16, options.model.count(.input)) {
            let key = key(ParameterKey.channel(ChannelID(.input, i), .level).address, i, 0)
            values[key] = .int(-((n * 7 + i * 3) % 30) * 100)
        }
    }

    private func startMeters(_ source: MeterSource, address: String, interval: Int, client: Client) {
        client.meterTimers[address]?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(interval))
        let count = options.model.count(source.kind)
        let levelAddress = ParameterKey.channel(ChannelID(source.kind, 0), .level).address
        let onAddress = ParameterKey.channel(ChannelID(source.kind, 0), .on).address
        timer.setEventHandler { [weak self, weak client] in
            guard let self, let client else { return }
            let t = Date().timeIntervalSinceReferenceDate
            let bytes = (0..<count).map { i -> String in
                let fader = self.values[self.key(levelAddress, i, 0)]?.intValue ?? FaderLevel.negativeInfinityRaw
                let on = self.values[self.key(onAddress, i, 0)]?.intValue ?? 1
                var raw = 0
                if on == 1, let dB = FaderLevel(raw: fader).dB {
                    let signal = -18 + 8 * sin(t * (1.3 + Double(i) * 0.37)) + Double.random(in: -3...3)
                    raw = max(0, min(127, Int(126 + signal + dB)))
                }
                return String(format: "%02x", raw)
            }
            self.send("NOTIFY mtr \(address) PostOn \(bytes.joined(separator: " "))", to: client)
        }
        timer.resume()
        client.meterTimers[address] = timer
    }

    /// Simulates a second operator moving a fader.
    private func animateRandomParameter() {
        let i = Int.random(in: 0..<min(8, options.model.count(.input)))
        let address = ParameterKey.channel(ChannelID(.input, i), .level).address
        let value = Int.random(in: -3000...500)
        values[key(address, i, 0)] = .int(value)
        broadcast("NOTIFY set \(address) \(i) 0 \(value) \"\(FaderLevel(raw: value).displayString)\"")
    }
}
