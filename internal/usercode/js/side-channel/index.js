'use strict';

// Minimal replacement for the npm package "side-channel" (used by qs.stringify
// for cycle detection). Only the subset qs 6.x calls is implemented: set, get,
// has, delete and assert, keyed by object identity.
module.exports = function getSideChannel() {
  var map = new WeakMap();
  return {
    assert: function (key) {
      if (!map.has(key)) {
        throw new TypeError('Side channel does not contain the key');
      }
    },
    has: function (key) {
      return map.has(key);
    },
    get: function (key) {
      return map.get(key);
    },
    set: function (key, value) {
      map.set(key, value);
    },
    delete: function (key) {
      return map.delete(key);
    }
  };
};
