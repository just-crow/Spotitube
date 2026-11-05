import UIKit

@MainActor
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    var browser: WebController?
    var backgroundDownloadCompletion: (() -> Void)?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let controller = WebController()
        browser = controller
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        return true
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        backgroundDownloadCompletion = completionHandler
        _ = browser?.offline
    }

    func applicationWillTerminate(_ application: UIApplication) {
        browser?.nowPlaying.stop()
    }
}
