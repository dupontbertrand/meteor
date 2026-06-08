import { Links } from '/imports/api/links/links.js';
import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import './info.html';

Template.info.onCreated(function () {
  Meteor.subscribe('links.all');
});

Template.info.helpers({
  links() {
    return Links.find({}, { sort: { createdAt: -1 } });
  },
});

Template.info.events({
  async 'submit .info-link-add'(event) {
    event.preventDefault();
    const target = event.target;
    const title = target.title.value.trim();
    const url = target.url.value.trim();
    if (!title || !url) return;

    // Client-generated _id + mutationId → the offline engine can capture this
    // write and replay it idempotently on reconnect.
    try {
      await Meteor.callAsync('links.insert', {
        _id: Random.id(),
        title,
        url,
        mutationId: Random.id(),
      });
      target.title.value = '';
      target.url.value = '';
    } catch (error) {
      alert(error.error || error.message);
    }
  },
});
