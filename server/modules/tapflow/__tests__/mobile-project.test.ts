import { describe, expect, it } from 'vitest'
import { buildPlan, choosePlatforms, detectMobileApps, pickArtifact, type ProjectFiles } from '../mobile-project'

/** An in-memory repository: file path → content ('' for an empty file); directories are implied. */
function repo(tree: Record<string, string>): ProjectFiles {
  const paths = Object.keys(tree)
  return {
    exists: (path) => paths.some((file) => file === path || file.startsWith(path + '/')),
    list: (dir) => [...new Set(paths.filter((file) => dir === '' || file.startsWith(dir + '/')).map((file) => (dir === '' ? file : file.slice(dir.length + 1)).split('/')[0]!))],
    read: (path) => tree[path] ?? null,
  }
}

const IOS_PBX = 'productType = "com.apple.product-type.application";\nSDKROOT = iphoneos;\n'
const MAC_PBX = 'productType = "com.apple.product-type.application";\nSDKROOT = macosx;\n'
const ANDROID_APP = 'plugins {\n  id("com.android.application")\n}\n'

describe('detectMobileApps', () => {
  it('finds a native iOS app and prefers its CocoaPods workspace', () => {
    expect(detectMobileApps(repo({ 'Shop.xcodeproj/project.pbxproj': IOS_PBX, 'Shop.xcworkspace/contents.xcworkspacedata': '', 'Shop/App.swift': '' })))
      .toEqual([{ platform: 'ios', stack: 'xcode', root: '', xcodeContainer: 'Shop.xcworkspace' }])
  })

  it('ignores a macOS-only Xcode project and a framework', () => {
    expect(detectMobileApps(repo({ 'Mac.xcodeproj/project.pbxproj': MAC_PBX }))).toEqual([])
    expect(detectMobileApps(repo({ 'Kit.xcodeproj/project.pbxproj': 'productType = "com.apple.product-type.framework";\nSDKROOT = iphoneos;\n' }))).toEqual([])
  })

  it('finds a native Android app module, Kotlin or Groovy DSL, including version-catalog plugins', () => {
    expect(detectMobileApps(repo({ 'settings.gradle.kts': '', 'app/build.gradle.kts': ANDROID_APP })))
      .toEqual([{ platform: 'android', stack: 'gradle', root: '', gradleModule: 'app' }])
    expect(detectMobileApps(repo({ 'settings.gradle': '', 'mobile/build.gradle': "apply plugin: 'com.android.application'" }))[0]).toMatchObject({ gradleModule: 'mobile' })
    expect(detectMobileApps(repo({ 'settings.gradle.kts': '', 'app/build.gradle.kts': 'plugins { alias(libs.plugins.android.application) }' }))).toHaveLength(1)
    expect(detectMobileApps(repo({ 'settings.gradle.kts': '', 'lib/build.gradle.kts': 'plugins { id("com.android.library") }' }))).toEqual([])
  })

  it('finds both apps of a Kotlin Multiplatform project one level down', () => {
    const apps = detectMobileApps(repo({ 'iosApp/iosApp.xcodeproj/project.pbxproj': IOS_PBX, 'settings.gradle.kts': '', 'androidApp/build.gradle.kts': ANDROID_APP, 'shared/src/commonMain/a.kt': '' }))
    expect(apps.map((app) => [app.platform, app.root])).toEqual([['android', ''], ['ios', 'iosApp']])
  })

  it('[spec:mobile-device-testing/app-detection] recognises the camelCase plugin alias of the Kotlin Multiplatform wizard (JetBrains\' KMP-App-Template)', () => {
    const apps = detectMobileApps(repo({
      'iosApp/iosApp.xcodeproj/project.pbxproj': IOS_PBX, 'settings.gradle.kts': 'include(":shared")\ninclude(":androidApp")',
      'androidApp/build.gradle.kts': 'plugins {\n    alias(libs.plugins.androidApplication)\n    alias(libs.plugins.composeCompiler)\n}',
      'shared/build.gradle.kts': 'plugins { alias(libs.plugins.androidKotlinMultiplatformLibrary) }',
    }))
    expect(apps.map((app) => [app.platform, app.root, app.gradleModule])).toEqual([['android', '', 'androidApp'], ['ios', 'iosApp', undefined]])
    // The library alias is not an app.
    expect(detectMobileApps(repo({ 'settings.gradle.kts': '', 'lib/build.gradle.kts': 'plugins { alias(libs.plugins.androidLibrary) }' }))).toEqual([])
  })

  it('recognises Flutter once for each platform, not its native folders again', () => {
    const apps = detectMobileApps(repo({ 'pubspec.yaml': 'dependencies:\n  flutter:\n    sdk: flutter\n', 'ios/Runner.xcodeproj/project.pbxproj': IOS_PBX, 'android/settings.gradle': '', 'android/app/build.gradle': ANDROID_APP }))
    expect(apps).toEqual([{ platform: 'ios', stack: 'flutter', root: '' }, { platform: 'android', stack: 'flutter', root: '' }])
  })

  it('recognises React Native with its native folders, and managed Expo without them', () => {
    const rn = detectMobileApps(repo({ 'package.json': JSON.stringify({ dependencies: { 'react-native': '0.80.0' } }), 'ios/App.xcodeproj/project.pbxproj': IOS_PBX, 'ios/App.xcworkspace/x': '', 'android/settings.gradle': '', 'android/app/build.gradle': ANDROID_APP }))
    expect(rn).toEqual([
      { platform: 'ios', stack: 'react-native', root: 'ios', xcodeContainer: 'App.xcworkspace' },
      { platform: 'android', stack: 'react-native', root: 'android', gradleModule: 'app' },
    ])
    const expo = detectMobileApps(repo({ 'package.json': JSON.stringify({ dependencies: { expo: '^55.0.0', 'react-native': '0.80.0' } }), 'app/index.tsx': '' }))
    expect(expo.map((app) => [app.platform, app.stack])).toEqual([['ios', 'expo'], ['android', 'expo']])
  })

  it('reports nothing for a web project', () => {
    expect(detectMobileApps(repo({ 'package.json': JSON.stringify({ dependencies: { react: '19' } }), 'src/index.tsx': '' }))).toEqual([])
  })
})

describe('choosePlatforms', () => {
  const both = [{ platform: 'ios' as const, stack: 'flutter' as const, root: '' }, { platform: 'android' as const, stack: 'flutter' as const, root: '' }]

  it('uses the only platform there is, without asking', () => {
    expect(choosePlatforms([both[0]!], ['lib/main.dart'])).toEqual({ kind: 'single', platform: 'ios' })
    expect(choosePlatforms([], ['x'])).toEqual({ kind: 'none' })
  })

  it('asks for a multiplatform project, recommending the platform the change touched', () => {
    expect(choosePlatforms(both, ['ios/Runner/AppDelegate.swift'])).toEqual({ kind: 'ask', recommended: 'ios' })
    expect(choosePlatforms(both, ['android/app/src/main/kotlin/Main.kt'])).toEqual({ kind: 'ask', recommended: 'android' })
    expect(choosePlatforms(both, ['lib/main.dart'])).toEqual({ kind: 'ask', recommended: 'both' })
    expect(choosePlatforms(both, ['ios/a.swift', 'android/b.kt'])).toEqual({ kind: 'ask', recommended: 'both' })
  })

  it('recommends the person\'s last choice for the project', () => {
    expect(choosePlatforms(both, ['ios/a.swift'], 'android')).toEqual({ kind: 'ask', recommended: 'android' })
  })
})

describe('buildPlan', () => {
  it('builds a native iOS app for the simulator, unsigned, into Specrails\' build folder', () => {
    const plan = buildPlan({ platform: 'ios', stack: 'xcode', root: '', xcodeContainer: 'Shop.xcworkspace' }, { scheme: 'Shop' })
    expect(plan.steps).toEqual([['xcodebuild', '-workspace', 'Shop.xcworkspace', '-scheme', 'Shop', '-configuration', 'Debug', '-sdk', 'iphonesimulator',
      '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', '.specrails/mobile-build/ios', 'CODE_SIGNING_ALLOWED=NO', 'build']])
    expect(plan).toMatchObject({ cwd: '', artifactDir: '.specrails/mobile-build/ios/Build/Products/Debug-iphonesimulator', artifactExtension: '.app' })
  })

  it('keeps derived data at the repository root when the build runs in a subfolder', () => {
    const plan = buildPlan({ platform: 'ios', stack: 'react-native', root: 'ios', xcodeContainer: 'App.xcworkspace' }, { scheme: 'App' })
    expect(plan.steps[0]).toEqual(['pod', 'install'])
    expect(plan.steps[1]).toContain('../.specrails/mobile-build/ios')
    expect(plan.cwd).toBe('ios')
  })

  it('builds Android debug APKs with the module\'s Gradle wrapper, and Flutter with its own CLI', () => {
    expect(buildPlan({ platform: 'android', stack: 'gradle', root: '', gradleModule: 'app' })).toMatchObject({ steps: [['./gradlew', ':app:assembleDebug']], artifactDir: 'app/build/outputs/apk/debug', artifactExtension: '.apk' })
    expect(buildPlan({ platform: 'android', stack: 'flutter', root: '' }).steps[0]).toEqual(['flutter', 'build', 'apk', '--debug', '--target-platform', 'android-arm64'])
    expect(buildPlan({ platform: 'ios', stack: 'flutter', root: '' }).steps[0]).toEqual(['flutter', 'build', 'ios', '--simulator', '--debug'])
  })

  it('refuses an Xcode build without its scheme', () => {
    expect(() => buildPlan({ platform: 'ios', stack: 'xcode', root: '', xcodeContainer: 'A.xcodeproj' })).toThrow('scheme')
  })
})

describe('pickArtifact', () => {
  it('prefers an arm64 or universal APK and never a test build', () => {
    expect(pickArtifact(['app-x86_64-debug.apk', 'app-arm64-v8a-debug.apk', 'app-universal-debug.apk'], '.apk')).toBe('app-arm64-v8a-debug.apk')
    expect(pickArtifact(['app-debug-androidTest.apk', 'app-debug.apk'], '.apk')).toBe('app-debug.apk')
    expect(pickArtifact(['ShopUITests-Runner.app', 'Shop.app'], '.app')).toBe('Shop.app')
    expect(pickArtifact(['readme.txt'], '.apk')).toBeNull()
  })
})

describe('pickDevice', () => {
  const d = (name: string, platform: string, status = 'shutdown', formFactor = 'phone') => ({ id: name, name, platform, status, formFactor, sessionId: `s-${name}` })

  it('reuses a booted stock phone, then a stock phone, never a person-named or tablet first', async () => {
    const { pickDevice } = await import('../mobile-project')
    const list = [d('olimar', 'ios', 'booted'), d('iPad Pro 13-inch (M5)', 'ios', 'booted', 'tablet'), d('iPhone 17 Pro', 'ios'), d('iPhone 17', 'ios', 'booted'), d('tapflow-phone', 'android')]
    expect(pickDevice(list, 'ios')?.name).toBe('iPhone 17')
    expect(pickDevice(list.filter((x) => x.name !== 'iPhone 17'), 'ios')?.name).toBe('olimar') // booted beats a cold boot
    expect(pickDevice([d('olimar', 'ios'), d('iPhone 17 Pro', 'ios')], 'ios')?.name).toBe('iPhone 17 Pro')
    expect(pickDevice(list, 'android')?.name).toBe('tapflow-phone')
    expect(pickDevice([d('iPad Air 11-inch (M4)', 'ios', 'shutdown', 'tablet')], 'ios')?.name).toBe('iPad Air 11-inch (M4)')
    expect(pickDevice(list, 'android' as const) && pickDevice([], 'ios')).toBeNull()
  })
})
