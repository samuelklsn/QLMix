import Foundation
import Network

/// Simulates the CL/QL editor protocol (MIDI Parameter Change SysEx over TCP 50000):
/// `F0 43 3n 3E 19 01 <elem> <index> <ch> F7` requests a value, `F0 43 1n … <5 data bytes> F7` sets it.
/// Like the real console, changes are not pushed to other clients.
final class SysExConsole: @unchecked Sendable {
    private let port: UInt16
    private let queue = DispatchQueue(label: "QLSimulator.SysEx")
    private var listener: NWListener?
    private var values: [Int: Int32] = [:]   // key = elem << 32 | index << 16 | ch
    private var buffers: [ObjectIdentifier: [UInt8]] = [:]
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    private let verbose: Bool
    /// Channel (0-based) that "talks" in the simulated input meters.
    var talker = 0
    /// Channel (0-based) of a simulated room mic: hears the talker through the PA (talker fader + ON).
    var room: Int?
    /// Talker fader in dB if ON (nil = not audible through the PA).
    var talkerFaderDB: ((Int) -> Double?)?
    private var meterTimers: [ObjectIdentifier: DispatchSourceTimer] = [:]
    private var meterUntil: [ObjectIdentifier: Date] = [:]

    init(port: UInt16, inputs: Int, verbose: Bool) {
        self.port = port
        self.verbose = verbose
        seed(inputs: inputs)
    }

    private func k(_ e: Int, _ i: Int, _ ch: Int) -> Int { e << 32 | i << 16 | ch }

    private func seed(inputs: Int) {
        // EQ defaults (QL factory: LOW 125 Hz shelf, 1k, 4k, 10k shelf, Q index 23, HPF 80 Hz off)
        func eq(_ elem: Int, _ ch: Int) {
            values[k(elem, 2, ch)] = 1; values[k(elem, 3, ch)] = 1; values[k(elem, 4, ch)] = 1
            for (b, f) in [36, 72, 96, 112].enumerated() {
                values[k(elem, 8 + 4 * b, ch)] = 23; values[k(elem, 9 + 4 * b, ch)] = Int32(f); values[k(elem, 10 + 4 * b, ch)] = 0
            }
        }
        let inChannels = inputs + 16
        for ch in 0..<inChannels {
            eq(67, ch)
            values[k(66, 0, ch)] = ch < 8 ? 1 : 0
            values[k(66, 1, ch)] = 28
            // Dynamics 1: gate, Dynamics 2: compressor
            values[k(61, 0, ch)] = 0; values[k(61, 1, ch)] = 0; values[k(61, 16, ch)] = -260
            values[k(61, 10, ch)] = -56; values[k(61, 9, ch)] = 0; values[k(61, 11, ch)] = 80; values[k(61, 12, ch)] = 90
            values[k(64, 0, ch)] = ch < 4 ? 1 : 0; values[k(64, 1, ch)] = 0; values[k(64, 16, ch)] = -80
            values[k(64, 13, ch)] = 5; values[k(64, 9, ch)] = 30; values[k(64, 12, ch)] = 70; values[k(64, 14, ch)] = 0; values[k(64, 15, ch)] = 2
        }
        for ch in 0..<16 { eq(90, ch); values[k(88, 1, ch)] = 0; values[k(88, 16, ch)] = -80; values[k(88, 13, ch)] = 5 }
        for ch in 0..<8 { eq(107, ch) }
        for ch in 0..<3 { eq(121, ch) }
        // Premium rack names (4 chars per value, big endian) + some parameters
        func name(_ rack: Int, _ text: String) {
            let bytes = Array(text.utf8) + Array(repeating: 0, count: 16)
            for i in 0..<4 {
                let v = UInt32(bytes[i * 4]) << 24 | UInt32(bytes[i * 4 + 1]) << 16 | UInt32(bytes[i * 4 + 2]) << 8 | UInt32(bytes[i * 4 + 3])
                values[k(705, i, rack)] = Int32(bitPattern: v)
            }
        }
        name(0, "Portico5043"); values[k(132, 0, 0)] = 3
        name(3, "DynamicEQ"); values[k(132, 0, 3)] = 7
        for p in 0..<12 { values[k(705, 6 + p, 0)] = Int32(10 + p * 3); values[k(705, 6 + p, 3)] = Int32(20 + p) }
    }

    func start() throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        let listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
        listener.newConnectionHandler = { [weak self] c in self?.accept(c) }
        listener.stateUpdateHandler = { [port] state in
            if case .ready = state { print("▶︎ Editor-Protokoll (SysEx) auf TCP \(port)") }
        }
        listener.start(queue: queue)
        self.listener = listener
    }

    private func accept(_ c: NWConnection) {
        let id = ObjectIdentifier(c)
        connections[id] = c
        buffers[id] = []
        c.stateUpdateHandler = { [weak self] s in
            switch s { case .failed, .cancelled: self?.connections[id] = nil; self?.buffers[id] = nil; default: break }
        }
        c.start(queue: queue)
        receive(c)
    }

    private func receive(_ c: NWConnection) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, err in
            guard let self else { return }
            if let data { self.handle(Array(data), from: c) }
            if done || err != nil { c.cancel() } else { self.receive(c) }
        }
    }

    /// Streams input meters (88 records × 10 points) at 10 Hz for 10 s after each request, like the console.
    private func startMeters(for c: NWConnection) {
        let id = ObjectIdentifier(c)
        meterUntil[id] = Date().addingTimeInterval(10)
        guard meterTimers[id] == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(100))
        timer.setEventHandler { [weak self, weak c] in
            guard let self else { timer.cancel(); return }
            // Connection gone: forget the timer, otherwise a new connection with the same id never gets meters.
            guard let c else { timer.cancel(); self.meterTimers[id] = nil; return }
            if (self.meterUntil[id] ?? .distantPast) < Date() { timer.cancel(); self.meterTimers[id] = nil; return }
            let t = Date().timeIntervalSinceReferenceDate
            let talking = sin(t * 1.3) > -0.4   // speech with pauses
            // Room mic: direct voice (−60 dBFS) plus the PA (−40 dBFS + talker fader).
            var roomLevel: Double = 46 + Double.random(in: 0...2)
            if self.room != nil, talking {
                var power: Double = pow(10.0, -6.0)
                if let dB = self.talkerFaderDB?(self.talker) {
                    let pa: Double = -40.0 + dB + 4.0 * sin(t * 7.0)
                    power += pow(10.0, pa / 10.0)
                }
                let jitter: Double = Double.random(in: -1...1)
                roomLevel = 126.0 + 10.0 * log10(power) + jitter
            }
            var data = [UInt8](repeating: 0, count: 880)
            for ch in 0..<88 {
                var level: Double = ch < 64 ? 4 + Double.random(in: 0...2) : 0
                if ch == self.talker, talking { level = 72 + 8 * sin(t * 7) + Double.random(in: -3...3) }
                if ch == self.room { level = roomLevel }
                for p in 0..<8 where p != 6 { data[ch * 10 + p] = UInt8(max(0, min(126, level))) }
                data[ch * 10 + 8] = 126; data[ch * 10 + 9] = 126
            }
            let frame: [UInt8] = [0xF0, 0x43, 0x10, 0x3E, 0x19, 0x21, 0x00, 0x7F, 0x00] + data + [0xF7]
            c.send(content: Data(frame), completion: .contentProcessed { _ in })
        }
        timer.resume()
        meterTimers[id] = timer
    }

    private func handle(_ bytes: [UInt8], from c: NWConnection) {
        let id = ObjectIdentifier(c)
        var buf = (buffers[id] ?? []) + bytes
        var replies: [UInt8] = []
        while let start = buf.firstIndex(of: 0xF0), let end = buf[start...].firstIndex(of: 0xF7) {
            let m = Array(buf[start...end])
            buf.removeSubrange(..<(end + 1))
            if m.count >= 7, m[5] == 0x21, m[2] & 0xF0 == 0x30, m[6] == 0x00 { startMeters(for: c); continue }
            guard m.count >= 13, m[1] == 0x43, m[3] == 0x3E, m[5] == 0x01 else { continue }
            let elem = Int(m[6]) << 7 | Int(m[7]), index = Int(m[8]) << 7 | Int(m[9]), ch = Int(m[10]) << 7 | Int(m[11])
            if m[2] & 0xF0 == 0x10, m.count == 18 {
                let u = UInt32(m[12] & 0x0F) << 28 | UInt32(m[13]) << 21 | UInt32(m[14]) << 14 | UInt32(m[15]) << 7 | UInt32(m[16])
                values[k(elem, index, ch)] = Int32(bitPattern: u)
                if verbose { print("SysEx set \(elem)/\(index) ch\(ch) = \(Int32(bitPattern: u))") }
            } else if m[2] & 0xF0 == 0x30 {
                let v = UInt32(bitPattern: values[k(elem, index, ch)] ?? 0)
                replies += [0xF0, 0x43, 0x10, 0x3E, 0x19, 0x01, m[6], m[7], m[8], m[9], m[10], m[11],
                            UInt8((v >> 28) & 0x0F), UInt8((v >> 21) & 0x7F), UInt8((v >> 14) & 0x7F), UInt8((v >> 7) & 0x7F), UInt8(v & 0x7F), 0xF7]
            }
        }
        buffers[id] = buf
        if !replies.isEmpty { c.send(content: Data(replies), completion: .contentProcessed { _ in }) }
    }
}
