/**
 * Minimal reference plugin. Copy this folder as a starting point for
 * anything else you want the bot to do - it shows the whole contract:
 * config, message handling, replying, reacting, and using the queue.
 *
 * Enable it by adding "echo" to plugins.enabled in Settings.
 */
export default {
  name: 'echo',
  description: 'Replies to "!ping" with "pong". A template for new plugins.',
  configKey: 'echo',

  async setup(ctx) {
    ctx.log.info('echo plugin loaded - say "!ping" in any chat the bot can see');
  },

  async onMessage(msg, ctx) {
    if (msg.fromMe || !msg.text) return;

    if (msg.text.trim().toLowerCase() === '!ping') {
      await ctx.bot.sendText(msg.chatJid, 'pong', { quoted: msg });
      ctx.log.info(`ponged ${msg.pushName ?? msg.senderJid}`);
      return;
    }

    if (msg.text.trim().toLowerCase() === '!react') {
      await ctx.bot.react(msg, '👋');
    }
  },

  async onConfigChange(config, ctx) {
    ctx.log.debug('config changed');
  },

  async teardown() {},
};
