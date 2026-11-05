import Foundation
import Observation

/// Ring buffer of protocol traffic for the log window.
@MainActor
@Observable
final class ProtocolLog {
    enum Direction: String {
        case outgoing = "→"
        case incoming = "←"
        case info = "•"
    }

    struct Entry: Identifiable, Hashable {
        let id: Int
        let date: Date
        let direction: Direction
        let text: String
    }

    private(set) var entries: [Entry] = []
    var isPaused = false
    var capacity = 5000
    @ObservationIgnored private var nextID = 0

    func append(_ direction: Direction, _ text: String) {
        guard !isPaused else { return }
        nextID += 1
        entries.append(Entry(id: nextID, date: .now, direction: direction, text: text))
        if entries.count > capacity {
            entries.removeFirst(entries.count - capacity)
        }
    }

    func clear() { entries.removeAll() }

    func exportText(_ items: [Entry]? = nil) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss.SSS"
        return (items ?? entries)
            .map { "\(formatter.string(from: $0.date)) \($0.direction.rawValue) \($0.text)" }
            .joined(separator: "\n")
    }
}
