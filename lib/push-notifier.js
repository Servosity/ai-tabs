const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NTFY_CONFIG_FILE = path.join(__dirname, '..', 'data', 'ntfy-config.json');

class PushNotifier {
  constructor() {
    this.config = this._loadConfig();
  }

  _loadConfig() {
    try {
      if (fs.existsSync(NTFY_CONFIG_FILE)) {
        return JSON.parse(fs.readFileSync(NTFY_CONFIG_FILE, 'utf8'));
      }
    } catch {}
    return { enabled: false, topic: null, server: 'https://ntfy.sh' };
  }

  _saveConfig() {
    fs.mkdirSync(path.dirname(NTFY_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(NTFY_CONFIG_FILE, JSON.stringify(this.config, null, 2));
  }

  /**
   * Enable push notifications. Generates a random topic if none exists.
   */
  enable() {
    if (!this.config.topic) {
      this.config.topic = 'aitabs-' + crypto.randomBytes(8).toString('hex');
    }
    this.config.enabled = true;
    this._saveConfig();
    return this.config;
  }

  disable() {
    this.config.enabled = false;
    this._saveConfig();
    return this.config;
  }

  getConfig() {
    return { ...this.config };
  }

  updateConfig(updates) {
    if (updates.server !== undefined) this.config.server = updates.server;
    if (updates.enabled !== undefined) this.config.enabled = updates.enabled;
    if (updates.enabled && !this.config.topic) {
      this.config.topic = 'aitabs-' + crypto.randomBytes(8).toString('hex');
    }
    this._saveConfig();
    return this.config;
  }

  /**
   * Send a push notification via ntfy.
   * @param {string} title - Notification title
   * @param {string} message - Notification body
   * @param {string} [clickUrl] - URL to open when notification is tapped
   */
  async notify(title, message, clickUrl) {
    if (!this.config.enabled || !this.config.topic) return;

    const server = this.config.server || 'https://ntfy.sh';
    const url = `${server}/${this.config.topic}`;

    const headers = {
      'Title': title,
      'Priority': '4',  // high
      'Tags': 'computer,robot',
    };
    if (clickUrl) {
      headers['Click'] = clickUrl;
    }

    try {
      await fetch(url, {
        method: 'POST',
        headers,
        body: message,
      });
    } catch (err) {
      console.error('[push-notifier] Failed to send notification:', err.message);
    }
  }
}

module.exports = { PushNotifier };
