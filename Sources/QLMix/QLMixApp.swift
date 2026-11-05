import AppKit
import SwiftUI

@main
struct QLMixApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var settings: AppSettings
    @State private var store: MixerStore

    init() {
        let settings = AppSettings()
        _settings = State(initialValue: settings)
        _store = State(initialValue: MixerStore(settings: settings))
    }

    var body: some Scene {
        Window("QLMix", id: "main") {
            MixerView()
                .environment(store)
                .environment(settings)
                .frame(minWidth: 960, minHeight: 600)
                .preferredColorScheme(.dark)
        }
        .defaultSize(width: 1500, height: 820)
        .commands {
            CommandMenu("Pult") {
                Button("Verbinden") { store.connect() }
                    .keyboardShortcut("k", modifiers: .command)
                Button("Trennen") { store.disconnect() }
                    .keyboardShortcut("k", modifiers: [.command, .shift])
                Button("Neu synchronisieren") { store.fullSync() }
                    .keyboardShortcut("r", modifiers: .command)
                    .disabled(!store.isConnected)
                Divider()
                ForEach(Array(store.layers.prefix(9).enumerated()), id: \.offset) { index, layer in
                    Button(layer.title(for: store.model)) { store.layer = layer }
                        .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
                }
                Button(store.eqChannel == nil ? "EQ-Editor öffnen" : "EQ-Editor schließen") {
                    store.eqChannel = store.eqChannel == nil ? store.layer.channels(for: store.model).first : nil
                }
                .keyboardShortcut("e", modifiers: .command)
                Divider()
                Button("Fader: Main") { store.faderMode = .main }
                    .keyboardShortcut("0", modifiers: [.command, .option])
            }
        }

        Window("Protokoll-Log", id: "log") {
            LogView()
                .environment(store)
                .environment(settings)
        }
        .defaultSize(width: 900, height: 520)

        Settings {
            SettingsView()
                .environment(store)
                .environment(settings)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Needed when started via `swift run` (no app bundle).
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
