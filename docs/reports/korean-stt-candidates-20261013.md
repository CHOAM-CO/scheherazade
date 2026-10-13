# Korean STT candidates for Sera (research, 2026-10-13 21:4x, saved by idea from the researcher's reply)

Current: kangkyu/icefall-asr-ko-streaming-zipformer-72m, int8, chunk 16. Card: KsponSpeech-eval CER 8.6% with modified_beam_search (beam 8) + trailing padding. Sera's stt-worker.mjs:25 uses greedy_search and no trailing-silence padding -> first free move: modified_beam_search + maxActivePaths 8 + pad CHUNK*0.04 s before inputFinished.

KsponSpeech (casual Korean) CER, kangkyu's 6,000-cut eval: 72M 7.68 / 174M 7.16 / Qwen3-ASR-1.7B 9.99 / Whisper-large-v2 13.17.
OpenKoASR board (https://gt-kim.github.io/open-korean-automatic-speech-recognition/): Whisper-L-v3 15.03 / v3-turbo 15.84 / Qwen3-ASR-1.7B 16.81 / 0.6B 19.77 / Whisper-medium 23.39 / small 26.04 / Nemotron-3.5 streaming 0.6B 31.35.

Shortlist
1. kangkyu 174M streaming zipformer int8 (https://huggingface.co/kangkyu/icefall-asr-ko-streaming-zipformer-174m): chunk-16 8.26 / 32 7.82 / 64 7.53 CER, RTF 0.05-0.07 CPU, Apache-2.0, same OnlineRecognizer API/file layout, ~2x download (int8 size unverified).
2. Qwen3-ASR-0.6B sherpa-onnx int8 (~940 MB, offline + simulated streaming w/ Silero VAD, node addon example exists). Korean-only CER not published for 0.6B; OpenKoASR 19.77. Risks: 1 GB, LLM-decoder repetition loops, no GPU path in sherpa-onnx-node.
3. Whisper large-v3-turbo (whisper.cpp/sherpa-onnx, ~800 MB int8, MIT): OpenKoASR 15.84; Korean fine-tune ghost613/whisper-large-v3-turbo-korean Zeroth CER 2.06 (read speech only). Offline, hallucinates on silence.
4. SenseVoice-Small (228 MB int8, RTF 0.007, FunAudioLLM licence): CommonVoice-ko 8.28; no Kspon number; expect worse than zipformers on casual Korean.
5. Qwen3-ASR-1.7B: best general-model Korean but community-only export, >2 GB. Skip.
Dropped: Parakeet/Canary (no ko), Nemotron streaming (31 CER), Moonshine (en), FunASR-Nano (no ko), older k2 Korean zipformers, kangkyu multidomain offline (repo gone).

Recommendation: (a) beam search + padding on the 72M now, A/B; (b) swap to 174M chunk-32 streaming; (c) second pass = 174M chunk-64 re-decode of the buffered utterance (in-domain, cheap) or Qwen3-ASR-0.6B for noise/names robustness.
Unverified: 174M int8 sizes; Qwen 0.6B desktop latency; all 72M-vs-174M numbers from kangkyu's own card.
