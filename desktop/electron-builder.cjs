module.exports = {
  appId: 'com.spotitube.desktop', productName: 'Spotitube',
  directories: { output: 'desktop-release', buildResources: 'desktop' },
  files: ['desktop/main.mjs', 'desktop/catalog.mjs', 'desktop/downloads.mjs', 'desktop/media-server.mjs', 'desktop/updater.mjs', 'desktop/preload.cjs', 'desktop/icon.png', 'desktop/web/**/*', 'package.json'],
  extraResources: [{ from: 'desktop/tools', to: 'tools', filter: ['*.exe', '*.txt', 'versions.json'] }],
  asar: true,
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'desktop/icon.ico', artifactName: 'Spotitube-Setup-${version}.${ext}', signExecutable: false, verifyUpdateCodeSignature: false },
  publish: { provider: 'generic', url: 'https://raw.githubusercontent.com/just-crow/Spotitube/main/docs/desktop/', useMultipleRangeRequest: false },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, deleteAppDataOnUninstall: false, include: 'desktop/installer.nsh' },
  npmRebuild: false,
};
