import AppKit

final class Installer: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    private let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 510, height: 392),
        styleMask: [.titled, .closable], backing: .buffered, defer: false
    )
    private let clients = NSPopUpButton(frame: .zero, pullsDown: false)
    private let extensionID = NSTextField(string: Bundle.main.object(forInfoDictionaryKey: "HistorySweepExtensionID") as? String ?? "")
    private let idHint = NSTextField(wrappingLabelWithString: "Using an unpacked extension? Copy its ID from Agent access in Chrome.")

    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "History Sweep Agent Installer"
        window.isReleasedWhenClosed = false
        clients.addItems(withTitles: ["Codex", "Claude Code"])
        clients.controlSize = .large
        clients.setAccessibilityLabel("Agent client")
        extensionID.controlSize = .large
        extensionID.bezelStyle = .roundedBezel
        extensionID.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        extensionID.setAccessibilityLabel("Chrome extension ID")
        extensionID.delegate = self
        idHint.font = .systemFont(ofSize: 12)
        idHint.textColor = .secondaryLabelColor
        showSetup()
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func controlTextDidChange(_ notification: Notification) {
        idHint.stringValue = "Using an unpacked extension? Copy its ID from Agent access in Chrome."
        idHint.textColor = .secondaryLabelColor
    }

    @objc private func showSetup() {
        let client = field("Agent client", control: clients)
        let extensionField = field("Chrome extension ID", control: extensionID, hint: idHint)
        let fields = vertical([client, extensionField], spacing: 16)
        for row in [client, extensionField] { row.widthAnchor.constraint(equalTo: fields.widthAnchor).isActive = true }

        let cancel = button("Cancel", action: #selector(close), key: "\u{1b}")
        let install = button("Install", action: #selector(startInstall), key: "\r")
        present(
            title: "Install History Sweep Agent",
            subtitle: "Set up the local connection, MCP server, and Skill together.",
            body: [fields, label("Install the selected client before continuing.", size: 12, color: .secondaryLabelColor)],
            actions: [cancel, install]
        )
        clients.nextKeyView = extensionID
        extensionID.nextKeyView = cancel
        cancel.nextKeyView = install
        install.nextKeyView = clients
        window.makeFirstResponder(clients)
    }

    @objc private func close() { NSApp.terminate(nil) }

    @objc private func startInstall() {
        let client = clients.indexOfSelectedItem == 0 ? "codex" : "claude-code"
        let id = extensionID.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard id.utf8.count == 32, id.utf8.allSatisfy({ (97...112).contains($0) }) else {
            idHint.stringValue = "Enter the 32-character extension ID shown in Agent access."
            idHint.textColor = .systemRed
            window.makeFirstResponder(extensionID)
            return
        }
        guard let script = Bundle.main.url(forResource: "install", withExtension: "sh"),
              let installer = Bundle.main.url(forResource: "install", withExtension: "mjs", subdirectory: "agent") else {
            finish(error: "The installer bundle is incomplete.")
            return
        }

        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.sizeToFit()
        let progress = NSStackView(views: [spinner, label("Setting up MCP and Skill…", size: 13)])
        progress.alignment = .centerY
        progress.spacing = 10
        present(
            title: "Installing History Sweep Agent",
            subtitle: "Configuring \(clients.titleOfSelectedItem ?? client).",
            body: [progress], actions: []
        )
        window.standardWindowButton(.closeButton)?.isEnabled = false
        spinner.startAnimation(nil)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [script.path, installer.path, id, client]
        // Finder launches without the user's interactive shell path.
        var environment = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let dataHome = environment["XDG_DATA_HOME"] ?? "\(home)/.local/share"
        let miseData = environment["MISE_DATA_DIR"] ?? "\(dataHome)/mise"
        let pnpmHome = environment["PNPM_HOME"] ?? "\(home)/Library/pnpm"
        let managerPaths = [environment["MISE_SHIMS_DIR"] ?? "\(miseData)/shims", pnpmHome, "\(pnpmHome)/bin"]
            .filter { $0.hasPrefix("/") && !$0.contains(":") }
        let basePaths = [
            "/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "\(home)/.npm-global/bin",
            environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        ]
        environment["PATH"] = (basePaths + managerPaths).joined(separator: ":")
        process.environment = environment
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        do { try process.run() }
        catch { finish(error: error.localizedDescription); return }
        DispatchQueue.global().async {
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let detail = String(decoding: data.suffix(2500), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            DispatchQueue.main.async { self.finish(error: process.terminationStatus == 0 ? nil : detail.isEmpty ? "Installer exited with status \(process.terminationStatus)." : detail) }
        }
    }

    private func finish(error: String?) {
        window.standardWindowButton(.closeButton)?.isEnabled = true
        if error == "AGENT_CLIENT_NOT_FOUND" {
            showMissingClient()
        } else if let error {
            let details = NSTextView.scrollableTextView()
            if let text = details.documentView as? NSTextView {
                text.isEditable = false
                text.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
                text.textContainerInset = NSSize(width: 8, height: 8)
                text.string = error
            }
            details.borderType = .bezelBorder
            details.heightAnchor.constraint(equalToConstant: 112).isActive = true
            present(title: "Installation could not finish", subtitle: "Review the details, then return to setup to try again.",
                    body: [details], actions: [button("Close", action: #selector(close)), button("Back to Setup", action: #selector(showSetup), key: "\r")])
        } else {
            present(title: "History Sweep Agent installed", subtitle: "The MCP server and Skill are ready.", body: [
                label("1. Open Agent access in the Chrome extension and connect the local companion.", size: 14),
                label("2. Restart your agent client to load the MCP server and Skill.", size: 14),
            ], actions: [button("Done", action: #selector(close), key: "\r")])
        }
    }

    private func showMissingClient() {
        let isCodex = clients.indexOfSelectedItem == 0
        let name = isCodex ? "Codex" : "Claude Code"
        let executable = isCodex ? "codex" : "claude"
        let command = label("\(executable) --version", size: 14)
        command.font = .monospacedSystemFont(ofSize: 14, weight: .medium)
        command.isSelectable = true

        present(title: "\(name) CLI not found", subtitle: "History Sweep needs the command-line tool to set up MCP and Skill.", body: [
            label("Check that the \(name) CLI is available in Terminal.", size: 14),
            command,
            label("If the command is missing, open the CLI guide. Then return to setup to retry or select another client.", size: 13, color: .secondaryLabelColor),
        ], actions: [
            button("Close", action: #selector(close)),
            button("Open CLI Guide", action: #selector(openClientGuide)),
            button("Back to Setup", action: #selector(showSetup), key: "\r"),
        ], height: 310)
    }

    @objc private func openClientGuide() {
        let address = clients.indexOfSelectedItem == 0
            ? "https://learn.chatgpt.com/docs/codex/cli"
            : "https://code.claude.com/docs/en/setup#install-claude-code"
        if let url = URL(string: address) { NSWorkspace.shared.open(url) }
    }

    private func present(title: String, subtitle: String, body: [NSView], actions: [NSButton], height: CGFloat = 392) {
        window.setContentSize(NSSize(width: window.contentLayoutRect.width, height: height))
        let icon = NSImageView(image: NSApp.applicationIconImage)
        icon.imageScaling = .scaleProportionallyUpOrDown
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 64),
            icon.heightAnchor.constraint(equalTo: icon.widthAnchor),
        ])
        let text = vertical([label(title, size: 24, weight: .semibold), label(subtitle, size: 13, color: .secondaryLabelColor)], spacing: 5)
        let header = NSStackView(views: [icon, text])
        header.alignment = .centerY
        header.spacing = 12

        let content = vertical([header] + body, spacing: 12)
        content.setCustomSpacing(24, after: header)
        let surface = NSView()
        surface.addSubview(content)
        content.translatesAutoresizingMaskIntoConstraints = false
        var constraints = [
            content.topAnchor.constraint(equalTo: surface.topAnchor, constant: 28),
            content.leadingAnchor.constraint(equalTo: surface.leadingAnchor, constant: 28),
            content.trailingAnchor.constraint(equalTo: surface.trailingAnchor, constant: -28),
        ]
        for item in [header] + body { constraints.append(item.widthAnchor.constraint(equalTo: content.widthAnchor)) }
        if !actions.isEmpty {
            let separator = NSBox()
            separator.boxType = .separator
            let footer = NSStackView(views: actions)
            footer.spacing = 8
            for view in [separator, footer] {
                surface.addSubview(view)
                view.translatesAutoresizingMaskIntoConstraints = false
            }
            constraints += [
                separator.leadingAnchor.constraint(equalTo: content.leadingAnchor),
                separator.trailingAnchor.constraint(equalTo: content.trailingAnchor),
                separator.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -16),
                footer.trailingAnchor.constraint(equalTo: content.trailingAnchor),
                footer.bottomAnchor.constraint(equalTo: surface.bottomAnchor, constant: -22),
                content.bottomAnchor.constraint(lessThanOrEqualTo: separator.topAnchor, constant: -16),
            ]
        }
        window.contentView = surface
        NSLayoutConstraint.activate(constraints)
        window.defaultButtonCell = actions.last?.cell as? NSButtonCell
    }

    private func field(_ title: String, control: NSControl, hint: NSTextField? = nil) -> NSStackView {
        var views: [NSView] = [label(title, size: 13, weight: .semibold), control]
        if let hint { views.append(hint) }
        let stack = vertical(views, spacing: 6)
        control.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        hint?.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        return stack
    }

    private func vertical(_ views: [NSView], spacing: CGFloat) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = spacing
        return stack
    }

    private func label(_ value: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = .labelColor) -> NSTextField {
        let text = NSTextField(wrappingLabelWithString: value)
        text.font = .systemFont(ofSize: size, weight: weight)
        text.textColor = color
        return text
    }

    private func button(_ title: String, action: Selector, key: String = "") -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        button.controlSize = .large
        button.keyEquivalent = key
        return button
    }
}

let application = NSApplication.shared
let installer = Installer()
application.setActivationPolicy(.regular)
application.delegate = installer
application.run()
