/**
 * Manual mock for node-pty.
 * The native binary is not available in test environments;
 * tests inject a ptyProvider via DI instead of relying on the real pty.
 */
module.exports = {
  spawn: () => {
    throw new Error('node-pty spawn should not be called directly in tests — use ptyProvider injection');
  }
};