import { Meteor } from 'meteor/meteor';
import { ReactiveVar } from 'meteor/reactive-var';
import './install.html';

const DISMISS_KEY = 'pwa-install-dismissed-at';
const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const installPromptEvent = new ReactiveVar(null);
const isInstalled = new ReactiveVar(
  typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: minimal-ui)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches ||
      window.navigator.standalone === true)
);

function recentlyDismissed() {
  const at = Number(localStorage.getItem(DISMISS_KEY));
  return Number.isFinite(at) && Date.now() - at < DISMISS_COOLDOWN_MS;
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPromptEvent.set(e);
});

window.addEventListener('appinstalled', () => {
  isInstalled.set(true);
  installPromptEvent.set(null);
  localStorage.removeItem(DISMISS_KEY);
});

Template.installBanner.helpers({
  canInstall() {
    return Boolean(installPromptEvent.get()) && !isInstalled.get() && !recentlyDismissed();
  },
  isInstalled() {
    return isInstalled.get();
  },
});

Template.installBanner.events({
  async 'click .install-btn'() {
    const ev = installPromptEvent.get();
    if (!ev) return;
    ev.prompt();
    const { outcome } = await ev.userChoice;
    if (outcome === 'dismissed') {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    }
    installPromptEvent.set(null);
  },
  'click .dismiss-btn'() {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    installPromptEvent.set(null);
  },
});
