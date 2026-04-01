/**
 * Setup file: intercepts require('node-pty') at the Node.js module loader level
 * so the native binary never needs to be built for tests.
 * Tests inject a ptyProvider via DI; they never call the real pty.spawn.
 */
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'node-pty') {
    return {
      spawn: () => {
        throw new Error('node-pty spawn should not be called in tests — use ptyProvider injection');
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};