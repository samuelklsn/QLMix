import Foundation
import Network
import YamahaQLProtocol

/// Connection parameters for a console.
public struct ConnectionConfiguration: Hashable, Sendable {
    public var host: String
    public var port: UInt16
    public var autoReconnect: Bool
    /// Interval for the keepalive probe (`devstatus runmode`).
    public var keepAliveInterval: Duration
    /// Connection is considered dead if nothing was received for this long.
    public var receiveTimeout: Duration
    public var connectTimeout: Duration
    public var maxReconnectDelay: Duration

    public static let defaultPort: UInt16 = 49280

    public init(
        host: String,
        port: UInt16 = ConnectionConfiguration.defaultPort,
        autoReconnect: Bool = true,
        keepAliveInterval: Duration = .seconds(3),
        receiveTimeout: Duration = .seconds(10),
        connectTimeout: Duration = .seconds(5),
        maxReconnectDelay: Duration = .seconds(10)
    ) {
        self.host = host
        self.port = port
        self.autoReconnect = autoReconnect
        self.keepAliveInterval = keepAliveInterval
        self.receiveTimeout = receiveTimeout
        self.connectTimeout = connectTimeout
        self.maxReconnectDelay = maxReconnectDelay
    }
}

public enum ConnectionState: Hashable, Sendable {
    case idle
    case connecting
    case connected
    case reconnecting(attempt: Int, delay: Duration, reason: String)
    case failed(String)

    public var isConnected: Bool { self == .connected }
}

public enum ConnectionEvent: Sendable {
    case stateChanged(ConnectionState)
    case received(RCPMessage, raw: String)
    case sent(String)
    case diagnostic(String)
}

/// TCP client for the Yamaha RCP protocol (port 49280).
///
/// * All state is isolated in this actor.
/// * Incoming lines are delivered in order through `events`.
/// * Reconnects with exponential backoff and detects dead links via a keepalive probe.
public actor ConsoleConnection {
    public nonisolated let events: AsyncStream<ConnectionEvent>
    private let continuation: AsyncStream<ConnectionEvent>.Continuation

    private var configuration: ConnectionConfiguration?
    private var connection: NWConnection?
    /// Incremented for every new NWConnection; callbacks from stale ones are ignored.
    private var generation = 0
    private var framer = LineFramer()
    private var state: ConnectionState = .idle
    private var wantsConnection = false
    private var reconnectAttempt = 0
    private var lastReceive = ContinuousClock.now

    private var reconnectTask: Task<Void, Never>?
    private var keepAliveTask: Task<Void, Never>?
    private var connectTimeoutTask: Task<Void, Never>?

    private let queue = DispatchQueue(label: "YamahaQL.ConsoleConnection")

    public init() {
        let (stream, continuation) = AsyncStream.makeStream(of: ConnectionEvent.self, bufferingPolicy: .unbounded)
        self.events = stream
        self.continuation = continuation
    }

    deinit {
        continuation.finish()
        connection?.cancel()
    }

    public var currentState: ConnectionState { state }

    // MARK: Public API

    public func connect(_ configuration: ConnectionConfiguration) {
        tearDown()
        self.configuration = configuration
        wantsConnection = true
        reconnectAttempt = 0
        startConnection()
    }

    public func disconnect() {
        wantsConnection = false
        tearDown()
        setState(.idle)
    }

    /// Sends a single command. Dropped (with a diagnostic) when not connected.
    public func send(_ command: RCPCommand) {
        send([command])
    }

    /// Sends several commands in one TCP write.
    public func send(_ commands: [RCPCommand]) {
        guard !commands.isEmpty else { return }
        guard state == .connected, let connection else {
            continuation.yield(.diagnostic("Nicht verbunden – \(commands.count) Befehl(e) verworfen"))
            return
        }
        var bytes: [UInt8] = []
        for command in commands {
            bytes += command.wireData
            continuation.yield(.sent(command.line))
        }
        let gen = generation
        connection.send(content: Data(bytes), completion: .contentProcessed { [weak self] error in
            guard let error else { return }
            let text = error.localizedDescription
            Task { await self?.connectionLost("Sendefehler: \(text)", generation: gen) }
        })
    }

    // MARK: Connection lifecycle

    private func startConnection() {
        guard let configuration else { return }
        generation += 1
        let gen = generation
        framer.reset()

        guard let port = NWEndpoint.Port(rawValue: configuration.port), !configuration.host.isEmpty else {
            setState(.failed("Ungültige Adresse \(configuration.host):\(configuration.port)"))
            return
        }

        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        tcp.enableKeepalive = true
        tcp.keepaliveIdle = 5
        tcp.keepaliveInterval = 2
        tcp.keepaliveCount = 3
        tcp.connectionTimeout = Int(configuration.connectTimeout.components.seconds)
        let params = NWParameters(tls: nil, tcp: tcp)

        let conn = NWConnection(host: NWEndpoint.Host(configuration.host), port: port, using: params)
        conn.stateUpdateHandler = { [weak self] nwState in
            let transport = TransportState(nwState)
            Task { await self?.handle(transport, generation: gen) }
        }
        connection = conn
        setState(.connecting)
        continuation.yield(.diagnostic("Verbinde mit \(configuration.host):\(configuration.port) …"))
        conn.start(queue: queue)

        connectTimeoutTask = Task { [weak self, timeout = configuration.connectTimeout] in
            try? await Task.sleep(for: timeout)
            guard !Task.isCancelled else { return }
            await self?.connectTimedOut(generation: gen)
        }
    }

    private func connectTimedOut(generation gen: Int) {
        guard gen == generation, state == .connecting else { return }
        connectionLost("Zeitüberschreitung beim Verbindungsaufbau", generation: gen)
    }

    private func handle(_ transport: TransportState, generation gen: Int) {
        guard gen == generation else { return }
        switch transport {
        case .ready:
            connectTimeoutTask?.cancel()
            reconnectAttempt = 0
            lastReceive = .now
            setState(.connected)
            receiveNext(generation: gen)
            startKeepAlive(generation: gen)
        case .waiting(let reason):
            // e.g. "Connection refused" – NWConnection would retry silently; we prefer explicit control.
            connectionLost(reason, generation: gen)
        case .failed(let reason):
            connectionLost(reason, generation: gen)
        case .cancelled, .other:
            break
        }
    }

    private func receiveNext(generation gen: Int) {
        guard gen == generation, let connection else { return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            let errorText = error?.localizedDescription
            Task { await self?.didReceive(data, isComplete: isComplete, error: errorText, generation: gen) }
        }
    }

    private func didReceive(_ data: Data?, isComplete: Bool, error: String?, generation gen: Int) {
        guard gen == generation else { return }
        if let data, !data.isEmpty {
            lastReceive = .now
            for line in framer.append(data) {
                continuation.yield(.received(RCPMessage.parse(line), raw: line))
            }
        }
        if let error {
            connectionLost("Empfangsfehler: \(error)", generation: gen)
        } else if isComplete {
            connectionLost("Verbindung vom Pult geschlossen", generation: gen)
        } else {
            receiveNext(generation: gen)
        }
    }

    private func startKeepAlive(generation gen: Int) {
        keepAliveTask?.cancel()
        guard let interval = configuration?.keepAliveInterval else { return }
        keepAliveTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled, let self else { return }
                await self.keepAliveTick(generation: gen)
            }
        }
    }

    private func keepAliveTick(generation gen: Int) {
        guard gen == generation, state == .connected, let configuration else { return }
        if ContinuousClock.now - lastReceive > configuration.receiveTimeout {
            connectionLost("Keine Antwort vom Pult (Timeout)", generation: gen)
            return
        }
        send(.devstatus("runmode"))
    }

    private func connectionLost(_ reason: String, generation gen: Int) {
        guard gen == generation else { return }
        tearDown()
        continuation.yield(.diagnostic(reason))

        guard wantsConnection, let configuration, configuration.autoReconnect else {
            setState(.failed(reason))
            return
        }
        reconnectAttempt += 1
        let seconds = min(Double(1 << min(reconnectAttempt - 1, 6)), Double(configuration.maxReconnectDelay.components.seconds))
        let delay = Duration.seconds(max(seconds, 1))
        setState(.reconnecting(attempt: reconnectAttempt, delay: delay, reason: reason))

        let expected = generation
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.reconnectFired(expectedGeneration: expected)
        }
    }

    private func reconnectFired(expectedGeneration: Int) {
        guard wantsConnection, expectedGeneration == generation else { return }
        startConnection()
    }

    private func tearDown() {
        reconnectTask?.cancel()
        reconnectTask = nil
        keepAliveTask?.cancel()
        keepAliveTask = nil
        connectTimeoutTask?.cancel()
        connectTimeoutTask = nil
        generation += 1  // invalidate callbacks of the old connection
        connection?.stateUpdateHandler = nil
        connection?.cancel()
        connection = nil
        framer.reset()
    }

    private func setState(_ newState: ConnectionState) {
        guard newState != state else { return }
        state = newState
        continuation.yield(.stateChanged(newState))
    }
}

/// Sendable snapshot of `NWConnection.State`.
private enum TransportState: Sendable {
    case ready
    case waiting(String)
    case failed(String)
    case cancelled
    case other

    init(_ state: NWConnection.State) {
        switch state {
        case .ready: self = .ready
        case .waiting(let error): self = .waiting(Self.describe(error))
        case .failed(let error): self = .failed(Self.describe(error))
        case .cancelled: self = .cancelled
        default: self = .other
        }
    }

    static func describe(_ error: NWError) -> String {
        switch error {
        case .posix(let code):
            switch code {
            case .ECONNREFUSED: return "Verbindung abgelehnt (Port geschlossen?)"
            case .EHOSTUNREACH, .ENETUNREACH: return "Pult nicht erreichbar (Netzwerk/IP prüfen)"
            case .ETIMEDOUT: return "Zeitüberschreitung"
            case .ECONNRESET: return "Verbindung zurückgesetzt"
            default: return "Netzwerkfehler: \(code)"
            }
        default:
            return "Netzwerkfehler: \(error.localizedDescription)"
        }
    }
}
