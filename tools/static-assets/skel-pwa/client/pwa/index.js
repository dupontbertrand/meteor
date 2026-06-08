import { Meteor } from 'meteor/meteor';
import { configure, getCollections } from './config.js';
import { boot } from './boot.js';
import { installInterceptor } from './capture.js';
import { installReplay } from './replay.js';

function collectionsByName() {
  return Object.fromEntries(getCollections().map((c) => [c._name, c]));
}

export const MeteorPWA = {
  configure,
  start() {
    const byName = collectionsByName();
    installInterceptor(Meteor.connection);
    installReplay(byName);
    return boot(byName);
  },
};
