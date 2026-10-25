import log from '../util/logger.js';
import { OVERRIDE_NAMESPACE } from './rating-overrides.js';
import { isBetaGroup } from './beta.js';
import { readStamTest, runStamTest, formatStamSummary } from './stam-test.js';

const logger = log.scope('plugins');

/**
 * Plugins are the extension point that keeps this platform general-purpose.
 * A plugin is an object:
 *
 *   export default {
 *     name: 'my-plugin',
 *     description: 'what it does',
 *     configKey: 'myPlugin',              // optional slice of config.json
 *     async setup(ctx) {},                // called once on load
 *     async onMessage(msg, ctx) {},       // every inbound message - a member's
 *                                         // reaction too, with msg.reaction
 *                                         // = { emoji, targetId, targetFromMe }
 *                                         // and no text (bot.js normalize)
 *     onStamAnswered(msg, sent, ctx) {},  // optional: a $stamtest's one answer
 *                                         // went out as `sent`
 *     async onConfigChange(cfg, ctx) {},  // settings saved in the UI
 *     async teardown() {},
 *   }
 *
 * `ctx` gives a plugin everything it needs without reaching into internals:
 *   ctx.bot      - send/react/download helpers
 *   ctx.config   - live config object
 *   ctx.queue    - shared serial job queue (downloads, encodes, uploads)
 *   ctx.linkQueue - light queue for lookup-only work, so a link request never
 *                  waits behind a multi-gigabyte download
 *   ctx.log      - namespaced logger
 *   ctx.store    - small persistent key/value scoped to the plugin
 *   ctx.overrideStore - where the rating-override list lives (shared by
 *                  films and TV; see src/core/rating-overrides.js)
 *   ctx.contentHealth - counts content-check failures and raises the alarm
 *                  when the check keeps failing (may be null in tests)
 *   ctx.requestPause - requests paused from the panel (src/core/request-pause.js):
 *                  a plugin that takes requests asks isPaused() where it would
 *                  run one, and hold()s it instead (may be null in tests)
 */
export class PluginManager {
  constructor({ bot, configStore, queue, linkQueue = null, stateStore, contentHealth = null, requestPause = null }) {
    this.bot = bot;
    this.contentHealth = contentHealth;
    this.requestPause = requestPause;
    this.configStore = configStore;
    this.queue = queue;
    this.linkQueue = linkQueue;
    this.stateStore = stateStore;
    this.plugins = new Map();
  }

  async load(name, mod) {
    const plugin = mod?.default ?? mod;
    if (!plugin || typeof plugin !== 'object' || !plugin.name) {
      throw new Error(`plugin "${name}" has no valid default export`);
    }
    if (this.plugins.has(plugin.name)) {
      logger.warn(`plugin ${plugin.name} already loaded, skipping`);
      return;
    }
    const ctx = this._contextFor(plugin);
    try {
      await plugin.setup?.(ctx);
      this.plugins.set(plugin.name, { plugin, ctx });
      logger.info(`loaded plugin: ${plugin.name}`);
    } catch (err) {
      logger.error(`plugin ${plugin.name} failed to load: ${err.message}`);
      throw err;
    }
  }

  async unloadAll() {
    for (const [name, { plugin }] of this.plugins) {
      try {
        await plugin.teardown?.();
        logger.info(`unloaded plugin: ${name}`);
      } catch (err) {
        logger.error(`plugin ${name} teardown failed: ${err.message}`);
      }
    }
    this.plugins.clear();
  }

  _contextFor(plugin) {
    const configStore = this.configStore;
    return {
      bot: this.bot,
      queue: this.queue,
      linkQueue: this.linkQueue ?? this.queue,
      log: log.scope(plugin.name),
      // Live getter: plugins always read current settings, never a stale copy.
      get config() { return configStore.get(); },
      configStore,
      store: this.stateStore.namespace(plugin.name),
      // Another plugin's store, to read: the movie plugin's start-up sweep
      // of the shared work directory spares the files TV journals as kept.
      peerStore: (name) => this.stateStore.namespace(name),
      // The rating-override list, which films and TV share. It lives in the
      // movie plugin's namespace, where it started; the TV plugin reads it
      // from there rather than keeping a second list that could disagree.
      overrideStore: this.stateStore.namespace(OVERRIDE_NAMESPACE),
      contentHealth: this.contentHealth,
      requestPause: this.requestPause,
    };
  }

  /** Fan a message out to every plugin; one plugin throwing must not stop the rest. */
  async dispatchMessage(msg) {
    // A $stamtest in a beta group runs like any test, with what the bot would
    // send gathered instead of sent, and is answered once (stam-test.js).
    const config = this.configStore?.get?.() ?? {};
    const stam = msg?.isGroup && !msg.fromMe && isBetaGroup(config, msg.chatJid) ? readStamTest(msg.text) : null;
    if (stam) return this._stamTest(msg, stam, config);
    return this._dispatch(msg);
  }

  async _dispatch(msg) {
    for (const [name, { plugin, ctx }] of this.plugins) {
      if (!plugin.onMessage) continue;
      try {
        await plugin.onMessage(msg, ctx);
      } catch (err) {
        logger.error(`plugin ${name} onMessage error: ${err.message}`, { stack: err.stack });
      }
    }
  }

  /**
   * A $stamtest: every plugin, inside the capture, then the one answer -
   * quoting the tester's message, so it reads as the answer to it. Sent
   * outside the capture, as an ordinary message.
   */
  async _stamTest(msg, stam, config) {
    const cap = await runStamTest(() => this._dispatch(msg));
    logger.info(`🧪 $stamtest in ${msg.chatJid} ("${stam.body.slice(0, 80)}"): ${cap.actions.length} action(s) gathered`);
    const text = formatStamSummary(stam.body, cap.actions, {
      groupJid: msg.chatJid, done: config.movieRequests?.reactions?.done ?? '✅',
    });
    let sent = null;
    try {
      sent = await this.bot.sendText(msg.chatJid, text, { quoted: msg });
    } catch (err) {
      logger.warn(`could not answer the $stamtest: ${err.message}`);
    }
    // The answer is the one message the tester sees, so a plugin whose test
    // left something open to answer - a "which one?" list, which can be
    // answered by reacting to the message that shows it - is told which
    // message that is (the movie plugin's onStamAnswered).
    if (!sent?.key?.id) return;
    for (const [name, { plugin, ctx }] of this.plugins) {
      try {
        await plugin.onStamAnswered?.(msg, sent, ctx);
      } catch (err) {
        logger.warn(`plugin ${name} onStamAnswered error: ${err.message}`);
      }
    }
  }

  async notifyConfigChange(config) {
    for (const [name, { plugin, ctx }] of this.plugins) {
      try {
        await plugin.onConfigChange?.(config, ctx);
      } catch (err) {
        logger.error(`plugin ${name} onConfigChange error: ${err.message}`);
      }
    }
  }

  list() {
    return [...this.plugins.values()].map(({ plugin }) => ({
      name: plugin.name,
      description: plugin.description ?? '',
      configKey: plugin.configKey ?? null,
    }));
  }
}
