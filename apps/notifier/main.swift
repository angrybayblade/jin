// jin's notifier: shows a macOS notification as jin, and when you click it, opens the jin://
// link it carries, which brings jin's window up on the place it is about (a chat, a task, a
// desk). jin's daemon runs it for each notice:
//
//   jin-notifier --title T [--subtitle S] [--body B] [--open jin://open?path=/t/X] [--group G] [--sound]
//
// macOS launches it again (without arguments) when a notification is clicked later; it opens
// the link and quits.
import AppKit
import UserNotifications

final class Notifier: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  let args: [String: String]
  init(args: [String: String]) { self.args = args }

  // The delegate must be set before launching finishes: a click on a notification posted
  // earlier relaunches this app and delivers the click right after launch.
  func applicationWillFinishLaunching(_ note: Notification) {
    UNUserNotificationCenter.current().delegate = self
  }

  func applicationDidFinishLaunching(_ note: Notification) {
    let center = UNUserNotificationCenter.current()
    guard let title = args["title"] else {
      // Launched for a click: the response arrives through the delegate; quit if it does not.
      quit(after: 10)
      return
    }
    center.requestAuthorization(options: [.alert, .sound]) { granted, error in
      guard granted else {
        FileHandle.standardError.write("jin-notifier: notifications not allowed\(error.map { ": \($0.localizedDescription)" } ?? "")\n".data(using: .utf8)!)
        self.quit(after: 0, code: 2)
        return
      }
      let content = UNMutableNotificationContent()
      content.title = title
      if let s = self.args["subtitle"], !s.isEmpty { content.subtitle = s }
      content.body = self.args["body"] ?? ""
      if let open = self.args["open"] { content.userInfo = ["open": open] }
      if let g = self.args["group"] { content.threadIdentifier = g }
      if self.args["sound"] != nil { content.sound = .default }
      let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
      center.add(request) { error in
        if let error { FileHandle.standardError.write("jin-notifier: \(error.localizedDescription)\n".data(using: .utf8)!) }
        // Stay a moment: a click right away arrives here; a later one relaunches the app.
        self.quit(after: 3, code: error == nil ? 0 : 1)
      }
    }
  }

  // Shown even when this helper is the active app (it never is, but macOS asks).
  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    done([.banner, .list, .sound])
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
    if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
       let open = response.notification.request.content.userInfo["open"] as? String,
       let url = URL(string: open) {
      NSWorkspace.shared.open(url)
    }
    done()
    quit(after: 0.5)
  }

  func quit(after seconds: Double, code: Int32 = 0) {
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { exit(code) }
  }
}

var parsed: [String: String] = [:]
var argv = CommandLine.arguments.dropFirst().makeIterator()
while let a = argv.next() {
  guard a.hasPrefix("--") else { continue }
  let key = String(a.dropFirst(2))
  if key == "sound" { parsed[key] = "1" } else { parsed[key] = argv.next() ?? "" }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let delegate = Notifier(args: parsed)
app.delegate = delegate
app.run()
