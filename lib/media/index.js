const { MediaStore } = require('./store');
const { MediaManager } = require('./manager');
const { createMediaRouter } = require('./router');
const { buildMediaHooks, MEDIA_TOOL_MATCHER } = require('./hooks');
const { extractImageBlocks } = require('./extract');
const { TranscriptScanner } = require('./transcript-scan');

module.exports = {
  MediaStore,
  MediaManager,
  createMediaRouter,
  buildMediaHooks,
  MEDIA_TOOL_MATCHER,
  extractImageBlocks,
  TranscriptScanner,
};
