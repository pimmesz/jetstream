#!/usr/bin/env node
// The `jetstream` bin shipped by the npm package (@pimmesz/jetstream): installs the packed
// Stream Deck plugin, and forwards every other verb to the installed plugin's own CLI.
// Kept to a single call so all the logic stays in npm-cli.ts, where it is unit-tested.
import { runJetstream } from '../npm-cli.js';

runJetstream();
