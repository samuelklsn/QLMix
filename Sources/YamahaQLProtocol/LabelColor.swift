/// Channel label colors of CL/QL consoles (`Label/Color`).
public enum LabelColor: String, CaseIterable, Hashable, Sendable, Codable {
    case blue = "Blue"
    case orange = "Orange"
    case yellow = "Yellow"
    case purple = "Purple"
    case cyan = "Cyan"
    case magenta = "Magenta"
    case red = "Red"
    case green = "Green"
    case off = "Off"

    /// Lenient decoding, also accepts TF style names.
    public init(wireValue: String) {
        switch wireValue.lowercased() {
        case "skyblue": self = .cyan
        case "pink": self = .magenta
        default: self = LabelColor.allCases.first { $0.rawValue.lowercased() == wireValue.lowercased() } ?? .off
        }
    }

    /// sRGB components 0…1.
    public var rgb: (r: Double, g: Double, b: Double) {
        switch self {
        case .blue: (0.20, 0.42, 1.00)
        case .orange: (1.00, 0.55, 0.10)
        case .yellow: (0.98, 0.86, 0.15)
        case .purple: (0.62, 0.32, 0.92)
        case .cyan: (0.15, 0.85, 0.95)
        case .magenta: (0.96, 0.30, 0.78)
        case .red: (0.95, 0.22, 0.20)
        case .green: (0.25, 0.82, 0.35)
        case .off: (0.35, 0.35, 0.38)
        }
    }

    public var displayName: String {
        switch self {
        case .blue: "Blau"
        case .orange: "Orange"
        case .yellow: "Gelb"
        case .purple: "Lila"
        case .cyan: "Cyan"
        case .magenta: "Magenta"
        case .red: "Rot"
        case .green: "Grün"
        case .off: "Aus"
        }
    }
}
