const path = require('node:path');

const nativeBuildDirectory = process.env.JACKY_ELECTRON_NATIVE_BUILD_DIR
  || path.join(process.env.LOCALAPPDATA || path.join(__dirname, 'build'), 'JackyImageBuild');

module.exports = {
  outDir: path.join(nativeBuildDirectory, 'out'),
  packagerConfig: {
    asar: true,
    executableName: 'Jacky Image',
    icon: path.join(nativeBuildDirectory, 'icon'),
    electronZipDir: path.join(__dirname, 'build', 'electron-cache'),
    extraResource: [path.join(__dirname, 'build', 'desktop-runtime')],
    ...(process.env.WINDOWS_CERTIFICATE_FILE ? {
      certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
      certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
    } : {}),
    ignore: [
      /^\/\.git(?:\/|$)/,
      /^\/\.next(?:\/|$)/,
      /^\/backend(?:\/|$)/,
      /^\/doc(?:\/|$)/,
      /^\/electron\/.*\.test\.cjs$/,
      /^\/frontend(?:\/|$)/,
      /^\/mastra(?:\/|$)/,
      /^\/out(?:\/|$)/,
      /^\/release(?:\/|$)/,
      /^\/build\/desktop-runtime(?:\/|$)/,
      /^\/build\/electron-cache(?:\/|$)/,
      /^\/build\/native(?:-test)?(?:\/|$)/,
      /^\/build\/qa-user(?:-\d+)?(?:\/|$)/,
      /^\/scripts(?:\/|$)/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32'],
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
  ],
};
