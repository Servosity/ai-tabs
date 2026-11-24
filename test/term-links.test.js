const { test } = require('node:test');
const assert = require('node:assert');

const { isOpenableLink, linkActivator, oscLinkHandler } = require('../public/term-links');

function recorder() {
  const opened = [];
  let focused = 0;
  const activate = linkActivator((uri) => opened.push(uri), () => { focused += 1; });
  return { activate, opened, focused: () => focused };
}

test('isOpenableLink: only http and https open', () => {
  for (const uri of ['https://example.com/a?b=1', 'http://localhost:3000']) {
    assert.strictEqual(isOpenableLink(uri), true, uri);
  }
  for (const uri of ['javascript:alert(1)', 'file:///C:/x', 'not a url', '', undefined]) {
    assert.strictEqual(isOpenableLink(uri), false, String(uri));
  }
});

test('OSC 8 link click opens the uri and gives the terminal focus back', () => {
  const r = recorder();
  const handler = oscLinkHandler(r.activate);
  let prevented = false;
  handler.activate({ preventDefault: () => { prevented = true; } }, 'https://example.com/docs');
  assert.deepStrictEqual(r.opened, ['https://example.com/docs']);
  assert.strictEqual(r.focused(), 1);
  assert.strictEqual(prevented, true);
  assert.strictEqual(handler.allowNonHttpProtocols, false);
});

test('a non-web link opens nothing but still refocuses', () => {
  const r = recorder();
  r.activate(undefined, 'file:///etc/passwd');
  assert.deepStrictEqual(r.opened, []);
  assert.strictEqual(r.focused(), 1);
});
