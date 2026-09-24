const express = require('express');

/**
 * HTTP endpoint for Claude Code's Notification hook system.
 *
 * CC can be configured to POST to localhost:25283/api/cc-notification
 * when it becomes idle or wants user attention.
 *
 * Configure in ~/.claude/settings.json:
 * {
 *   "hooks": {
 *     "Notification": [
 *       {
 *         "matcher": {},
 *         "hooks": [{
 *           "type": "command",
 *           "command": "curl -s -X POST http://localhost:25283/api/cc-notification -H 'Content-Type: application/json' -d '{\"type\":\"idle\"}'"
 *         }]
 *       }
 *     ]
 *   }
 * }
 */
function createNotificationRouter(broadcastFn, pushNotifier) {
  const router = express.Router();

  router.post('/cc-notification', express.json(), (req, res) => {
    const { type, sessionId, message } = req.body || {};
    console.log(`[notification-bridge] Received: type=${type} session=${sessionId || 'unknown'}`);

    // Broadcast to all connected WebSocket clients
    broadcastFn({
      type: 'cc-notification',
      payload: { type: type || 'idle', sessionId, message },
    });

    // Send ntfy push notification if enabled
    if (pushNotifier && (type === 'idle' || !type)) {
      const title = 'ai-tabs: Session idle';
      const body = message || `Session ${sessionId || 'unknown'} is waiting for input`;
      const clickUrl = null; // Will be set by mobile client based on their access URL
      pushNotifier.notify(title, body, clickUrl).catch(() => {});
    }

    res.json({ ok: true });
  });

  return router;
}

module.exports = { createNotificationRouter };
