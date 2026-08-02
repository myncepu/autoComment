import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLaunchAgentPlist,
  LAUNCH_AGENT_LABEL
} from '../scripts/manage-local-control-launch-agent.mjs';

test('launch agent runs the local control server at login and restarts failures', () => {
  const plist = buildLaunchAgentPlist({
    nodePath: '/opt/homebrew/bin/node',
    serverPath: '/tmp/Auto & Comment/serve.mjs',
    workingDirectory: '/tmp/Auto & Comment',
    stdoutPath: '/tmp/control.out',
    stderrPath: '/tmp/control.err'
  });

  assert.match(plist, new RegExp(`<string>${LAUNCH_AGENT_LABEL}</string>`));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<key>ProcessType<\/key>\s*<string>Background<\/string>/);
  assert.match(plist, /\/opt\/homebrew\/bin\/node/);
  assert.match(plist, /\/tmp\/Auto &amp; Comment\/serve\.mjs/);
  assert.doesNotMatch(plist, /\/tmp\/Auto & Comment/);
});
