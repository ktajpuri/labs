'use strict';
// Reset to clean state: fresh world (inventory 100, no charges), no orders.
const fs = require('fs');
const path = require('path');
const world = require('./lib/world');

world.resetWorld();
try { fs.unlinkSync(path.join(__dirname, 'state', 'orders.json')); } catch {}
try { fs.unlinkSync(path.join(__dirname, 'state', 'wf-history.json')); } catch {}
console.log('reset: world=fresh (inventory 100, 0 charges), orders cleared, history cleared');
