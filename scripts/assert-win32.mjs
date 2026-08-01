// assert-win32.mjs -- hard gate in front of `npm run dist:win`.
//
// The win installer must be built ON Windows, not cross-built from mac:
// build.asarUnpack ships the LOCAL node_modules tree verbatim, so a mac-run
// win build packages darwin natives (node-pty prebuilds, spawn-helper) into
// the NSIS installer -- an app that installs fine and dies at first PTY
// spawn. The failure is silent until a user hits it, which is the v0.0.23
// class of shipping error this repo already paid for once.
if (process.platform !== 'win32') {
  console.error(
    `dist:win must run ON Windows (this is ${process.platform}). ` +
    'asarUnpack packages the local node_modules, so a cross-build ships ' +
    'the wrong-platform natives. Build on the win box (magi-win).'
  )
  process.exit(1)
}
