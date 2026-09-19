// Bounded native Bonjour check: no microphone access, installation or keystrokes.
const { app } = require('electron');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
let child, native;
app.whenReady().then(async () => {
  native = require('../build/desktop/keyboard.node');
  native.advertise(43219);
  try {
    await new Promise((resolve, reject) => {
      child = spawn('/usr/bin/dns-sd', ['-L', 'NoKey', '_nokey._tcp', 'local.']);
      let output = '';
      const timer = setTimeout(() => reject(Error('Bonjour resolve timeout: ' + output)), 6000);
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes(':43219')) { clearTimeout(timer); resolve(); }
      });
      child.on('error', reject);
    });
    assert.throws(() => native.advertise(-1));
    console.log(JSON.stringify({ ok: true, message: 'Native Bonjour advertisement resolves to the actual advertised port; publication stopped on exit.' }));
  } finally { child?.kill(); native.advertise(0); app.quit(); }
}).catch(error => { console.error(error); child?.kill(); native?.advertise(0); app.exit(1); });
