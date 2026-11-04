#!/usr/bin/env node
const major = Number(process.versions.node.split(".")[0]);
if (major < 18) {
    console.error(`Ragionex Memory needs Node.js 18 or later, and this computer has Node.js ${process.versions.node}. Install the latest Node.js from https://nodejs.org, then run this again.`);
    process.exitCode = 1;
}
else {
    void import("./index.js");
}
export {};
