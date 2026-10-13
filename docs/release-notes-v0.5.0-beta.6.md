# 0.5.0-beta.6 — call fixes, bigger Korean STT model, UI audit batch (private rehearsal)

Call mode
- A repeated final transcript within 2 s is no longer sent twice.
- One failed audio upload or TTS request is retried once, then skipped; the call
  ends only on hang-up or three consecutive failures. A settings-poll failure no
  longer tears down a call.
- Retryable upstream overload shows a quiet "다시 보내는 중..." line instead of a
  red error; the error appears only when retries are exhausted.
- Stalled playback waits up to 8 s to resume before the segment is skipped.
- Chat and both companion variants now show the call state (듣는 중 / 말하는 중 /
  다시 보내는 중...) and an always-visible 통화 종료 button. Esc still hangs up.
- Call and TTS errors are shown in the companion bubble when no toast exists.

Speech recognition
- Settings → 음성 입력 → 인식 모델: Small 72M (default) or Large 174M (~120 MB,
  chunk-32, same beam search). Large pads 1.28 s of trailing silence.

From the UI audit (docs/reports/ui-audit-20261013.md, items 1/4/5/6)
- Update check compares prerelease versions correctly; beta installs see newer
  betas, stable installs stay on the stable feed.
- Companion settings keep unsaved interval/sound edits when a toggle is saved;
  failed saves restore the last confirmed value and say so.
- TTS enable / voice change failures restore the previous value and show the error.
- Confirm dialogs have dialog semantics: focus moves in, Tab is trapped, Esc
  cancels, focus returns to the opener.

Known: real microphone/playback and live update download not exercised in tests.
