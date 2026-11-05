/// Splits a TCP byte stream into LF-terminated lines (CR is stripped).
public struct LineFramer: Sendable {
    private var buffer: [UInt8] = []
    /// Guard against a peer that never sends a newline.
    public var maxLineLength = 64 * 1024

    public init() {}

    public mutating func append<C: Collection>(_ bytes: C) -> [String] where C.Element == UInt8 {
        buffer.append(contentsOf: bytes)
        var lines: [String] = []
        var start = 0
        for i in buffer.indices where buffer[i] == 0x0A {
            var end = i
            if end > start, buffer[end - 1] == 0x0D { end -= 1 }
            if end > start {
                lines.append(Self.decode(buffer[start..<end]))
            }
            start = i + 1
        }
        if start > 0 { buffer.removeFirst(start) }
        if buffer.count > maxLineLength { buffer.removeAll() }
        return lines
    }

    public mutating func reset() { buffer.removeAll() }

    static func decode(_ bytes: ArraySlice<UInt8>) -> String {
        if let s = String(validating: bytes, as: UTF8.self) { return s }
        // Fallback: Latin-1 (console names may contain non UTF-8 bytes)
        return String(bytes.map { Character(Unicode.Scalar($0)) })
    }
}
