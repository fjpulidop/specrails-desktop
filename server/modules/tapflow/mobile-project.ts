/**
 * Which mobile apps a repository builds, how to build each one for a simulator/emulator, and which platform
 * to test first. Pure: the file system is a port (`ProjectFiles`), so the rules are testable with fixtures.
 *
 * Tapflow installs only simulator builds: an iOS `.app` built for the simulator (zipped on upload) and an
 * arm64 `.apk`; never `.ipa` or `.aab`. It never builds; Specrails does, with the project's own tools.
 */

export type MobilePlatform = 'ios' | 'android'
export type MobileStack = 'xcode' | 'gradle' | 'flutter' | 'react-native' | 'expo'

export interface MobileApp {
  platform: MobilePlatform
  stack: MobileStack
  /** Directory the build runs in, relative to the repository root ('' = the root). */
  root: string
  /** iOS: the `.xcworkspace` (preferred, CocoaPods) or `.xcodeproj` to build, relative to `root`. */
  xcodeContainer?: string
  /** Android: the Gradle module of the application (e.g. `app`). */
  gradleModule?: string
}

/** Read-only view of the repository (paths are relative to its root, '/'-separated). */
export interface ProjectFiles {
  exists(path: string): boolean
  /** Entry names of a directory, or [] when it does not exist. */
  list(dir: string): string[]
  /** File content (bounded by the adapter), or null. */
  read(path: string): string | null
}

const join = (...parts: string[]) => parts.filter(Boolean).join('/')
const SKIP = new Set(['node_modules', 'Pods', 'build', 'DerivedData', '.git', '.specrails', '.gradle', 'vendor'])

function packageJson(files: ProjectFiles, dir: string): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null {
  const raw = files.read(join(dir, 'package.json'))
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

function dependsOn(pkg: ReturnType<typeof packageJson>, name: string): boolean {
  return Boolean(pkg && (pkg.dependencies?.[name] || pkg.devDependencies?.[name]))
}

/** An app target for iOS in an Xcode project (not a framework, not macOS-only). */
function isIosAppProject(files: ProjectFiles, xcodeproj: string): boolean {
  const pbx = files.read(join(xcodeproj, 'project.pbxproj'))
  if (!pbx) return false
  return /com\.apple\.product-type\.application"?;/.test(pbx) && /SDKROOT = iphoneos;/.test(pbx)
}

/** The Xcode container to build in `dir`: a workspace that is not the project's inner one, else the project. */
function xcodeContainerIn(files: ProjectFiles, dir: string): string | null {
  const entries = files.list(dir)
  const project = entries.find((name) => name.endsWith('.xcodeproj') && isIosAppProject(files, join(dir, name)))
  if (!project) return null
  const workspace = entries.find((name) => name.endsWith('.xcworkspace'))
  return workspace ?? project
}

const ANDROID_APP_PLUGIN = /com\.android\.application|android\.application\b|alias\(libs\.plugins\.android\.application\)/

/** The Gradle application module under `dir` (Android Studio's default is `app`). */
function gradleAppModuleIn(files: ProjectFiles, dir: string): string | null {
  const isGradleRoot = ['settings.gradle', 'settings.gradle.kts'].some((name) => files.exists(join(dir, name)))
  if (!isGradleRoot) return null
  const candidates = ['app', ...files.list(dir).filter((name) => name !== 'app' && !SKIP.has(name) && !name.startsWith('.'))]
  for (const module of candidates) {
    for (const script of ['build.gradle.kts', 'build.gradle']) {
      const content = files.read(join(dir, module, script))
      if (content && ANDROID_APP_PLUGIN.test(content)) return module
    }
  }
  return null
}

/**
 * Every mobile app the repository builds. Cross-platform stacks (Flutter, React Native, Expo) are
 * recognised first, so their `ios/` and `android/` folders are not reported again as native apps.
 */
export function detectMobileApps(files: ProjectFiles): MobileApp[] {
  const apps: MobileApp[] = []
  const pubspec = files.read('pubspec.yaml')
  if (pubspec && /^\s*flutter:\s*$|sdk:\s*flutter/m.test(pubspec)) {
    if (files.exists('ios/Runner.xcodeproj') || files.exists('ios')) apps.push({ platform: 'ios', stack: 'flutter', root: '' })
    if (gradleAppModuleIn(files, 'android')) apps.push({ platform: 'android', stack: 'flutter', root: '' })
    return apps
  }
  const pkg = packageJson(files, '')
  if (dependsOn(pkg, 'react-native') || dependsOn(pkg, 'expo')) {
    const iosContainer = xcodeContainerIn(files, 'ios')
    const androidModule = gradleAppModuleIn(files, 'android')
    // Expo without native folders (managed workflow) is built after `expo prebuild`.
    const stack: MobileStack = !iosContainer && !androidModule && dependsOn(pkg, 'expo') ? 'expo' : 'react-native'
    if (stack === 'expo') return [{ platform: 'ios', stack, root: '' }, { platform: 'android', stack, root: '' }]
    if (iosContainer) apps.push({ platform: 'ios', stack, root: 'ios', xcodeContainer: iosContainer })
    if (androidModule) apps.push({ platform: 'android', stack, root: 'android', gradleModule: androidModule })
    return apps
  }
  // Native: the root and one level down (e.g. `iosApp/` and `androidApp/` of a Kotlin Multiplatform project).
  for (const dir of ['', ...files.list('').filter((name) => !SKIP.has(name) && !name.startsWith('.') && !name.includes('.'))]) {
    const container = xcodeContainerIn(files, dir)
    if (container && !apps.some((app) => app.platform === 'ios')) apps.push({ platform: 'ios', stack: 'xcode', root: dir, xcodeContainer: container })
    const module = gradleAppModuleIn(files, dir)
    if (module && !apps.some((app) => app.platform === 'android')) apps.push({ platform: 'android', stack: 'gradle', root: dir, gradleModule: module })
  }
  return apps
}

const IOS_SOURCE = /\.(swift|m|mm|h|xib|storyboard|plist|xcassets|entitlements)$|\.xcodeproj\/|(^|\/)ios\/|Podfile/
const ANDROID_SOURCE = /\.(kt|kts|java|gradle)$|(^|\/)android\/|AndroidManifest\.xml|(^|\/)res\//

export type PlatformChoice =
  | { kind: 'none' }
  | { kind: 'single'; platform: MobilePlatform }
  /** Both platforms exist: ask, recommending the one the change touched (or the remembered one). */
  | { kind: 'ask'; recommended: MobilePlatform | 'both' }

/**
 * What to test: the only platform there is; otherwise the platform the change touched; shared code
 * (Dart, JS/TS, Kotlin Multiplatform common) touches both. The person's last choice for the project wins.
 */
export function choosePlatforms(apps: readonly MobileApp[], changedFiles: readonly string[], remembered?: MobilePlatform | 'both' | null): PlatformChoice {
  const platforms = [...new Set(apps.map((app) => app.platform))]
  if (platforms.length === 0) return { kind: 'none' }
  if (platforms.length === 1) return { kind: 'single', platform: platforms[0]! }
  if (remembered) return { kind: 'ask', recommended: remembered }
  const ios = changedFiles.some((file) => IOS_SOURCE.test(file))
  const android = changedFiles.some((file) => ANDROID_SOURCE.test(file))
  return { kind: 'ask', recommended: ios && !android ? 'ios' : android && !ios ? 'android' : 'both' }
}

/** One build, as argv run in `cwd` (relative to the repository root), and where its artifact appears. */
export interface MobileBuildPlan {
  platform: MobilePlatform
  cwd: string
  steps: string[][]
  /** Directory (relative to the repository root) searched for the artifact after the build. */
  artifactDir: string
  /** `.app` (zipped on upload) or `.apk`. */
  artifactExtension: '.app' | '.apk'
}

/** Build output stays out of the source tree's tracked files (`.specrails/` is ignored by Specrails projects). */
export const MOBILE_BUILD_DIR = '.specrails/mobile-build'

/**
 * The simulator/emulator build of one app. `scheme` comes from `xcodebuild -list` (an effect, resolved by
 * the caller). Debug builds, no code signing, arm64 (Apple Silicon simulators and emulators).
 */
export function buildPlan(app: MobileApp, opts: { scheme?: string } = {}): MobileBuildPlan {
  const derivedData = join(MOBILE_BUILD_DIR, 'ios')
  if (app.platform === 'ios') {
    if (app.stack === 'flutter') {
      return { platform: 'ios', cwd: app.root, steps: [['flutter', 'build', 'ios', '--simulator', '--debug']], artifactDir: join(app.root, 'build/ios/iphonesimulator'), artifactExtension: '.app' }
    }
    if (app.stack === 'expo') throw new Error('Run `expo prebuild` first: a managed Expo app is built as React Native.')
    const steps: string[][] = []
    const cwd = app.root
    const container = app.xcodeContainer
    if (app.stack === 'react-native' && container?.endsWith('.xcworkspace')) steps.push(['pod', 'install'])
    if (!opts.scheme) throw new Error('An Xcode build needs its scheme (xcodebuild -list).')
    const target = container ? [container.endsWith('.xcworkspace') ? '-workspace' : '-project', container] : []
    const dd = cwd ? join(...cwd.split('/').map(() => '..'), derivedData) : derivedData
    steps.push(['xcodebuild', ...target, '-scheme', opts.scheme, '-configuration', 'Debug', '-sdk', 'iphonesimulator',
      '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', dd, 'CODE_SIGNING_ALLOWED=NO', 'build'])
    return { platform: 'ios', cwd, steps, artifactDir: join(derivedData, 'Build/Products/Debug-iphonesimulator'), artifactExtension: '.app' }
  }
  if (app.stack === 'flutter') {
    return { platform: 'android', cwd: app.root, steps: [['flutter', 'build', 'apk', '--debug', '--target-platform', 'android-arm64']], artifactDir: join(app.root, 'build/app/outputs/flutter-apk'), artifactExtension: '.apk' }
  }
  if (app.stack === 'expo') throw new Error('Run `expo prebuild` first: a managed Expo app is built as React Native.')
  const cwd = app.root
  const module = app.gradleModule ?? 'app'
  const steps: string[][] = [['./gradlew', `:${module}:assembleDebug`]]
  return { platform: 'android', cwd, steps, artifactDir: join(cwd, module, 'build/outputs/apk/debug'), artifactExtension: '.apk' }
}

/** The artifact to install among the build outputs: arm64 or universal APKs first, never a test build. */
export function pickArtifact(entries: readonly string[], extension: '.app' | '.apk'): string | null {
  const candidates = entries.filter((name) => name.endsWith(extension) && !/test|androidTest|UITests/i.test(name))
  if (extension === '.apk') {
    return candidates.find((name) => /arm64/.test(name)) ?? candidates.find((name) => /universal/.test(name)) ?? candidates.find((name) => !/x86|armeabi-v7a/.test(name)) ?? null
  }
  return candidates[0] ?? null
}

/** A device as Tapflow's `list_devices` reports it (the fields Specrails uses). */
export interface TapflowDevice {
  id: string
  name: string
  platform: string
  status: string
  formFactor?: string
  sessionId: string
}

/** Stock simulator/emulator names: never pick a device the person named and configured themselves. */
const STOCK_DEVICE = /^(iPhone \d+[a-z]?( (Pro|Pro Max|Plus|mini))?|iPhone Air|iPhone SE.*|tapflow-(phone|compact|large)|Pixel.*|Medium Phone.*)$/

/**
 * The device to run on: the one the person chose (if Tapflow still lists it), else a phone of the platform
 * that is already booted (no boot cost), else a stock
 * phone (the newest-looking first, as listed), else any phone; tablets and person-named devices last.
 */
export function pickDevice(devices: readonly TapflowDevice[], platform: MobilePlatform, preferredId?: string): TapflowDevice | null {
  const ofPlatform = devices.filter((device) => device.platform === platform)
  // The device the person chose, when Tapflow still has it.
  const preferred = preferredId ? ofPlatform.find((device) => device.id === preferredId) : undefined
  if (preferred) return preferred
  const phones = ofPlatform.filter((device) => (device.formFactor ?? 'phone') === 'phone')
  const booted = (list: readonly TapflowDevice[]) => list.find((device) => /booted/i.test(device.status))
  return booted(phones.filter((device) => STOCK_DEVICE.test(device.name)))
    ?? booted(phones)
    ?? phones.find((device) => STOCK_DEVICE.test(device.name))
    ?? phones[0]
    ?? ofPlatform[0]
    ?? null
}
