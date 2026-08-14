#!/usr/bin/env node
// pre-tool-vision-guard.mjs -- PreToolUse gate on Read: block image/PDF
// reads on lanes whose model cannot see them (v0.1.11).
//
// The failure this closes is documented from the field twice: one image Read
// on a non-vision ollama model does not just fail -- the image block stays in
// the transcript and 400s EVERY LATER TURN until the agent restarts
// (main.cjs's GLM5.2+ollama post-mortem; MAGI run-agent.sh carries the same
// wedge as a warning comment on the hermes lane). Uploads are already
// vision-gated with a caption stand-in (onboarding/routes/chat.cjs), but
// nothing stopped the agent itself from Read-ing a screenshot lying on disk.
// This hook is that missing enforcement: deny BEFORE the poison enters the
// transcript, with a redirect the model can act on -- the same
// redirect-not-just-block shape as pre-ask-user-question-redirect.mjs.
//
// The lane's vision status is decided at spawn time by the app
// (laneVision(), http-server.cjs -- first-party lanes 'yes', everything else
// 'no' unless on the known-vision list) and exported into the agent's env as
// SCHEHERAZADE_LANE_VISION. Missing or any value except 'no' means this hook
// stands down entirely -- vision-capable lanes keep full image Read, and a
// pre-0.1.11 supervisor that does not set the variable fails open, never
// closed. Fail-open on parse errors too, same contract as
// pre-tool-credential-guard.mjs: a broken guard must not brick tool calls.
//
// Extension-matched, not content-sniffed: the Read tool renders by file
// extension, and the wedge case is exactly the "obvious image file" one. A
// binary blob with no image extension read as text is garbage-in-context but
// does not 400 the lane.
import fs from 'node:fs'

const IMAGE_OR_PDF = /\.(png|jpe?g|gif|webp|bmp|ico|icns|tiff?|heic|heif|avif|pdf)$/i

function main() {
  if (String(process.env.SCHEHERAZADE_LANE_VISION || '') !== 'no') process.exit(0)
  let input
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'))
  } catch {
    process.exit(0)
  }
  if (String(input.tool_name || '') !== 'Read') process.exit(0)
  const ti = input.tool_input || {}
  const filePath = String(ti.file_path || '').trim().replace(/["'`]/g, '')
  if (!IMAGE_OR_PDF.test(filePath)) process.exit(0)
  process.stderr.write(
    'BLOCKED: this lane\'s model cannot see images or PDFs, and reading one poisons the session -- ' +
    'every later turn fails with a 400 until the agent restarts, which costs the user the whole conversation. ' +
    'Do NOT retry this Read or route around it (base64 via Bash is the same poison). ' +
    'If the user attached this image in chat, its caption is already in the attachment marker -- use that. ' +
    'Otherwise tell the user plainly: this model cannot view images, and ask them to describe it or paste text instead.'
  )
  process.exit(2)
}

main()
