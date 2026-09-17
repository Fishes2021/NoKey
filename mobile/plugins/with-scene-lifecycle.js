const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

// Expo 54 has no scene delegate. Remove this adapter when upgrading to Expo's
// native scene support; iOS 27 requires a scene-owned window at launch.
const sceneDelegate = `
class VoiceDeckSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  private var app: AppDelegate { UIApplication.shared.delegate as! AppDelegate }

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
             options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene else { return }
    if let existing = app.window {
      window = existing
      existing.windowScene = windowScene
      existing.makeKeyAndVisible()
      self.scene(scene, openURLContexts: connectionOptions.urlContexts)
      for activity in connectionOptions.userActivities { self.scene(scene, continue: activity) }
      return
    }
    var options = app.sceneLaunchOptions ?? [:]
    if let context = connectionOptions.urlContexts.first {
      options[.url] = context.url
      options[.sourceApplication] = context.options.sourceApplication
      options[.annotation] = context.options.annotation
    }
    if let activity = connectionOptions.userActivities.first {
      options[.userActivityDictionary] = [
        "UIApplicationLaunchOptionsUserActivityKey": activity,
        "UIApplicationLaunchOptionsUserActivityTypeKey": activity.activityType
      ]
    }
    let newWindow = UIWindow(windowScene: windowScene)
    window = newWindow
    app.window = newWindow
    app.reactNativeFactory?.startReactNative(withModuleName: "main", in: newWindow, launchOptions: options)
    app.sceneLaunchOptions = nil
  }

  func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    for context in contexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: context.options.openInPlace]
      options[.sourceApplication] = context.options.sourceApplication
      options[.annotation] = context.options.annotation
      _ = app.application(UIApplication.shared, open: context.url, options: options)
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = app.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }

  // UIKit still posts application notifications consumed by React Native.
  // Forward delegate callbacks only, so Expo subscribers also receive them.
  func sceneDidBecomeActive(_ scene: UIScene) { app.applicationDidBecomeActive(UIApplication.shared) }
  func sceneWillResignActive(_ scene: UIScene) { app.applicationWillResignActive(UIApplication.shared) }
  func sceneDidEnterBackground(_ scene: UIScene) { app.applicationDidEnterBackground(UIApplication.shared) }
  func sceneWillEnterForeground(_ scene: UIScene) { app.applicationWillEnterForeground(UIApplication.shared) }
}
`;

module.exports = function withSceneLifecycle(config) {
  config = withInfoPlist(config, mod => {
    mod.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [{
          UISceneConfigurationName: 'Default Configuration',
          UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).VoiceDeckSceneDelegate',
        }],
      },
    };
    return mod;
  });
  return withAppDelegate(config, mod => {
    if (mod.modResults.language !== 'swift') throw new Error('Scene adapter requires the Expo 54 Swift template');
    let source = mod.modResults.contents;
    if (source.includes('class VoiceDeckSceneDelegate:')) return mod;
    const startup = /#if os\(iOS\) \|\| os\(tvOS\)\s+window = UIWindow\(frame: UIScreen.main.bounds\)\s+factory.startReactNative\([\s\S]*?launchOptions: launchOptions\)\s+#endif/;
    if (!startup.test(source) || !source.includes('var window: UIWindow?')) {
      throw new Error('Expo AppDelegate changed; review scene migration before building');
    }
    source = source.replace('var window: UIWindow?', 'var window: UIWindow?\n  var sceneLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?');
    mod.modResults.contents = source.replace(startup, 'sceneLaunchOptions = launchOptions') + sceneDelegate;
    return mod;
  });
};
