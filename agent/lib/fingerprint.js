'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * A short hash of the agent's own code. Two machines with the same
 * fingerprint run the same agent, whatever AGENT_VERSION says, so the
 * dashboard can spot a machine that missed an update. Central uses this too,
 * on its copy of agent/, to know what "current" is.
 */
function fingerprint(agentDir) {
  const lib = path.join(agentDir, 'lib');
  const files = ['agent.js', 'install-startup.js', 'package.json',
    ...fs.readdirSync(lib).filter((f) => f.endsWith('.js')).sort().map((f) => path.join('lib', f))];
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(agentDir, f), 'utf8'); } catch { /* missing counts as empty */ }
    hash.update(`${f}\n${text.replace(/\r\n/g, '\n')}\n`); // a Windows copy with CRLF is still the same code
  }
  return hash.digest('hex').slice(0, 8);
}

module.exports = { fingerprint };
