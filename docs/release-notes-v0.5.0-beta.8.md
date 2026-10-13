# 0.5.0-beta.8 — smoother call turns, mic/voice toggles (private rehearsal)

- Call mode no longer sends every short recognized fragment as its own turn.
  Fragments inside a 1.2 s quiet window are merged into one user turn (caps:
  12 s / 400 chars); while Sera is still answering, newer speech replaces the
  pending turn with the older text kept in front. Shown as "듣는 중..." .
- Call-mode endpointing tolerates breathing pauses (trailing silence 1.8 s / 3.6 s
  instead of 1.2 s / 2.4 s; max utterance 12 s). Dictation into the text box is
  unchanged. Net effect: replies start ~3 s after you stop talking instead of
  mid-sentence; if that feels slow, the window is a single constant.
- Call bar (chat and companion): always-visible 세라 목소리 끄기 and 내 마이크 끄기
  toggles next to 통화 종료, red slash when off. Mic off sends no audio at all.
- Large 174M Korean model is now the default recognizer (small stays selectable).
- Starting a call cancels an open dictation session so the call profile applies.
