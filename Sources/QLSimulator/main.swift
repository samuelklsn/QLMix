import Foundation
import YamahaQLProtocol

// Usage: QLSimulator [--port 49280] [--model QL5|QL1|CL5|CL3|CL1] [--animate] [--verbose]

var options = SimulatedConsole.Options()
var args = CommandLine.arguments.dropFirst()
while let arg = args.popFirst() {
    switch arg {
    case "--port":
        if let v = args.popFirst(), let p = UInt16(v) { options.port = p }
    case "--model":
        if let v = args.popFirst() { options.model = ConsoleModel.from(productName: v) }
    case "--animate":
        options.animate = true
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
do {
    try console.start()
} catch {
    print("Start fehlgeschlagen: \(error)")
    exit(1)
}
dispatchMain()
