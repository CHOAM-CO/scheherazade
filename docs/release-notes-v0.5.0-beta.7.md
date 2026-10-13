# 0.5.0-beta.7 — STT diagnostic dump (private rehearsal)

- Settings → 음성 입력 → "들은 소리 파일로 남기기 (진단용)" (STT_DUMP, default off):
  saves what the recognizer actually hears as 16 kHz mono WAV under
  <userData>/stt-dumps (newest 50 kept). Lets mic quality be separated from
  model quality by re-running the same audio through other recognizers.
