// Loads server.js in-process with its WebSocket server captured instead of
// bound, so a test drives the connection handler with fake sockets.
let connectionHandler = null;
class CapturingWebSocketServer {
  on(event, handler) {
    if (event === 'connection') connectionHandler = handler;
    return this;
  }
}

const wsPath = require.resolve('ws');
const realWs = require(wsPath);
require.cache[wsPath].exports = { ...realWs, WebSocketServer: CapturingWebSocketServer };
const server = require('../../server');
require.cache[wsPath].exports = realWs;

function fakeSocket() {
  const handlers = {};
  return {
    readyState: 1,
    sent: [],
    on(event, handler) { handlers[event] = handler; },
    send(payload) { this.sent.push(JSON.parse(payload)); },
    close() { this.readyState = 3; if (handlers.close) handlers.close(); },
    receive(message) { handlers.message(JSON.stringify(message)); },
  };
}

function connect(remoteAddress = '127.0.0.1') {
  const socket = fakeSocket();
  connectionHandler(socket, { headers: {}, socket: { remoteAddress }, url: '/' });
  return socket;
}

module.exports = { server, connect };
