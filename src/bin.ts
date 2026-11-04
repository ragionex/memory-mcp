#!/usr/bin/env node
// The package entry. It checks Node.js before the server or the setup loads: their imports
// stop an older Node.js with an unrelated error before any check of theirs could run.
// The minimum matches "engines" in package.json.
const major = Number(process.versions.node.split(".")[0]);

if (major < 18) {
  console.error(
    `Ragionex Memory needs Node.js 18 or later, and this computer has Node.js ${process.versions.node}. Install the latest Node.js from https://nodejs.org, then run this again.`,
  );
  process.exitCode = 1;
} else {
  // Not awaited: top-level await is itself a syntax error on the oldest Node.js versions.
  void import("./index.js");
}
