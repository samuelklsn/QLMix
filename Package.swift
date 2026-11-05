// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "QLMix",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "YamahaQLProtocol", targets: ["YamahaQLProtocol"]),
        .library(name: "YamahaQLNetwork", targets: ["YamahaQLNetwork"]),
        .executable(name: "QLMix", targets: ["QLMix"]),
        .executable(name: "QLSimulator", targets: ["QLSimulator"]),
    ],
    targets: [
        // Pure, platform-independent protocol layer (encoding / decoding / value conversion).
        .target(name: "YamahaQLProtocol"),
        // Network.framework based TCP client with reconnect + keepalive.
        .target(name: "YamahaQLNetwork", dependencies: ["YamahaQLProtocol"]),
        // SwiftUI macOS app.
        .executableTarget(name: "QLMix", dependencies: ["YamahaQLProtocol", "YamahaQLNetwork"]),
        // Fake QL console for development without hardware.
        .executableTarget(name: "QLSimulator", dependencies: ["YamahaQLProtocol"]),
        .testTarget(name: "YamahaQLProtocolTests", dependencies: ["YamahaQLProtocol", "YamahaQLNetwork"]),
    ]
)
