#!/usr/bin/env node
'use strict';
// Run probe_interrupt.js with a hard timeout by spawning it as a child process
const { spawn } = require('child_process');
const path = require('path');

const dir = path.dirname(__filename);
const child = spawn('node', [path.join(dir, 'probe_interrupt.js')], {
    stdio: ['ignore', 'inherit', 'inherit'],
});

const timer = setTimeout(() => {
    console.log('\n[RUNNER] 20s timeout — killing probe');
    child.kill('SIGTERM');
}, 20000);

child.on('exit', (code) => {
    clearTimeout(timer);
    console.log(`[RUNNER] probe exited with code ${code}`);
    process.exit(0);
});
