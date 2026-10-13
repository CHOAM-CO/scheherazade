/**
 * Streaming pocket-tts in the browser, on onnxruntime-web.
 *
 * A port of the Python runtime. The exported graph is one streaming step: text
 * embeddings, voice conditioning or the previous latent go in, one latent and
 * one 80 ms audio frame come out, along with the keys, values and convolution
 * state that step produced. This drives that graph, keeping the caches in
 * preallocated typed arrays so a step only ever hands the runtime a contiguous
 * window of the past.
 */
import { executionProviders } from "./platform.js";
import * as ort from "./ort.js";
import { SentencePiece } from "./sentencepiece.js";
import { MixedTokenizer, preparePhonemePrompt, prepareTextPrompt, splitIntoBestSentences, splitPhonemeChunks, } from "./text.js";
const TEXT_GATE = Float32Array.from([1, 0, 0]);
const LATENT_GATE = Float32Array.from([0, 1, 0]);
const COND_GATE = Float32Array.from([0, 0, 1]);
/** A grow-once buffer whose tail is handed to the graph as the past. */
class Cache {
    stride;
    buffer;
    length;
    /**
     * `prepad` zero entries count as already written, so a cache read through a
     * fixed-size window is long enough from the first step and `window` can hand
     * back a view instead of building a padded copy every frame.
     */
    constructor(stride, capacity, prepad = 0) {
        this.stride = stride;
        this.buffer = new Float32Array(stride * (capacity + prepad));
        this.length = prepad;
    }
    get capacity() {
        return this.buffer.length / this.stride;
    }
    reserve(extra) {
        const needed = this.length + extra;
        if (needed <= this.capacity)
            return;
        const grown = new Float32Array(this.stride * Math.max(needed, this.capacity * 2));
        grown.set(this.buffer.subarray(0, this.length * this.stride));
        this.buffer = grown;
    }
    append(values) {
        const frames = values.length / this.stride;
        this.reserve(frames);
        this.buffer.set(values, this.length * this.stride);
        this.length += frames;
    }
    /** The last `size` entries, zero-padded at the front while still short. */
    window(size) {
        if (size === undefined)
            return this.buffer.subarray(0, this.length * this.stride);
        const start = this.length - size;
        if (start >= 0)
            return this.buffer.subarray(start * this.stride, this.length * this.stride);
        const padded = new Float32Array(size * this.stride);
        padded.set(this.buffer.subarray(0, this.length * this.stride), (size - this.length) * this.stride);
        return padded;
    }
}
/**
 * The tensors one decode step hands the graph, built once per chunk.
 *
 * The loop runs about twelve times a second and hands the whole past back in
 * every frame, so it writes the scalars and the latent in place and rebinds
 * views over the caches, rather than building a fresh set of tensors and
 * copying the caches on this side of the runtime. Nothing here is shared
 * between takes: `stream` makes its own.
 */
class DecodeFeeds {
    config;
    inputNames;
    noise;
    latent;
    isBos;
    flowOffset = new BigInt64Array(1);
    mimiOffset = new BigInt64Array(1);
    kvDims;
    mimiKvDims;
    feeds = {};
    constructor(config, inputNames, lora, decodeSteps) {
        this.config = config;
        this.inputNames = inputNames;
        this.noise = new Float32Array(config.latent_dim);
        this.latent = new Float32Array(config.latent_dim);
        this.isBos = Float32Array.from([1]);
        this.kvDims = [config.flow_layers, 2, 1, config.flow_heads, config.flow_head_dim];
        this.mimiKvDims = [
            config.mimi_kv_len,
            config.mimi_layers,
            2,
            1,
            config.mimi_heads,
            config.mimi_head_dim,
        ];
        this.bind("tokens", new ort.Tensor("int64", new BigInt64Array(1), [1, 1]));
        this.bind("latent", new ort.Tensor("float32", this.latent, [1, 1, config.latent_dim]));
        this.bind("is_bos", new ort.Tensor("float32", this.isBos, [1, 1, 1]));
        this.bind("cond", new ort.Tensor("float32", new Float32Array(config.model_dim), [1, 1, config.model_dim]));
        this.bind("gates", new ort.Tensor("float32", LATENT_GATE, [3]));
        this.bind("noise", new ort.Tensor("float32", this.noise, [1, config.latent_dim]));
        this.bind("flow_offset", new ort.Tensor("int64", this.flowOffset, []));
        this.bind("mimi_offset", new ort.Tensor("int64", this.mimiOffset, []));
        this.bind("decode_steps", new ort.Tensor("float32", Float32Array.from([decodeSteps]), []));
        this.bind("lora", new ort.Tensor("float32", Float32Array.from([lora]), []));
    }
    /** Older exports lack the adapter and decode-step inputs; feed what exists. */
    bind(name, tensor) {
        if (this.inputNames.has(name))
            this.feeds[name] = tensor;
    }
    /** Point the step at the caches as they stand, and run it. */
    run(session, flowKv, mimiKv, mimiConv, mimiOffset) {
        this.flowOffset[0] = BigInt(flowKv.length);
        this.mimiOffset[0] = mimiOffset;
        // Only the views move: a cache buffer is reallocated when it grows, and the
        // mimi window slides forward a step at a time. The runtime copies whatever
        // it is handed into its own heap, so there is nothing to copy out here.
        this.bind("flow_kv", new ort.Tensor("float32", flowKv.window(), [flowKv.length, ...this.kvDims]));
        this.bind("mimi_kv", new ort.Tensor("float32", mimiKv.window(this.config.mimi_kv_len), this.mimiKvDims));
        this.bind("mimi_conv", new ort.Tensor("float32", mimiConv, [this.config.conv_state_size]));
        return session.run(this.feeds);
    }
    /** Carry the latent the last step produced into the next one. */
    advance(latent) {
        this.latent.set(latent);
        this.isBos[0] = 0;
    }
}
/** Deterministic normals, so a seed reproduces a take. */
class Random {
    state;
    constructor(seed) {
        this.state = (seed >>> 0) || 0x9e3779b9;
    }
    next() {
        // mulberry32
        this.state = (this.state + 0x6d2b79f5) >>> 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    normal() {
        let u = 0;
        let v = 0;
        while (u === 0)
            u = this.next();
        while (v === 0)
            v = this.next();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
}
function decodeBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++)
        bytes[i] = binary.charCodeAt(i);
    return bytes;
}
/** The voices travel as float16 to keep the asset small. */
function float16ToFloat32(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Float32Array(bytes.byteLength / 2);
    for (let i = 0; i < out.length; i++) {
        const half = view.getUint16(i * 2, true);
        const sign = half >> 15 ? -1 : 1;
        const exponent = (half >> 10) & 0x1f;
        const fraction = half & 0x3ff;
        if (exponent === 0)
            out[i] = sign * fraction * 2 ** -24;
        else if (exponent === 31)
            out[i] = fraction ? NaN : sign * Infinity;
        else
            out[i] = sign * (fraction / 1024 + 1) * 2 ** (exponent - 15);
    }
    return out;
}
export class PocketTTS {
    session;
    config;
    sp;
    phonemeTokenizer;
    voiceBlobs;
    inputNames;
    namedVoices = new Map();
    clonedVoices = new Map();
    encoder = null;
    constructor(session, assets) {
        this.session = session;
        this.config = assets.config;
        this.sp = new SentencePiece(decodeBase64(assets.tokenizer));
        this.voiceBlobs = assets.voices;
        this.inputNames = new Set(session.inputNames);
        const lora = this.config.lora;
        const atomic = lora?.atomic_chars ?? lora?.ipa_chars;
        this.phonemeTokenizer =
            lora && atomic ? new MixedTokenizer(this.sp, atomic, lora.vocab_base) : null;
    }
    static async create(model, assets) {
        const session = await ort.InferenceSession.create(model, {
            executionProviders: [...executionProviders],
            graphOptimizationLevel: "all",
        });
        return new PocketTTS(session, assets);
    }
    get sampleRate() {
        return this.config.sample_rate;
    }
    get voices() {
        return Object.keys(this.voiceBlobs).sort();
    }
    /** Voice conditioning as a flat [T * model_dim] array. */
    voiceConditioning(voice) {
        if (voice instanceof Float32Array)
            return voice;
        const blob = this.voiceBlobs[voice];
        if (!blob)
            throw new Error(`unknown voice ${voice}`);
        return float16ToFloat32(decodeBase64(blob));
    }
    /** Load the encoder graph, which is only needed to clone a voice. */
    async loadEncoder(bytes) {
        this.encoder = await ort.InferenceSession.create(bytes, {
            executionProviders: [...executionProviders],
            graphOptimizationLevel: "all",
        });
    }
    get canClone() {
        return this.encoder !== null;
    }
    /**
     * Encode a voice prompt into conditioning usable as `voice`.
     *
     * Cloning is its own call: synthesis never touches the encoder.
     */
    async cloneVoice(samples, maxSeconds = 20) {
        const encoder = this.encoder;
        if (!encoder)
            throw new Error("the voice encoder has not been loaded");
        const limit = Math.floor(maxSeconds * this.config.sample_rate);
        let audio = samples.length > limit ? samples.subarray(0, limit) : samples;
        const remainder = audio.length % this.config.frame_size;
        if (remainder) {
            const padded = new Float32Array(audio.length + this.config.frame_size - remainder);
            padded.set(audio);
            audio = padded;
        }
        const input = new ort.Tensor("float32", audio, [1, 1, audio.length]);
        const output = await encoder.run({ audio: input });
        return output.cond.data;
    }
    /** How `stream` will split this text, and what the first chunk tokenizes to. */
    inspect(text, phonemes) {
        const config = this.config;
        const defaults = phonemes ? (config.lora?.defaults ?? {}) : {};
        const tokenizer = phonemes ? this.phonemeTokenizer : this.sp;
        const maxTokens = defaults.max_tokens_per_chunk ?? config.max_tokens_per_chunk;
        const chunks = phonemes
            ? splitPhonemeChunks(tokenizer, text, maxTokens)
            : splitIntoBestSentences(this.sp, text, maxTokens, config.pad_with_spaces_for_short_inputs, config.remove_semicolons);
        const first = chunks[0] ?? "";
        const prompt = phonemes
            ? preparePhonemePrompt(first)
            : prepareTextPrompt(first, config.pad_with_spaces_for_short_inputs, config.remove_semicolons).prompt;
        return { chunks, tokens: tokenizer.encode(prompt) };
    }
    /** The text a token id stands for, and whether it is one of the adapter's. */
    describeToken(id) {
        const base = this.config.lora?.vocab_base ?? this.sp.vocabSize;
        if (id < base)
            return { piece: this.sp.decode([id]) || "·", atomic: false };
        const chars = this.config.lora?.atomic_chars ?? this.config.lora?.ipa_chars ?? "";
        return { piece: [...chars][id - base] ?? "?", atomic: true };
    }
    /** Yield 80 ms mono frames as they are decoded. */
    async *stream(options) {
        const config = this.config;
        const phonemes = options.phonemes ?? false;
        const defaults = phonemes ? (config.lora?.defaults ?? {}) : {};
        if (phonemes && !this.phonemeTokenizer)
            throw new Error("this model has no phoneme adapter");
        const tokenizer = phonemes ? this.phonemeTokenizer : this.sp;
        const temperature = options.temperature ?? defaults.temperature ?? config.temperature;
        const decodeSteps = Math.min(options.decodeSteps ?? config.sampler_decode_steps, config.max_decode_steps);
        const gate = phonemes ? 1 : 0;
        const maxTokens = defaults.max_tokens_per_chunk ?? config.max_tokens_per_chunk;
        const random = new Random(options.seed ?? (Math.random() * 2 ** 32) >>> 0);
        const { cache: flowKv, length: voiceLength } = await this.prefilledVoice(options.voice, gate);
        const chunks = phonemes
            ? splitPhonemeChunks(tokenizer, options.text, maxTokens)
            : splitIntoBestSentences(this.sp, options.text, maxTokens, config.pad_with_spaces_for_short_inputs, config.remove_semicolons);
        for (const chunk of chunks) {
            options.signal?.throwIfAborted();
            let prompt;
            let guess = 0;
            if (phonemes) {
                prompt = preparePhonemePrompt(chunk);
            }
            else {
                const prepared = prepareTextPrompt(chunk, config.pad_with_spaces_for_short_inputs, config.remove_semicolons);
                prompt = prepared.prompt;
                guess = prepared.framesAfterEosGuess;
            }
            const framesAfterEos = defaults.frames_after_eos ?? config.frames_after_eos ?? guess + 2;
            const tokens = BigInt64Array.from(tokenizer.encode(prompt), BigInt);
            const maxFrames = this.maxFrames(tokens.length);
            flowKv.length = voiceLength;
            flowKv.reserve(tokens.length + maxFrames);
            const mimiKv = this.emptyMimiCache(maxFrames * config.mimi_steps_per_latent);
            let mimiConv = new Float32Array(config.conv_state_size);
            let mimiOffset = 0n;
            let outputs = await this.step({
                tokens,
                gates: TEXT_GATE,
                seq: tokens.length,
                noise: new Float32Array(config.latent_dim),
                flowKv,
                mimiKv,
                mimiOffset,
                mimiConv,
                decodeSteps,
                lora: gate,
            });
            flowKv.append(outputs.flow_kv_new.data);
            const decode = new DecodeFeeds(config, this.inputNames, gate, decodeSteps);
            const deviation = Math.sqrt(temperature);
            let eosFrame = null;
            for (let frame = 0; frame < maxFrames; frame++) {
                options.signal?.throwIfAborted();
                const noise = decode.noise;
                for (let i = 0; i < noise.length; i++)
                    noise[i] = random.normal() * deviation;
                outputs = await decode.run(this.session, flowKv, mimiKv, mimiConv, mimiOffset);
                flowKv.append(outputs.flow_kv_new.data);
                mimiKv.append(outputs.mimi_kv_new.data);
                mimiConv = outputs.mimi_conv_out.data;
                mimiOffset = outputs.mimi_offset_out.data[0];
                decode.advance(outputs.next_latent.data);
                const eosLogit = outputs.eos_logit.data[0];
                if (eosFrame === null && eosLogit > config.eos_threshold)
                    eosFrame = frame;
                if (eosFrame !== null && frame >= eosFrame + framesAfterEos)
                    break;
                yield outputs.audio.data.slice();
            }
        }
    }
    /** Generate the whole utterance and return it as one array. */
    async speak(options) {
        const frames = [];
        for await (const frame of this.stream(options))
            frames.push(frame);
        const total = frames.reduce((sum, frame) => sum + frame.length, 0);
        const out = new Float32Array(total);
        let at = 0;
        for (const frame of frames) {
            out.set(frame, at);
            at += frame.length;
        }
        return out;
    }
    maxFrames(tokenCount) {
        const config = this.config;
        const seconds = tokenCount / config.tokens_per_second_estimate + config.gen_seconds_padding;
        return Math.ceil(seconds * config.frame_rate);
    }
    emptyFlowCache(capacity) {
        const config = this.config;
        return new Cache(config.flow_layers * 2 * config.flow_heads * config.flow_head_dim, capacity);
    }
    /** The graph always reads `mimi_kv_len` entries, so the cache starts padded. */
    emptyMimiCache(capacity = 0) {
        const config = this.config;
        return new Cache(config.mimi_layers * 2 * config.mimi_heads * config.mimi_head_dim, capacity, config.mimi_kv_len);
    }
    cachedPrefill(voice, gate) {
        if (typeof voice === "string")
            return this.namedVoices.get(`${voice}:${gate}`);
        return this.clonedVoices.get(voice)?.get(gate);
    }
    rememberPrefill(voice, gate, prefill) {
        if (typeof voice === "string") {
            this.namedVoices.set(`${voice}:${gate}`, prefill);
            return;
        }
        // Cloned voices are arrays, so they are keyed by identity rather than name.
        let byGate = this.clonedVoices.get(voice);
        if (!byGate) {
            byGate = new Map();
            this.clonedVoices.set(voice, byGate);
        }
        byGate.set(gate, prefill);
    }
    /**
     * Flow-LM cache holding just the voice prompt, computed once per voice.
     *
     * The adapter changes the attention weights, so a prefilled voice belongs to
     * the gate it was computed under, and a cloned voice is cached by identity.
     */
    async prefilledVoice(voice, gate) {
        let prefill = this.cachedPrefill(voice, gate);
        if (!prefill)
            prefill = await this.computePrefill(voice, gate);
        const cache = this.emptyFlowCache(prefill.length + 256);
        cache.append(prefill.values);
        return { cache, length: prefill.length };
    }
    async computePrefill(voice, gate) {
        const config = this.config;
        const cond = this.voiceConditioning(voice);
        const frames = cond.length / config.model_dim;
        const outputs = await this.step({
            cond,
            gates: COND_GATE,
            seq: frames,
            noise: new Float32Array(config.latent_dim),
            flowKv: this.emptyFlowCache(frames + 1),
            mimiKv: this.emptyMimiCache(),
            mimiOffset: 0n,
            mimiConv: new Float32Array(config.conv_state_size),
            decodeSteps: config.sampler_decode_steps,
            lora: gate,
        });
        const prefill = {
            values: outputs.flow_kv_new.data.slice(),
            length: frames,
        };
        this.rememberPrefill(voice, gate, prefill);
        return prefill;
    }
    /** Warm a voice ahead of time; `stream` does it anyway if you skip this. */
    async prepareVoice(voice, phonemes = false) {
        const gate = phonemes ? 1 : 0;
        return (this.cachedPrefill(voice, gate) ?? (await this.computePrefill(voice, gate))).length;
    }
    async step(args) {
        const config = this.config;
        const seq = args.seq;
        const feeds = {
            tokens: new ort.Tensor("int64", args.tokens ?? new BigInt64Array(seq), [1, seq]),
            latent: new ort.Tensor("float32", args.latent ?? new Float32Array(seq * config.latent_dim), [1, seq, config.latent_dim]),
            is_bos: new ort.Tensor("float32", args.isBos ?? new Float32Array(seq), [1, seq, 1]),
            cond: new ort.Tensor("float32", args.cond ?? new Float32Array(seq * config.model_dim), [1, seq, config.model_dim]),
            gates: new ort.Tensor("float32", args.gates, [3]),
            noise: new ort.Tensor("float32", args.noise, [1, config.latent_dim]),
            flow_kv: new ort.Tensor("float32", args.flowKv.window(), [
                args.flowKv.length,
                config.flow_layers,
                2,
                1,
                config.flow_heads,
                config.flow_head_dim,
            ]),
            flow_offset: new ort.Tensor("int64", BigInt64Array.from([BigInt(args.flowKv.length)]), []),
            mimi_kv: new ort.Tensor("float32", args.mimiKv.window(config.mimi_kv_len), [
                config.mimi_kv_len,
                config.mimi_layers,
                2,
                1,
                config.mimi_heads,
                config.mimi_head_dim,
            ]),
            mimi_offset: new ort.Tensor("int64", BigInt64Array.from([args.mimiOffset]), []),
            mimi_conv: new ort.Tensor("float32", args.mimiConv, [config.conv_state_size]),
            decode_steps: new ort.Tensor("float32", Float32Array.from([args.decodeSteps]), []),
            lora: new ort.Tensor("float32", Float32Array.from([args.lora]), []),
        };
        // Older exports lack the adapter and decode-step inputs; feed what exists.
        for (const name of Object.keys(feeds))
            if (!this.inputNames.has(name))
                delete feeds[name];
        return this.session.run(feeds);
    }
}
