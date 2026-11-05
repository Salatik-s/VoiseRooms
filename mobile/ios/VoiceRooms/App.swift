import UIKit
import WebKit
import AVFoundation
import Security

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default Configuration", sessionRole: session.role)
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var controller: VoiceViewController?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let view = VoiceViewController()
        controller = view
        let window = UIWindow(windowScene: scene)
        window.rootViewController = view
        window.makeKeyAndVisible()
        self.window = window
        if let url = options.urlContexts.first?.url { view.openInvitation(url) }
    }
    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        if let url = contexts.first?.url { controller?.openInvitation(url) }
    }
}

private final class SessionVault {
    private let query: [String: Any] = [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"ru.voicerooms.session",kSecAttrAccount as String:"signed-session"]
    static func valid(_ value: String) -> Bool {
        if value.isEmpty { return true }
        guard value.utf8.count < 4096, value.range(of: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let part=value.split(separator:".").first else { return false }
        var base=String(part).replacingOccurrences(of:"-",with:"+").replacingOccurrences(of:"_",with:"/")
        base += String(repeating:"=",count:(4-base.count%4)%4)
        guard let data=Data(base64Encoded:base), let body=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any], let expiry=body["exp"] as? Double else { return false }
        return expiry > Date().timeIntervalSince1970 * 1000
    }
    func read() -> String {
        var request=query; request[kSecReturnData as String]=true;request[kSecMatchLimit as String]=kSecMatchLimitOne
        var result:CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary,&result)==errSecSuccess,let data=result as? Data,let value=String(data:data,encoding:.utf8),Self.valid(value) else { return "" }
        return value
    }
    func save(_ token:String) {
        guard Self.valid(token) else { return }
        SecItemDelete(query as CFDictionary)
        if token.isEmpty { return }
        var request=query;request[kSecValueData as String]=Data(token.utf8);request[kSecAttrAccessible as String]=kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(request as CFDictionary,nil)
    }
}
private final class ScriptRelay:NSObject,WKScriptMessageHandler {
    weak var target:VoiceViewController?
    func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage){target?.receive(message)}
}
final class VoiceViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, UIDocumentPickerDelegate {
    private let origin = URL(string: "https://voise.24projects.ru/")!
    private var web: WKWebView!
    private let errorView = UIStackView()
    private let progress = UIActivityIndicatorView(style: .large)
    private var lastURL: URL?
    private var pendingInvitation: URL?
    private let vault=SessionVault()
    private var exportedURL:URL?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.09, green: 0.10, blue: 0.11, alpha: 1)
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.websiteDataStore = .default()
        let relay=ScriptRelay();relay.target=self
        configuration.userContentController.add(relay,name:"VoiceRoomsNativeHost")
        installBridge(configuration.userContentController)
        web = WKWebView(frame: .zero, configuration: configuration)
        web.isOpaque = false
        web.backgroundColor = view.backgroundColor
        web.scrollView.backgroundColor = view.backgroundColor
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        prepareFailureView()
        progress.color = .systemBlue
        progress.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(progress)
        NSLayoutConstraint.activate([progress.centerXAnchor.constraint(equalTo: view.centerXAnchor), progress.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
        load(pendingInvitation ?? initialURL())
    }
    private func installBridge(_ controller:WKUserContentController) {
        let encoded=(try? JSONSerialization.data(withJSONObject:[vault.read()])).flatMap { String(data:$0,encoding:.utf8) } ?? "[\"\"]"
        let bridge="""
        (()=>{if(location.origin==='https://voise.24projects.ru'){const saved=\(encoded)[0];if(saved&&!sessionStorage.getItem('vr-session'))sessionStorage.setItem('vr-session',saved);window.VoiceRoomsNative=Object.freeze({saveSession:token=>webkit.messageHandlers.VoiceRoomsNativeHost.postMessage({kind:'session',token}),callState:(active,microphone)=>webkit.messageHandlers.VoiceRoomsNativeHost.postMessage({kind:'call',active:!!active,microphone:!!microphone}),saveFile:(name,base64,mime)=>webkit.messageHandlers.VoiceRoomsNativeHost.postMessage({kind:'file',name,base64,mime})});}})();
        """
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(source:bridge,injectionTime:.atDocumentStart,forMainFrameOnly:true))
    }
    fileprivate func receive(_ message:WKScriptMessage) {
        guard message.frameInfo.isMainFrame,message.frameInfo.securityOrigin.protocol=="https",message.frameInfo.securityOrigin.host==origin.host,
              message.frameInfo.securityOrigin.port==443 || message.frameInfo.securityOrigin.port==0,
              let current=web.url,trusted(current),let body=message.body as? [String:Any],let kind=body["kind"] as? String else { return }
        if kind=="session",let token=body["token"] as? String,SessionVault.valid(token) {
            vault.save(token)
            installBridge(web.configuration.userContentController)
        }
        if kind=="call",let active=body["active"] as? Bool,let microphone=body["microphone"] as? Bool {
            let audio=AVAudioSession.sharedInstance()
            if active {
                if microphone {try? audio.setCategory(.playAndRecord,mode:.voiceChat,options:[.defaultToSpeaker,.allowBluetooth])}
                else {try? audio.setCategory(.playback,mode:.spokenAudio)}
                try? audio.setActive(true)
            } else {try? audio.setActive(false,options:.notifyOthersOnDeactivation)}
        }
        if kind=="file",let name=body["name"] as? String,let encoded=body["base64"] as? String,encoded.utf8.count<=15_000_000,let data=Data(base64Encoded:encoded),data.count<=10*1024*1024 {
            let raw=String(name.replacingOccurrences(of:"\\",with:"/").split(separator:"/").last ?? "Файл")
            let filtered=String(raw.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })
            let safe=(filtered.isEmpty || filtered=="." || filtered=="..") ? "Файл" : String(filtered.prefix(150))
            let directory=FileManager.default.temporaryDirectory.appendingPathComponent("VoiceRooms-"+UUID().uuidString,isDirectory:true)
            do {
                try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
                let url=directory.appendingPathComponent(safe)
                try data.write(to:url,options:.atomic);exportedURL=url
                let picker=UIDocumentPickerViewController(forExporting:[url],asCopy:true);picker.delegate=self;present(picker,animated:true)
            } catch {showFileError()}
        }
    }
    private func showFileError(){let alert=UIAlertController(title:"Не удалось сохранить файл",message:"Попробуйте ещё раз или откройте комнату в браузере.",preferredStyle:.alert);alert.addAction(UIAlertAction(title:"Понятно",style:.default));present(alert,animated:true)}
    private func clearExport(){if let url=exportedURL {try? FileManager.default.removeItem(at:url.deletingLastPathComponent())};exportedURL=nil}
    func documentPickerWasCancelled(_ controller:UIDocumentPickerViewController){clearExport()}
    func documentPicker(_ controller:UIDocumentPickerViewController,didPickDocumentsAt urls:[URL]){clearExport()}
    private func initialURL() -> URL {
        #if DEBUG && targetEnvironment(simulator)
        let args = ProcessInfo.processInfo.arguments
        if let position = args.firstIndex(of: "-previewURL"), position + 1 < args.count,
           let url = URL(string: args[position + 1]), trusted(url) { return url }
        #endif
        return origin
    }
    private func trusted(_ url: URL) -> Bool {
        if url.scheme == "https" && url.host == origin.host && (url.port == nil || url.port == 443) { return true }
        #if DEBUG && targetEnvironment(simulator)
        return url.scheme == "http" && (url.host == "127.0.0.1" || url.host == "localhost")
        #else
        return false
        #endif
    }
    func openInvitation(_ url: URL) {
        guard url.scheme == "voicerooms", var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        components.scheme = "https"
        components.host = origin.host
        components.port = nil
        components.path = "/"
        components.user = nil
        components.password = nil
        guard let destination = components.url else { return }
        if isViewLoaded { load(destination) } else { pendingInvitation = destination }
    }
    private func load(_ url: URL) {
        guard trusted(url) else { return }
        lastURL = url
        errorView.isHidden = true
        web.isHidden = false
        progress.startAnimating()
        web.load(URLRequest(url: url))
    }
    private func prepareFailureView() {
        errorView.axis = .vertical
        errorView.alignment = .center
        errorView.spacing = 20
        errorView.translatesAutoresizingMaskIntoConstraints = false
        let icon = UIImageView(image: UIImage(systemName: "wifi.slash"))
        icon.tintColor = .secondaryLabel
        icon.contentMode = .scaleAspectFit
        icon.heightAnchor.constraint(equalToConstant: 44).isActive = true
        icon.widthAnchor.constraint(equalToConstant: 44).isActive = true
        let title = UILabel()
        title.text = "Не удалось открыть VoiceRooms"
        title.font = .preferredFont(forTextStyle: .title2)
        title.adjustsFontForContentSizeCategory = true
        title.textAlignment = .center
        title.numberOfLines = 0
        let message = UILabel()
        message.text = "Проверьте подключение к интернету и попробуйте ещё раз."
        message.font = .preferredFont(forTextStyle: .body)
        message.adjustsFontForContentSizeCategory = true
        message.textColor = .secondaryLabel
        message.textAlignment = .center
        message.numberOfLines = 0
        let retry = UIButton(type: .system)
        retry.setTitle("Попробовать снова", for: .normal)
        retry.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        retry.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
        retry.addTarget(self, action: #selector(retryLoading), for: .touchUpInside)
        [icon, title, message, retry].forEach { errorView.addArrangedSubview($0) }
        view.addSubview(errorView)
        NSLayoutConstraint.activate([errorView.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor), errorView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 28), errorView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -28)])
        errorView.isHidden = true
    }
    @objc private func retryLoading() { load(lastURL ?? origin) }
    private func fail() {
        progress.stopAnimating()
        web.isHidden = true
        errorView.isHidden = false
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        progress.stopAnimating()
        errorView.isHidden = true
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { fail() }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { fail() }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail() }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if trusted(url) && !url.path.hasPrefix("/downloads/") {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if (url.scheme == "https" || url.scheme == "http") && action.navigationType == .linkActivated { UIApplication.shared.open(url) }
        }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme == "https" { UIApplication.shared.open(url) }
        return nil
    }
    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard origin.protocol == "https", origin.host == self.origin.host, type == .microphone else { decisionHandler(.deny); return }
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            DispatchQueue.main.async {
                if granted {
                    try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
                    try? AVAudioSession.sharedInstance().setActive(true)
                }
                decisionHandler(granted ? .grant : .deny)
            }
        }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: "Подтвердите действие", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "Подтвердить", style: .destructive) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: "VoiceRooms", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Понятно", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }
}
