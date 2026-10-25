/**
 * Single source of truth for configuration.
 * `secret: true` fields are encrypted at rest and never sent to the browser
 * in full - the API returns a masked placeholder instead.
 */
export const DEFAULT_CONFIG = {
  web: {
    // Sign an idle admin out. The portal polls /queue every few seconds and
    // holds an SSE stream open, so an "any request" timer would never fire
    // with a tab left open - which is precisely the case this guards. Only
    // deliberate actions count as activity; background polling does not.
    // 0 disables it. This is the default: an admin whose account carries its
    // own idleTimeoutMinutes gets that instead. Only the super-admin may
    // change either (see src/web/idle.js). When the operator's live settings
    // became the defaults (2026-10-12) this stayed 15: theirs is 0, never
    // signed out, which is a choice for their own box and not one to hand a
    // new install whose panel may face a network.
    idleTimeoutMinutes: 15,
    port: 8080,
    bindAddress: '0.0.0.0',
    adminPasswordHash: '',      // legacy single-password; migrated into `admins`
    // Portal accounts. First entry is the shared super-admin (created from the
    // legacy password on upgrade). Each: { username, passwordHash, role, createdAt, lastLogin,
    // idleTimeoutMinutes? } - the last is absent when the admin uses the default above.
    // Password hashes are one-way scrypt, stored as-is (config.json is 0600).
    admins: [],
    sessionSecret: '',          // generated on first run
  },

  whatsapp: {
    // Several numbers can be set up, each with its own saved session, so a
    // linking problem on one never leaves the bot with no way back. Switching
    // is instant and switching BACK does not require re-linking.
    accounts: [],               // [{ id, label, phoneNumber }]
    activeAccount: '',          // id of the number currently in use
    phoneNumber: '',            // E.164 without '+', e.g. 15551234567
    // 'qr' (scan from the phone) | 'pairing' (code pushed to the phone). QR is
    // the default (the operator, 2026-10-06): it needs no number typed in first,
    // and a pairing code goes only to whatsapp.phoneNumber, blank on a new box.
    // The pairing code is the backup, offered beside the QR for one link
    // (2026-10-25: "code usually fails").
    loginMethod: 'qr',
    autoReconnect: true,
    // Keeping this false leaves your phone's presence alone. It stayed false
    // when the operator's live settings became the defaults (2026-10-12):
    // on, every reconnect announces the account online around the clock
    // (docs/whatsapp-ban-risk.md).
    markOnline: false,
    // Deliberate pacing between outbound actions. This exists so the bot does
    // not flood your own groups or hammer the connection, not to disguise it.
    minActionDelayMs: 1200,
    maxActionDelayMs: 3500,

    /**
     * Pacing for BULK work - anything that repeats the same action across many
     * groups, members or messages. These are the patterns WhatsApp rate-limits,
     * so each is deliberately slow: quicker than a person doing it by hand, but
     * nowhere near machine speed. Raise them if the account is ever throttled.
     */
    // One group at a time: descriptions, member changes, bans across groups.
    // A person doing this by hand takes 15-30s per group.
    bulkPacingMs: 4000,
    // Deleting messages. By hand that is long-press, delete, confirm - several
    // seconds each. 400ms was roughly ten times faster than a human.
    revokePacingMs: 2500,
    // The same large file to a second posts group. Uploads are already slow;
    // this is the gap between them.
    broadcastPacingMs: 8000,
    /**
     * A ceiling on how MUCH is sent, not just how fast.
     *
     * Everything above shapes the GAP between actions. Nothing caps the TOTAL,
     * and at the pacing floor above, sustained, 1,000-3,000 actions an hour is
     * reachable with nothing to stop it. Volume is the one thing WhatsApp has
     * measurably punished this account for.
     *
     * As the windows fill the pacing stretches (a gradual slowdown looks like a
     * busy person; a hard stop looks like a broken bot), and past a threshold
     * work nobody is waiting on is dropped rather than delayed. Replies and
     * documents are NEVER dropped, at any level - a person who asked for a film
     * always gets their film.
     */
    budget: {
      enabled: true,

      /*
       * These are measured, not guessed. Counted from 18 Aug - 1 Sep, where a
       * unit is one message-equivalent and a socket open costs 5:
       *
       *   busiest ordinary hour      132 units   (message traffic only)
       *   worst hour on record     4,675 units   (935 socket opens, 20 Aug)
       *   busiest ordinary day     ~2,900 units
       *   worst day on record      5,599 units   (20 Aug)
       *
       * So the ceilings are set to be INVISIBLE on a normal night and to bite
       * on the pathology. A busy hour uses 11% of the hourly figure; the
       * reconnect storm that preceded a logout used 390% of it.
       */
      perHour: 1200,
      // Just above the worst day ever recorded, so a day worse than any seen
      // starts shedding cosmetics. A typical day sits near 35% of this.
      perDay: 8000,
      // Utilisation at which the pacing starts to stretch. Below this the
      // budget is invisible.
      softAt: 0.7,
      // How far the pacing may stretch at full utilisation. Capped, because an
      // unbounded stretch produces a queue that never drains.
      maxStretch: 4,
    },

    // How far the reconnect backoff is allowed to grow. It used to plateau at
    // 60s, so a long outage produced a knock every minute for hours - the
    // sustained pattern that gets an account flagged. Early attempts are still
    // fast; only a persistent failure backs off this far.
    maxReconnectDelayMs: 900000,   // 15 minutes

    /**
     * Automatic number failover. The numbers are a priority list; only ONE is
     * ever connected, because three live sessions from one IP is the footprint
     * all the pacing above exists to avoid - and three connected numbers would
     * each answer every request.
     */
    failover: {
      // On by default, the operator's live setting - "I just updated most of
      // the settings, please set these in the repo coding as default"
      // (2026-10-12). With no other number set up there is nothing to move
      // to, and the supervisor stands aside exactly as if this were off: no
      // number is marked failed, nothing is logged or emailed
      // (FailoverSupervisor._hasSpare in src/core/failover.js).
      enabled: true,
      order: [],                // account ids, best first; [] keeps config order
      // The bot already retries with its own backoff. Only once that has given
      // up is a spare worth waking - a blip should not move the whole bot.
      failAfterAttempts: 4,
      // How long the current number must be stable before a preferred one may
      // reclaim it. Stops the bot flapping between numbers.
      holdDownMs: 600000,       // 10 minutes
      // How long a number that failed is left alone before being tried again.
      cooldownMs: 900000,       // 15 minutes
      // How long a switch waits for the new number to actually connect.
      probeTimeoutMs: 45000,
      checkEveryMs: 60000,
      // Circuit breaker. Switching numbers repeatedly is what gets accounts
      // flagged, and when the connection itself is unstable no number will
      // hold - so past this the supervisor stands down and lets the bot's own
      // reconnect backoff work.
      maxSwitchesPerWindow: 3,
      switchWindowMs: 3600000,   // one hour
    },
  },

  plugins: {
    enabled: ['movie-requests', 'tv-requests', 'direct-links'],
  },

  movieRequests: {
    requestGroups: [],          // group JIDs the bot listens to
    postsGroup: '',             // group JID the finished file is sent to
    postsGroups: [],            // optional extra posts groups; the file goes to each

    // Live text play-by-play posted to a separate notifications group as each
    // step completes. The requester is @-mentioned only when they are a member
    // of that group; otherwise the update is posted without a tag.
    notify: {
      group: '',                // JID of the notifications group ('' = off)
      tagRequester: true,       // @mention the requester when they're in it
      tagPostsGroup: true,      // @mention the posts group itself (same community only)
      noTag: [],                // numbers that must NEVER be tagged (opt-out)
      steps: {                  // which transitions post an update
        queued: true,
        downloading: true,
        converting: true,
        sending: true,
        done: true,
        blocked: true,          // rated / theaters / not found / not in library
      },
    },
    // Auto-moderation of the request groups. These groups are requests-only,
    // so anything that isn't a properly formatted request is deleted for
    // everyone - exactly what an admin would otherwise do by hand.
    enforcement: {
      enabled: false,           // master switch (off until an admin turns it on)
      deleteNonRequests: true,  // no `prefix` -> chatting/thanks/tagging -> delete
      deleteMedia: true,        // pictures, screenshots, voice notes -> delete
      deleteMultiple: true,     // "oceans 11 and 12" -> one movie at a time
      exemptAdmins: true,       // group admins are never auto-moderated
      warnByDm: false,          // PM the person explaining why it was removed
      archiveAfterDm: true,     // archive that PM afterwards, to keep the chat list clean
    },
    // The request rules default to the operator's own (2026-10-12): "set what
    // I currently have as request-rules-2026-10-12-1700.csv as default" - the
    // panel's export of Movies -> Request rules: a #request prefix, a text
    // reply when blocking, no limit on the queue and an hour's cooldown.
    requirePrefix: true,        // only messages starting with `prefix` count
    prefix: '#request',
    reactions: {
      // --- blocks / dead ends (terminal) ---
      rated: '⛔',              // blocked: rating not allowed
      theaters: '🎪',           // missing, because it is still in cinemas
      notFound: '❓',           // no metadata match
      needYear: '📅',           // several films share this title - which year?
      // Several films asked for in one message ("the equalizer 1 & 2",
      // "rocky 1 2 3 4 5 and 6"): refused, one film per request - the
      // operator's rule of 2026-10-11 (movie-requests/several-films.js). Not
      // 📅, which asks for a year that would not help, nor 🚫, which says to
      // wait and send the same message again.
      oneAtATime: '☝️',
      // A request not written as one: a season or episode code the bot cannot
      // read ("SO1E11", "s1e", "se01ep05"), or a code with no show before it.
      // The operator asked for a reaction of its own, 2026-10-19 ("you make up
      // a new emoji for me"): ✍️, "write it again". It was ❓ or 📬 before,
      // and 📬 sent people looking for episodes that were on the server.
      writtenWrong: '✍️',
      notInLibrary: '📬',       // passed checks but we don't have it
      failed: '⚠️',            // something went wrong
      skipped: '⏭️',           // set aside by the admin (usually too big)
      cancelled: '❌',          // manually cancelled by an admin - not coming
      tooFast: '🚫',           // sent too many too quickly - throttled, not lost
      // No redo reaction ('🔄', "resumed after a restart / retried") any
      // more. On 2026-10-11 a restart put it on Ethan Adams's "Iron Man 3
      // 2013"; he read it as "send it again", did, and was answered 🤥. A
      // request picked back up or retried shows its place in line or the
      // stage it is at instead (media/stage-reaction.js), and an old
      // config.json's redo is dropped on load (config/store.js).
      // Requests are paused from the panel (src/core/request-pause.js): held,
      // and run by themselves, in order, when they resume - nothing to resend.
      paused: '⏸️',

      // --- live lifecycle (the bot updates these in place) ---
      researching: '🔍',        // looking the title up
      added: '🎬',              // accepted into the queue
      // Asked for while the same film or episodes are already waiting or in
      // progress for the group: not queued again, and the message follows the
      // earlier request to its end. The operator chose 🤥 (2026-09-29) so a
      // repeat request is told apart from a fresh one; it was 🎬 before.
      duplicate: '🤥',
      downloading: '⬇️',        // fetching from the library
      converting: '⚙️',         // re-encoding to fit
      sending: '⬆️',            // uploading to the posts group
      done: '✅',              // delivered

      // Queue position: the request's 1-based place in line, as a number
      // reaction - 1️⃣ is next to start, with nothing ahead of it. Index 0 is
      // place 1. A place past the end of the list - the 11th and further
      // back, with the ten numbers here - uses `positionOverflow`. This said
      // "the number of places ahead", which is one less, and the group
      // legends' 🔢 line said "more than 10 ahead".
      positions: ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'],
      positionOverflow: '🔢',

      // kept for backward compatibility; superseded by added/positions/downloading
      queued: '📥',
      working: '⚙️',
    },
    blockedRatings: ['R', 'NC-17', 'X', 'TV-MA'],
    // Treat a film nobody has classified as blocked rather than allowed.
    // "Not Rated" is not a clean bill of health - it is the absence of one.
    blockUnrated: false,
    // When a title alone matches several films (remakes - "Dune" is both
    // 1984 and 2021 - or a series that starts with the words typed), ask
    // which one rather than guessing. Off: the closest match is sent.
    requireYearWhenAmbiguous: true,
    // The question is asked as a numbered list (src/plugins/movie-requests/
    // pick-list.js), offering every sendable film whose title starts with the
    // words typed - remakes and franchise alike - in every request group,
    // while the question above is being asked at all. It was the beta feature
    // 'movie-pick-list' (beta001) until 2026-10-11, when a config.json that
    // had lost its mode left Heat and Venom asked "which year?" instead. A
    // list takes its number as the answer until it expires; a title more
    // sendable films start with than maxOptions gets one "add a word or the
    // year" reply instead. maxOptions was 5, then 9; a saved 5 or 9 is read
    // as 20, the whole-series ceiling beta001 asked for (see pickListSettings).
    pickList: {
      expiryMinutes: 10,
      maxOptions: 20,
      maxOpenPerGroup: 5,
    },
    // Not a gate. The library is consulted first, and anything we actually
    // have is sent whatever its release status. This only runs when a title
    // is missing, to explain why - "still in cinemas" rather than a flat
    // "not in library".
    theatrical: {
      enabled: true,
      // If OMDb reports a DVD/home date in the past, it has left theaters.
      useHomeReleaseDate: true,
      // Fallback when no home date is published: treat anything released
      // within this many days as still theatrical. 180, the operator's live
      // setting made the default (2026-10-12, see whatsapp.failover); it was 90.
      windowDays: 180,
      // Optional but strongly recommended: a free TMDB key turns this check
      // from a guess into a definitive answer (TMDB records digital/physical
      // release dates explicitly). Get one at themoviedb.org/settings/api
      tmdbApiKey: '',
    },
    replyOnBlock: true,         // also say why in text; off = react only
    // A film or show refused on its rating gets the ⛔ and nothing else: no
    // "is rated R" reply and no line in the notifications group (the
    // operator, 2026-10-21). True brings both back.
    announceRated: false,
    // A refused request - not in the library, not a film, which year, still
    // in theaters, rated - gets its reaction and no line in the
    // notifications group, which is for what is downloaded and sent (the
    // operator, 2026-10-21). True brings the lines back, for TV too.
    notifyRefusals: false,
    // Group rules text, served when someone sends `rulesCommand` IN A GROUP.
    // Never in a private message - answering unsolicited PMs reads as spam and
    // got this number flagged.
    // Seeded from default-rules.txt on first run; editable in the portal.
    rules: '',
    // The group rules command (`#rules`, `#rules-<name>`) is off: the operator,
    // 2026-10-22, "remove or disable the group rules feature". The rule texts
    // stay in content/rules/ and in the config, so turning it back on is one
    // setting; rulesReplyFor (src/plugins/movie-requests/rules.js) answers
    // nothing while this is off.
    groupRules: false,
    rulesCommand: '#rules',
    // Per-group rule sets. Each is its own command (e.g. "#rules-movies") the
    // bot answers with that text. `#rules` inside a group serves that group's
    // assigned set; in a DM it serves the master `rules` (or a menu of commands).
    ruleSets: [],          // [{ command: '#rules-movies', label: 'Movie request groups', text: '...' }]
    groupRuleSet: {},      // { [groupJid]: '#rules-movies' } - which set applies in which group
    // Requests waiting to start, films and TV together. A TV season is ONE,
    // however many episodes it holds (src/core/queue.js). 0 = no limit.
    maxQueueLength: 0,
    // A member's clock starts only when a request of theirs queues a film -
    // the operator's rule of 2026-10-01, "cooldown is only if the members
    // first request actually puts an item in queue". A refused request (rated,
    // not in the library, a list to pick from...) leaves it as it was, and
    // five of those in ten minutes meet the cooldown instead, as a backstop
    // (src/core/request-cooldown.js). 0 switches all of it off. An hour by
    // default, for films as for TV - the operator (2026-10-12): "in repo by
    // default 1 season max 10 espidoes and 1 hour cooldown for both movies
    // and shows". It is also how long a member's extra film is held behind
    // the TV (queue.js, extraFilmHoldMs).
    cooldownSecondsPerUser: 3600,
    // Skip the cooldown while nobody else is waiting: a member's request
    // inside their cooldown is let through when no OTHER member has anything
    // waiting or running in the queue (films and TV together), and their clock
    // starts again if it queues. The operator (2026-09-30): "if queue is
    // completely empty then obviously theres no issue with someone doing
    // multiple requests". The member's own requests do not count, or the
    // first one - running at once in an empty queue - would always send the
    // second into the cooldown and the option would do nothing. It never
    // waives the flood backstop: requests that queue nothing leave the queue
    // as empty as it was, and their answers post in the group
    // (docs/whatsapp-ban-risk.md). On by default, the operator's choice ("By
    // default on of course but yeh should be options"); off keeps the
    // cooldown for everyone.
    cooldownOnlyWhenOthersWait: true,
  },

  /**
   * TV is a separate section with its own request and posts groups, and its
   * own place in the queue. Movies always go first: no episode is processed
   * while any movie is waiting or still running (see queue.strictMoviePriority).
   */
  tvRequests: {
    // On by default, with the request prefix required as for films: the
    // operator's live settings (2026-10-12, "please set these in the repo
    // coding as default"). Until a TV request group is ticked no message is a
    // TV request, so a new install's TV section waits without a word.
    enabled: true,
    requestGroups: [],          // group JIDs that mean "this is a TV request"
    postsGroups: [],            // finished episodes are sent to EVERY group here
    requirePrefix: true,
    prefix: '#request',
    // A season is sent one episode at a time, in broadcast order, at most
    // this many episodes a request; with several seasons in one message, the
    // limit is for all of them. 0 = no limit. 10 episodes, 1 season and an
    // hour's cooldown are the operator's defaults (2026-10-12): "change repo
    // that it should be 10 episodes, 1 season, 900 secs cooldown by default",
    // then "in repo by default 1 season max 10 espidoes and 1 hour cooldown
    // for both movies and shows". The TV request group's description promises
    // "only process 10 episodes at a time"; unlimited, The Flash season 2
    // queued all 23 episodes and Hunter x Hunter 148 in one request.
    maxEpisodesPerRequest: 10,
    // How many seasons one message can queue ("The Office seasons 1-3").
    // Each is a place in line, and the message meets the cooldown once, so
    // without a limit "The Simpsons seasons 1-35" would take thirty-five
    // places and every episode of the show. The seasons past it are named in
    // one reply, to be asked for again later. 0 = no limit.
    maxSeasonsPerRequest: 1,
    blockedRatings: ['TV-MA', 'R', 'NC-17', 'X'],
    // As for films: the clock starts only when a request queues at least one
    // episode, never at "which season?" or a refusal (2026-10-01). An hour
    // (above), as for films.
    cooldownSecondsPerUser: 3600,
    // The TV cooldown's own "skip it while nobody else is waiting", as for
    // films (movieRequests.cooldownOnlyWhenOthersWait).
    cooldownOnlyWhenOthersWait: true,
    rules: '',
    // Reactions reuse the movie set unless overridden here. needSeason is
    // deliberately NOT 📅: that means "add the year" in the movie legend, and
    // adding a year to a TV request makes it fail to match.
    reactions: { needSeason: '📺' },
  },

  /**
   * Beta testing. New group-facing features are tried in a small test group
   * before they reach the main groups, which have hundreds of members each.
   * See src/core/beta.js.
   *
   * A beta group takes movie and TV requests like a main request group, but
   * nothing it produces leaves the beta groups: files go to `postsGroup`, or
   * back into the group the request came from when that is blank, and the
   * play-by-play is posted in the group the request came from - never in the
   * main notifications group.
   *
   * No beta groups by default. The three features in the registry are On by
   * default on a new install - everywhere, so they need no beta group -
   * which is how the operator runs them (2026-10-12, "please set these in
   * the repo coding as default"); a mode saved in the panel, Off included,
   * is kept. An install whose config.json was saved before then keeps every
   * feature it never switched on Off (keepSavedChoices in
   * src/config/store.js): the operator runs a second bot from this repo, and
   * an upgrade is not the place to switch on, in every group of a bot nobody
   * is watching, what nobody chose there. With no groups and no features,
   * the bot behaves exactly as it did before this section existed.
   */
  /**
   * Whose messages, in which groups, are news about the library - the people
   * who say there when a title is added or fixed (src/core/library-news.js).
   * The operator, 2026-10-09: "keep tabs on what head admin ... says on
   * discussions group for when issues are fixed". The hourly check reads
   * what they said. Empty means nobody is watched.
   */
  libraryNews: {
    senders: [],                // phone numbers, country code first, digits
    groups: [],                 // group JIDs their messages count in
  },

  /**
   * The operator's own Discord account, read-only, for the answers to the
   * support tickets they open with the Jellyfin host (src/core/discord-watch.js,
   * src/core/discord-reader.js). The operator, 2026-10-11: "create from
   * scratch a way I can connect my discord account to the ubuntu so you can
   * access it". Set on its own card (Settings -> Connection -> Discord
   * (read-only)) by the super-admin only; a settings save that carries any
   * of it is refused. Empty means nothing is read.
   */
  discord: {
    // The account's token: full access to the account, so encrypted at rest
    // (SECRET_PATHS) and never sent back to the panel.
    token: '',
    watch: {
      guilds: [],               // server ids whose channels are read
      channelPattern: '^ticket-', // which of their channels: Ticket Tool's ticket-0001
      channels: [],             // and these channel ids, whatever their name
    },
  },

  /**
   * The wanted list (src/core/wanted.js) and what is done when one of its
   * films arrives (src/core/wanted-arrival.js). The operator, 2026-10-11: a
   * request that comes back "not in the library" they ask the Jellyfin host
   * for, and once the film is available the bot is to queue it for whoever
   * asked, reacting on their message. What says it is available is the
   * bot's own library: the wanted recheck finding it there. Shown, and
   * switched, on the Wanted card (History tab).
   */
  wanted: {
    // Re-run each request answered "not in the library" for a film once the
    // wanted recheck finds it on the server. Off: the film is only marked
    // resolved, as before; "Re-run requests" on its card still re-runs them
    // by hand.
    rerunOnArrival: true,
  },

  beta: {
    groups: [],                 // group JIDs that act as beta request groups
    postsGroup: '',             // where beta requests are delivered ('' = back into the group they came from)
    // { [featureKey]: 'off' | 'beta' | 'on' } - unknown keys are ignored.
    // The operator's live modes (2026-10-12), for a new install: a
    // config.json saved before then keeps a feature it never named Off
    // (keepSavedChoices). A feature retired from the registry
    // (src/core/beta.js, RETIRED_CODES) leaves this list in the same commit:
    // a default left here would bring its "on" back with the key.
    features: {
      'tv-rating-notice': 'on',
      'movie-duplicate-notice': 'on',
      'tv-duplicate-notice': 'on',
    },
  },

  /**
   * Gemini, used ONLY to work out which film someone meant when OMDb cannot.
   * The title it returns is looked up in OMDb again; the rating always comes
   * from OMDb. A model must never be able to talk a blocked film past the
   * rating check by asserting a rating of its own.
   *
   * The lookup, the nudity check and letting a clean answer clear a rated
   * title are all on by default, as are the fallback providers below: the
   * operator's live settings (2026-10-12, "please set these in the repo
   * coding as default"). With no key for any provider - a new install - none
   * of it is asked and nothing is said: a request is judged on its rating
   * alone, as it was with them off (aiCanClear in content-check.js,
   * identifyTitle in gemini.js, anyAiKey in src/core/ai-providers.js).
   */
  gemini: {
    enabled: true,
    apiKey: '',
    // Blank is Automatic: the newest Gemini Flash the key can see, chosen
    // again every day (pickGeminiModel in src/core/ai-providers.js). A fixed
    // default here went dead when Google retired gemini-2.0-flash.
    model: '',
    // Below this it is guessing, and a wrong film is worse than "not found".
    minConfidence: 0.6,

    /**
     * Ask an AI what is actually IN a film or episode its rating blocks,
     * rather than trusting the letter grade: an MPAA rating conflates
     * violence, language and sex, which is how an R earned on violence was
     * blocked. The answer only ever helps a title through, never refuses one
     * - the operator's "No, AI only helps" (2026-09-29, content-check.js) -
     * and a title its rating lets through is not asked about.
     */
    contentCheck: true,
    minContentConfidence: 0.7,
    /**
     * Let a confident "no nudity" clear a film, or a TV episode, the RATING
     * would block, so an R for violence can still be sent. This loosens the
     * policy, so it is the operator's decision and not a model's - and the
     * operator made it: on in their live settings, and so the default since
     * 2026-10-12 (above). Off, the check has nothing it could change, and
     * nothing is asked (aiCanClear).
     */
    allowCleanRatedFilms: true,
    /**
     * When the content check keeps failing, say so. A failed check falls back
     * to the rating, which is safe but silent: on 2026-09-22 it failed all
     * morning (a retired model, then truncated replies, then the free tier's
     * daily quota) and films went out unchecked with nobody told. See
     * src/core/content-check-health.js.
     */
    contentCheckAlert: {
      afterFailuresInARow: 3,
      failuresWithin: 5,          // ...or this many inside the window, on and off
      windowMinutes: 30,
      throttleMinutes: 360,       // per reason
    },
  },

  /**
   * Fallbacks for Gemini, for both the nudity check and the film lookup.
   * Gemini's free tier allows 20 requests a day and was used up by
   * mid-morning on 2026-09-22, after which every film went out on its rating
   * alone. Groq, Cerebras, Mistral and OpenRouter have far larger free tiers
   * and are asked in `order` when the ones before them cannot answer (an order
   * saved before OpenRouter existed has it appended, last, by
   * normaliseOrder()); the switches above
   * (gemini.enabled, gemini.contentCheck) still decide whether either feature
   * runs at all. See src/core/ai-providers.js.
   *
   * canClearRated: whether a provider's "no nudity" may clear a film its
   * RATING blocks (with allowCleanRatedFilms on). The fallbacks run open
   * models that recall particular films less reliably than Gemini, so they
   * clear nothing unless the operator deliberately says otherwise - and the
   * nudity check, which is asked only to clear, does not ask them then. The
   * operator has said otherwise for Groq, Cerebras and OpenRouter, and every
   * provider is switched on: their live settings, the defaults since
   * 2026-10-12 (see gemini above). Mistral answers the film lookup and
   * clears nothing. A provider switched on with no key is passed over.
   *
   * model: blank means automatic - chosen from the provider's own model list
   * once a day, preferring large general-knowledge models.
   */
  ai: {
    order: ['gemini', 'groq', 'cerebras', 'mistral', 'openrouter', 'ollama'],
    // Gemini's key and model stay under `gemini` above.
    gemini: { enabled: true, canClearRated: true },
    groq: { enabled: true, apiKey: '', model: '', canClearRated: true },             // console.groq.com
    cerebras: { enabled: true, apiKey: '', model: '', canClearRated: true },         // cloud.cerebras.ai
    mistral: { enabled: true, apiKey: '', model: '', canClearRated: false },         // console.mistral.ai
    openrouter: { enabled: true, apiKey: '', model: '', canClearRated: true },       // openrouter.ai
    ollama: { enabled: true, apiKey: '', model: '', canClearRated: false },   // ollama.com (cloud)
  },

  // Questions in the discussions group: answered from the group's own rules
  // and texts, and from general knowledge where the AI is sure; anything else
  // goes to the admins (src/core/discussion-answers.js). Uses the Prime
  // Intellect key and model above. Off until a key and model are chosen.
  discussionAnswers: {
    enabled: false,
    // Head Admin: whatever she asks or tells the bot (a reply to it or an
    // @-mention), it says "Yes Boss" (the operator, 2026-10-25).
    yesBoss: ['15558100180'],
    // How many answers the bot may give per group in an hour. A question past
    // it goes to the admins, as one it cannot answer.
    maxPerHour: 20,
    // A member's remark that is not about movies, TV, the library or the bot is
    // answered with a short reminder to keep to the topic (once a person a day;
    // never an admin). The operator, 2026-10-23.
    keepOnTopic: true,
  },

  omdb: {
    apiKey: '',                 // free key from omdbapi.com
  },

  library: {
    provider: 'jellyfin',       // 'jellyfin' | 'plex' | 'http' | 'local'
    jellyfin: {
      baseUrl: '',              // http://192.168.1.x:8096
      // 'password'     - username + password (simplest)
      // 'quickconnect' - approve a 6-digit code from a signed-in Jellyfin client
      // 'apikey'       - a key from Dashboard -> API Keys
      authMethod: 'password',
      username: '',
      password: '',
      apiKey: '',
      accessToken: '',          // issued by password/quickconnect, cached here
      userId: '',               // filled in automatically after linking
      userName: '',             // display only
      deviceId: '',             // stable per-install id Jellyfin ties the session to
    },
    plex: {
      baseUrl: '',              // http://192.168.1.x:32400
      token: '',
    },
    http: {
      searchUrl: '',            // GET {searchUrl}?q=Title -> {url, title, year}
      authHeader: '',
    },
    local: {
      roots: [],                // ['/mnt/media/Movies']
      extensions: ['.mp4', '.mkv', '.avi', '.m4v', '.mov'],
    },
    matchThreshold: 0.72,
    // Some Jellyfin servers are slow to answer a search. The API is usually
    // far quicker than the web UI (no artwork to render), but this is set
    // generously so a slow library never fails a request outright.
    searchTimeoutMs: 180000,
    // Pause between pages of the clean-title catalogue walk. A full walk of a
    // 20,000-film library is about 110 requests, made one at a time; the pause
    // keeps that from reading as a burst to the server serving live requests.
    catalogueDelayMs: 150,
  },

  /**
   * A group that receives Jellyfin URLs instead of files, for people with no
   * content filter of their own. Nothing is delivered here, so the rating gate
   * does not apply - but restricted titles carry a disclaimer.
   */
  directLinks: {
    // On by default, the operator's live setting (2026-10-12, see
    // whatsapp.failover). Only the groups ticked below answer, so with none
    // it answers nothing, and says nothing about a missing key either.
    enabled: true,
    groups: [],                 // group JIDs that answer these commands
    movieCommand: '#request-movie',
    tvCommand: '#request-tv',
    // SECURITY: this key is published in every link, so anyone who sees one can
    // reach the whole Jellyfin API. Use a DEDICATED key created for this, which
    // can be revoked without disturbing the bot's own access.
    apiKey: '',
    // Use the Jellyfin account already configured in Settings unless a
    // dedicated key is set here. A dedicated key is still preferable: it can be
    // revoked without re-linking the bot.
    allowBotKeyFallback: true,
    linkType: 'stream',         // 'stream' plays in place; 'download' saves the file
    publicBaseUrl: '',          // if the server is reachable at a different address
    restrictedRatings: ['R', 'NC-17', 'X', 'TV-MA', 'MA', '18'],
    disclaimer: '',             // shown above restricted links; a default is used when blank
  },

  queue: {
    // Movies always go first: no TV episode starts while any movie is waiting
    // or still running. Turn off to run in plain arrival order.
    strictMoviePriority: true,
    // The fair order: the waiting line goes round the members - everyone's
    // first request before anyone's second, every second before any third -
    // so one member's extra requests are passed by each member who asks for
    // one thing, again and again (the operator, 2026-09-30: "the additional
    // items of the person who did multiple should get bumped to bottom of
    // queue so the other person can get the 1 item they need"). A member's
    // extra film also waits behind the TV until the film cooldown has passed
    // since it was queued. Jobs queued from the panel and retries count as
    // first requests, never bumped; once an admin moves something with the
    // arrows, the waiting line keeps the order it is left in. On by default,
    // the operator's choice ("By default on of course but yeh should be
    // options"); off is plain arrival order, as it always was. JobQueue's own
    // default stays off, so a queue built without this config (the tests)
    // is the old one. See src/core/queue.js.
    fairShare: true,
  },

  media: {
    workDir: '',                // defaults to <data>/media
    // WhatsApp rejects documents over 2GB. We target just under it.
    maxOutputBytes: 1932735283, // 1.8 GiB
    // The most a public link queued from the panel may download (Queue a
    // public link, media/public-link.js): refused when its server says it is
    // bigger, and stopped while streaming when it grows past this. A film in
    // 1080p is a few GB; this leaves room for a 4K one without letting a link
    // fill the disk.
    maxDownloadBytes: 20 * 1024 ** 3, // 20 GiB
    // 'auto' remuxes when the source already fits, re-encodes when it doesn't.
    strategy: 'auto',           // 'auto' | 'always-transcode' | 'copy-only'
    videoCodec: 'libx264',      // the CPU encoder
    // Which encoder re-encodes. 'auto' uses the NVIDIA GPU (h264_nvenc) when
    // a one-second test encode at the first conversion shows it works here,
    // else libx264. 'nvenc' and 'cpu' force one. A failed GPU encode always
    // goes again on the CPU, and three failures in a row leave the GPU alone
    // until restart (src/media/ffmpeg.js). The bot moved to WSL2 on the
    // operator's laptop (NVIDIA GPU) for this, 2026-09-29.
    videoEncoder: 'auto',       // 'auto' | 'nvenc' | 'cpu'
    // Encode speed profile. On the CPU 'fast' (480p/ultrafast) roughly halves
    // the time; on the GPU each profile maps to an NVENC preset. 'custom' uses
    // the raw preset + maxHeight fields below instead. 'fast', and ultrafast
    // for 'custom', are the operator's live settings, the defaults since
    // 2026-10-12 ("I just updated most of the settings, please set these in
    // the repo coding as default"); they were 'balanced' (720p) and veryfast.
    encodeProfile: 'fast',      // 'fast' | 'balanced' | 'quality' | 'custom'
    preset: 'ultrafast',
    audioCodec: 'aac',
    audioBitrateK: 128,
    maxHeight: 720,             // downscale ceiling when re-encoding ('custom' only)
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    // Delete a job's files the moment it is sent; off, a sent film stays in
    // the work directory until the hourly sweep clears it six hours on
    // (sweepWorkDir in src/media/work-files.js). This stayed on when the
    // operator's live settings became the defaults (2026-10-12, above),
    // although the live config.json held false: that false was not the
    // operator's choice. A broken panel save wrote it, with other settings,
    // at 21:00:29 UTC that day - every film sent before then logged
    // "cleaned up … of working files", and the save is fixed on its own.
    deleteAfterSend: true,
    // A re-encode is done in pieces of segmentSec seconds, each started
    // segmentWarmupSec early so the encoder's rate control has settled by
    // the frame the piece keeps (media/segmented.js), and a restart goes on
    // from the last finished piece instead of the start: a film is about 30
    // minutes of CPU on this box, and The Parent Trap lost 23 of them to a
    // restart on 2026-09-29. A source it cannot cut exactly (a variable frame
    // rate, a short one) is encoded in one pass, as before. Off, every encode
    // is one pass.
    segmentedEncode: true,
    segmentSec: 300,
    segmentWarmupSec: 5,
    // Jobs are pipelined by stage rather than run strictly one at a time.
    // `concurrency` caps how many jobs are in flight across all stages; the
    // per-stage slots below cap each stage so bandwidth and RAM are not
    // oversubscribed. With 1/1/1, one job can upload while another converts
    // while a third downloads - but never two downloads, two encodes, or two
    // uploads at once.
    concurrency: 3,
    pipeline: {
      download: 1,             // simultaneous downloads (bandwidth)
      convert: 1,              // simultaneous ffmpeg encodes (CPU + RAM)
      upload: 1,               // simultaneous uploads to WhatsApp
    },
  },

  // Global Shabbos and yom tov lockdown: lock all groups (admins-only
  // messaging) from candle-lighting in candleCity to havdalah in havdalahCity.
  lockdown: {
    // Seconds between each group when locking or unlocking everything.
    // Deliberately slow: a burst of group-setting changes is exactly the kind
    // of traffic WhatsApp rate-limits, and a lockdown is never urgent to the
    // second. 15 groups at 5s is a bit over a minute.
    pacingMs: 5000,
    // On by default, the operator's live setting (2026-10-12, see
    // whatsapp.failover). Havdalah opens every group but the always-locked
    // ones, so on a new install the schedule locks nothing until somebody
    // has looked at `alwaysLocked` below (scheduleHeld in
    // src/core/lockdown.js): it waits for Sync from WhatsApp, or a Save of
    // the card, rather than open the posts group to every member on its
    // first Motzei Shabbos.
    enabled: true,
    // Whole minutes, 0-120 for candle-lighting and 1-120 for havdalah; a save
    // outside that is refused. A havdalah of 0 is NO havdalah to hebcal - see
    // lockdownMinutesProblem in src/core/lockdown.js.
    candleMinutes: 18,        // lock = sunset − this, on erev, in candleCity
    havdalahMinutes: 20,      // unlock = sunset + this, on the last day, in havdalahCity
    // Where each end is measured: 'new-york' (two days of yom tov) or
    // 'jerusalem' (the Israeli calendar: one day, except Rosh Hashana, which
    // is two there too). New York candle-lighting and Jerusalem havdalah is
    // the operator's decision of 2026-09-22, made knowing it reopens the
    // groups late on Saturday morning in New York and leaves New York's
    // second day of yom tov open - see the top of src/core/lockdown.js before
    // changing either default.
    candleCity: 'new-york',
    havdalahCity: 'jerusalem',
    // Yom tov as well as Shabbos: Rosh Hashana, Yom Kippur, the first and last
    // days of Sukkos and Pesach, and Shavuos - each end on its own city's
    // calendar. Adjacent days are ONE lock: when yom tov runs into Shabbos
    // there is no havdalah between them.
    yomTov: true,
    // Groups that stay admins-only ALWAYS. Unlock (manual or havdalah) skips
    // these so a permanently-restricted group is never opened by the schedule.
    alwaysLocked: [],
    // Has somebody chosen the list above, an empty one included? Set by
    // every save of the lockdown card (PUT /config), and when a config.json
    // saved before the lockdown was on by default is loaded with it switched
    // on (keepSavedChoices in src/config/store.js). Until then an empty list
    // is a list nobody has looked at, and the schedule waits (scheduleHeld).
    alwaysLockedReviewed: false,
  },

  // The Google Drive Links group's archive and document (src/core/drive-links.js).
  // `enabled` keeps the Drive links posted in `group`; `post` also posts the
  // document there every night at 00:00 New York time and after members join
  // (src/core/drive-links-job.js). Both off, and no group, until the operator
  // sets them: the group is a jid, and posting is group-facing, so it is tried
  // in the beta group first.
  driveLinks: {
    enabled: false,
    post: false,
    group: '',
  },

  // A member flooding a group - stickers, pictures or chatter - locks it with
  // one message, until a person reopens it. Nothing is deleted and nobody is
  // removed. The thresholds and why: SPAM_DEFAULTS in src/core/spam-guard.js.
  spamGuard: {
    enabled: true,
    perSender: 10,
    perSenderMedia: 6,
    perGroup: 30,
    perGroupSenders: 3,
    windowSec: 60,
    notice: '🔒 This group has been locked because of spam. An admin will reopen it.',
  },

  // Locally-maintained banned numbers (from the "ban from all" action). The
  // Google Sheets integration is a later layer on top of this.
  bannedNumbers: [],

  // Daily record of what the bot did, committed to a branch of this repo.
  // Runtime state under data/ is capped and rotated - history at 500 rows,
  // logs pruned after 14 days - so the record of a dispute expires before
  // anyone looks for it. This keeps it. Credentials are never included: no
  // session, no config.json, no .env.
  backup: {
    enabled: false,
    hour: 0,                  // midnight, New York
    push: true,               // commit only, if the box has no push credentials
  },

  logging: {
    // Console/UI verbosity; the file always gets debug. debug by default,
    // the operator's live setting (2026-10-12, see whatsapp.failover).
    level: 'debug',
    retentionDays: 14,        // how long to keep rotated debug logs
    maxFileBytes: 33554432,   // roll over at 32 MB
  },

  /**
   * On by default, with error alerts and a daily summary at midnight, and no
   * email about the nudity check: the operator's live settings (2026-10-12,
   * "I just updated most of the settings, please set these in the repo
   * coding as default"). A new install has no account to send through, and
   * until an address and an app password are saved email counts as off:
   * nothing is built, tried or logged (emailReady in src/util/mailer.js).
   */
  email: {
    enabled: true,
    provider: 'gmail',        // gmail | outlook | yahoo | custom
    host: '',                 // custom only
    port: 587,                // custom only
    secure: false,            // custom only
    user: '',                 // your address, also the SMTP username
    appPassword: '',          // an APP password, not your account password
    from: '',                 // defaults to `user`
    to: '',                   // defaults to `user`
    // Email the log automatically when things go wrong, throttled so a
    // failing loop cannot fill your inbox.
    onError: true,
    errorThrottleMinutes: 30,
    // Email when the bot changes WhatsApp number on its own, and - most
    // importantly - when it goes down with no healthy spare to move to.
    // That last case is the one nobody finds out about otherwise.
    onFailover: true,
    failoverThrottleMinutes: 15,
    // Email when the nudity check keeps failing and films are being judged on
    // their rating alone - and once more when it is working again. Off by
    // the operator's choice (above); the dashboard card, the audit log and
    // the warn line still say so.
    onContentCheck: false,
    dailySummary: true,
    dailySummaryHour: 0,      // the box's local time, 24-hour: 0 is midnight
  },
};

/** Dot-paths whose values are encrypted at rest and masked in the API. */
export const SECRET_PATHS = [
  'web.adminPasswordHash',
  'web.sessionSecret',
  'omdb.apiKey',
  'gemini.apiKey',
  'ai.groq.apiKey',
  'ai.cerebras.apiKey',
  'ai.mistral.apiKey',
  'ai.openrouter.apiKey',
  'ai.ollama.apiKey',
  'library.jellyfin.apiKey',
  'library.jellyfin.password',
  'library.jellyfin.accessToken',
  'library.plex.token',
  'library.http.authHeader',
  'movieRequests.theatrical.tmdbApiKey',
  'email.appPassword',
  'directLinks.apiKey',
  'discord.token',
];

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
    return o[k];
  }, obj);
  target[last] = value;
}

/** Recursive merge of stored config over defaults, so new keys appear on upgrade. */
export function mergeDefaults(stored, defaults = DEFAULT_CONFIG) {
  const out = Array.isArray(defaults) ? [] : {};
  for (const [k, dv] of Object.entries(defaults)) {
    const sv = stored?.[k];
    if (dv && typeof dv === 'object' && !Array.isArray(dv)) {
      out[k] = mergeDefaults(sv ?? {}, dv);
    } else {
      out[k] = sv !== undefined ? sv : dv;
    }
  }
  // Preserve keys the defaults don't know about (e.g. third-party plugin config)
  for (const k of Object.keys(stored ?? {})) {
    if (!(k in out)) out[k] = stored[k];
  }
  return out;
}
