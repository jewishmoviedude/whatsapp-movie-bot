/**
 * Errors members have quoted, and what each one means: read by the hourly
 * check (incident-scan.js) and by the discussions agent (discussion-answers.js),
 * so a member who quotes one gets the known cure from either.
 */

// WhatsApp's own refusal to open a file a member was sent, as they quote it:
// "This file was sent in an unusual format that may indicate it is dangerous,
// corrupted, or otherwise not supported on WhatsApp. For security
// precautions, this file cannot be opened." (A. Ito's #issue #group04 about
// Daniel Sloss - Live Shows S01E01, 2026-10-12.) It was an H.264/AAC mp4 sent
// as it was, with 26 subtitle tracks besides; repackaged with only its picture
// and sound (src/media/ffmpeg.js planConversion) it opened - A. Ito, by way of
// the operator, 2026-10-13: "if anybody opens an #issue ticket and quotes
// that error you'll know what to do".
// A. Ito's own words did not quote it - "file for Daniel Sloss S01E01 gives
// this message when download is attempted", the warning was shown, not typed
// - so a file that will not open, or a message it "gives", counts too: the
// remedy has the session check the send before anything is re-posted.
export const UNOPENABLE = new RegExp([
  'unusual format', '(?:dangerous|corrupted),? or otherwise not supported', '(?:not|un)supported',
  "(?:file|it|video|episode|movie|film) (?:cannot|can'?t|could ?n'?t|won'?t|will not|does ?n'?t|does not) (?:be )?open",
  "(?:cannot|can'?t|could ?n'?t|unable to) open (?:the |this |that |it|my )",
  '(?:gives|gave|shows|showed|says|said|get|got|getting) (?:me )?(?:this|that|an?) (?:message|error|warning)',
].join('|'), 'i');

/**
 * WhatsApp's warning itself, as a member would paste it: stricter than
 * UNOPENABLE, which also takes "it gives this message". The discussions agent
 * acts on this one without asking (discussion-answers.js), and a message that
 * pastes it is taken even when it is not a question.
 */
export const WHATSAPP_BLOCKED = /unusual format|(?:dangerous|corrupted),? or otherwise not supported|for security precautions,? this file cannot be opened/i;
