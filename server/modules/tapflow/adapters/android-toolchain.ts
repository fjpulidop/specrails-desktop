/**
 * Finds the Android toolchain on this Mac: the SDK (the first candidate that has adb) and a JDK Gradle can
 * use (17 or newer through `java_home`, else Android Studio's bundled one).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ANDROID_STUDIO_JDK, androidSdkCandidates } from '../domain'

export function findAndroidSdk(env: Record<string, string | undefined> = process.env): string | null {
  return androidSdkCandidates(env, os.homedir()).find((sdk) => fs.existsSync(path.join(sdk, 'platform-tools', 'adb'))) ?? null
}

/** The adb to run: the SDK's, else whatever is on the PATH. */
export function adbPath(): string {
  const sdk = findAndroidSdk()
  return sdk ? path.join(sdk, 'platform-tools', 'adb') : 'adb'
}

export function findGradleJdk(): string | null {
  try {
    const home = execFileSync('/usr/libexec/java_home', ['-v', '17+'], { timeout: 5_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (home && fs.existsSync(path.join(home, 'bin', 'java'))) return home
  } catch { /* no JDK 17+ registered */ }
  return fs.existsSync(path.join(ANDROID_STUDIO_JDK, 'bin', 'java')) ? ANDROID_STUDIO_JDK : null
}
