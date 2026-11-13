"use strict";

// build/beforePack.cjs
// Stages native runtimes for electron-builder's target platform and architecture.

const ARCH_NAMES = ["ia32", "x64", "armv7l", "arm64", "universal"];

exports.default = async (context) => {
  const arch = ARCH_NAMES[context.arch];
  if (!arch)
    throw new Error(
      `Unsupported electron-builder architecture ordinal: ${context.arch}`,
    );
  const { prepareBundledFfmpeg } = await import(
    "../packaging/ffmpeg/fetch-ffmpeg.mjs"
  );
  await prepareBundledFfmpeg({ platform: context.electronPlatformName, arch });
  // The analysis models' runtime (electron/analysis/mnn.cjs), built from the pinned MNN source.
  const { prepareBundledMnn } = await import("./buildMnnRuntime.mjs");
  // Cross-build exception: on non-host platforms (e.g. Windows targets built on Linux) the MNN
  // runtime cannot be compiled; FOLIA_SKIP_MNN=1 lets a prebuilt library staged at
  // build/mnn/win-x64/folia_mnn.dll (e.g. taken from an official release) be used instead.
  const skipMnn = process.env.FOLIA_SKIP_MNN === '1' && context.electronPlatformName === 'win32';
  if (!skipMnn) {
    await prepareBundledMnn({ platform: context.electronPlatformName, arch });
  }
  // The two models (Beat This! final0, htdemucs), verified against shared/modelManifest.json; one
  // file each for every platform.
  const { prepareBundledModels } = await import("./fetchModels.mjs");
  await prepareBundledModels({ outputDir: require("path").join(context.packager.projectDir, "models") });
  // Steam Audio, the scene engine's room sound (electron/acoustics/): every desktop platform's library,
  // from the pinned official SDK zip; extraResources takes this target's build/steam-audio/${os}-${arch}.
  // A target the SDK has no library for (Linux arm64) skips the download: the app runs without room sound.
  const { prepareSteamAudio, hasSteamAudioFor } = await import("./fetchSteamAudio.mjs");
  // Offline packaging: a library already staged under build/steam-audio/<os>-<arch>/ (for example
  // copied out of an installed build on a machine that has no SDK archive) is reused as-is instead
  // of re-downloading the whole multi-platform SDK zip. Nothing pre-stages that folder in CI.
  const steamFolder = `${context.electronPlatformName === "win32" ? "win" : context.electronPlatformName === "darwin" ? "mac" : context.electronPlatformName}-${arch}`;
  const stagedSteamDir = require("path").join(context.packager.projectDir, "build", "steam-audio", steamFolder);
  if (!hasSteamAudioFor(context.electronPlatformName, arch))
    console.log(`[steam-audio] no library for ${context.electronPlatformName}-${arch}, skipped`);
  else if (require("fs").existsSync(stagedSteamDir))
    console.log(`[steam-audio] reusing staged library in build/steam-audio/${steamFolder}`);
  else await prepareSteamAudio();
  if (context.electronPlatformName === 'win32') {
    // The Apple Music WebView2 host (electron/appleMusic/windows), compiled with MSBuild.
    const { prepareWindowsCompanion } = require('../electron/appleMusic/windows/prepareBundle.cjs');
    prepareWindowsCompanion({ arch, projectRoot: context.packager.projectDir });
  }
  if (context.electronPlatformName === 'darwin') {
    const { prepareMacCompanion } = require('../electron/appleMusic/macos/prepareBundle.cjs');
    prepareMacCompanion({ arch, projectRoot: context.packager.projectDir });
    const { prepareBundledKoffi } = await import('../packaging/macos/prepare-koffi.mjs');
    await prepareBundledKoffi({ arch, projectRoot: context.packager.projectDir });
    // The wallpaper's Stage Manager click guard (issue #698), a small native helper.
    const { prepareDesktopClickGuard } = await import('../packaging/macos/build-desktop-click-guard.mjs');
    await prepareDesktopClickGuard({ arch, projectRoot: context.packager.projectDir });
  }
};
