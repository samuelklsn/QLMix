import Foundation
import YamahaQLProtocol

// Usage: QLSimulator [--port 49280] [--model QL5|QL1|CL5|CL3|CL1] [--animate] [--verbose]

var options = SimulatedConsole.Options()
var sysexPort: UInt16 = 50000
var talkerChannel = 0
var roomChannel: Int?
var args = CommandLine.arguments.dropFirst()
while let arg = args.popFirst() {
    switch arg {
    case "--port":
        if let v = args.popFirst(), let p = UInt16(v) { options.port = p }
    case "--model":
        if let v = args.popFirst() { options.model = ConsoleModel.from(productName: v) }
    case "--animate":
        options.animate = true
    case "--firmware":
        if let v = args.popFirst() { options.firmware = v }
    case "--talker":
        if let v = args.popFirst(), let n = Int(v) { talkerChannel = max(0, n - 1) }
    case "--room":
        if let v = args.popFirst(), let n = Int(v) { roomChannel = max(0, n - 1) }
    case "--sysex-port":
        if let v = args.popFirst(), let p = UInt16(v) { sysexPort = p }
    case "--no-eq":
        options.noEQ = true
    case "--verbose", "-v":
        options.verbose = true
    case "--help", "-h":
        print("""
        QLSimulator – simuliert ein Yamaha CL/QL Pult (RCP, TCP)
          --port <n>        TCP-Port (Standard 49280)
          --model <name>    QL5, QL1, CL5, CL3, CL1 (Standard QL5)
          --animate         bewegt zufällig Fader (simuliert zweiten Bediener)
          --firmware <text> Antwort auf "devinfo version"
          --talker <n>      Kanal, der in den simulierten Eingangspegeln "spricht" (Standard 1)
          --room <n>        Kanal eines simulierten Raum-Mikros (hört den Sprecher über die Anlage)
          --sysex-port <n>  Editor-Protokoll (SysEx) für EQ/Dynamics/Rack (Standard 50000, 0 = aus)
          --no-eq           EQ-Adressen nicht beantworten (wie ein Pult ohne EQ über RCP)
          --verbose         protokolliert jede Zeile
        """)
        exit(0)
    default:
        print("Unbekanntes Argument: \(arg)")
        exit(2)
    }
}

let console = SimulatedConsole(options: options)
let sysex = SysExConsole(port: sysexPort, inputs: options.model.count(.input), verbose: options.verbose)
sysex.talker = talkerChannel
sysex.room = roomChannel
sysex.talkerFaderDB = { console.inputFaderDB($0) }
do {
    try console.start()
    if sysexPort > 0 { try sysex.start() }
} catch {
    print("Start fehlgeschlagen: \(error)")
    exit(1)
}
dispatchMain()
