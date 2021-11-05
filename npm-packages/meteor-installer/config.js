const path = require('path');
const os = require('os');

const METEOR_LATEST_VERSION = '2.5.1-beta.2';
const sudoUser = process.env.SUDO_USER || '';
function isRoot() {
  return process.getuid && process.getuid() === 0;
}
const localAppData = process.env.LOCALAPPDATA;
const isWindows = () => os.platform() === 'win32';
const isMac = () => os.platform() === 'darwin';

let rootPath;
if (isWindows()) {
  rootPath = localAppData;
} else if (isRoot() && sudoUser) {
  rootPath = `/home/${sudoUser}`;
} else {
  if (isRoot()) {
    console.info(
      'You are running the install script as root, without SUDO. This is not recommended and should be avoided. Continuing.'
    );
  }
  rootPath = os.homedir();
}

if (isWindows() && !localAppData) {
  throw new Error('LOCALAPPDATA env var is not set.');
}

const meteorLocalFolder = '.meteor';
const meteorPath = path.resolve(rootPath, meteorLocalFolder);

module.exports = {
  METEOR_LATEST_VERSION,
  extractPath: rootPath,
  meteorPath,
  release: process.env.INSTALL_METEOR_VERSION || METEOR_LATEST_VERSION,
  rootPath,
  sudoUser,
  startedPath: path.resolve(rootPath, '.meteor-install-started.txt'),
  isWindows,
  isMac,
  isRoot,
};
