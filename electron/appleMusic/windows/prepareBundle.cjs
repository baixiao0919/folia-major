'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Builds and verifies the Windows WebView2 Apple Music host for electron-builder (build/beforePack.cjs, build/afterPack.cjs).

// Files the host needs at run time; the .pdb, the WPF wrapper and the duplicate runtimes/ loader stay out of the package.
const WINDOWS_COMPANION_FILES = [
    'FoliaAppleMusicCompanion.exe',
    'FoliaAppleMusicCompanion.exe.config',
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll',
];

// The project targets x64 only (PlatformTarget x64); other architectures would ship a host that cannot load its loader.
function prepareWindowsCompanion({ arch, projectRoot, run = execFileSync }) {
    if (arch !== 'x64') throw new Error(`Unsupported Apple Music companion architecture: ${arch}`);
    const outputDir = path.join(projectRoot, 'build/apple-music-native/windows');
    // Cross-build exception, the same idea as FOLIA_SKIP_MNN in build/beforePack.cjs: MSBuild is not
    // available on a non-Windows host, so FOLIA_SKIP_WIN_COMPANION=1 uses the prebuilt host staged there
    // (e.g. copied out of an official release) instead of compiling. The files are checked here rather
    // than only after signing, so a stale staging directory fails before the long pack step.
    if (process.env.FOLIA_SKIP_WIN_COMPANION === '1') {
        const fs = require('node:fs');
        const missing = WINDOWS_COMPANION_FILES.filter(file => !fs.existsSync(path.join(outputDir, file)));
        if (missing.length > 0) {
            throw new Error(
                `FOLIA_SKIP_WIN_COMPANION=1 but ${outputDir} is missing ${missing.join(', ')} - `
                + 'stage the prebuilt Apple Music Windows host there or build it on Windows',
            );
        }
        return outputDir;
    }
    run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(projectRoot, 'electron/appleMusic/windows/buildCompanion.ps1')], { stdio: 'inherit' });
    return outputDir;
}

// Fail packaging when any of the host's files did not reach resources/apple-music/windows.
async function verifyWindowsCompanion(resourcesDir) {
    const fs = require('node:fs/promises');
    const folder = path.join(resourcesDir, 'apple-music/windows');
    for (const file of WINDOWS_COMPANION_FILES) await fs.access(path.join(folder, file));
}

module.exports = { WINDOWS_COMPANION_FILES, prepareWindowsCompanion, verifyWindowsCompanion };
