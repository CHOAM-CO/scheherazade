/**
 * The unigram SentencePiece model pocket-tts ships, in the browser.
 *
 * The model travels inside the exported asset set, so there is nothing to
 * download separately and nothing to keep in sync. It is a plain unigram model
 * with the identity normalizer and byte fallback, which is the easy case: no
 * character map to apply, just Viterbi over the pieces and UTF-8 bytes for
 * anything the vocabulary has never seen.
 */
const SPACE = "▁";
const UNK_PENALTY = 10.0;
/** Piece types, from sentencepiece_model.proto. */
const NORMAL = 1;
const UNKNOWN = 2;
const USER_DEFINED = 4;
const BYTE = 6;
/** Just enough protobuf to read a ModelProto's pieces and normalizer flags. */
class Reader {
    bytes;
    offset = 0;
    constructor(bytes) {
        this.bytes = bytes;
    }
    get done() {
        return this.offset >= this.bytes.length;
    }
    varint() {
        let result = 0;
        let shift = 0;
        for (;;) {
            const byte = this.bytes[this.offset++];
            result += (byte & 0x7f) * Math.pow(2, shift);
            if ((byte & 0x80) === 0)
                return result;
            shift += 7;
        }
    }
    bytesField() {
        const length = this.varint();
        const slice = this.bytes.subarray(this.offset, this.offset + length);
        this.offset += length;
        return slice;
    }
    float() {
        const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4);
        this.offset += 4;
        return view.getFloat32(0, true);
    }
    fixed64() {
        this.offset += 8;
    }
    skip(wire) {
        if (wire === 0)
            this.varint();
        else if (wire === 1)
            this.fixed64();
        else if (wire === 2)
            this.bytesField();
        else if (wire === 5)
            this.offset += 4;
        else
            throw new Error(`unsupported wire type ${wire}`);
    }
}
function decodeUtf8(bytes) {
    return new TextDecoder().decode(bytes);
}
function parseModel(bytes) {
    const reader = new Reader(bytes);
    const pieces = [];
    let addDummyPrefix = true;
    let removeExtraWhitespaces = false;
    let modelType = 1; // UNIGRAM
    while (!reader.done) {
        const tag = reader.varint();
        const field = tag >>> 3;
        const wire = tag & 7;
        if (field === 1 && wire === 2) {
            pieces.push(parsePiece(reader.bytesField()));
        }
        else if (field === 2 && wire === 2) {
            modelType = parseTrainerType(reader.bytesField());
        }
        else if (field === 3 && wire === 2) {
            const n = parseNormalizer(reader.bytesField());
            addDummyPrefix = n.addDummyPrefix;
            removeExtraWhitespaces = n.removeExtraWhitespaces;
        }
        else {
            reader.skip(wire);
        }
    }
    return { pieces, addDummyPrefix, removeExtraWhitespaces, modelType };
}
function parsePiece(bytes) {
    const reader = new Reader(bytes);
    let piece = "";
    let score = 0;
    let type = NORMAL;
    while (!reader.done) {
        const tag = reader.varint();
        const field = tag >>> 3;
        const wire = tag & 7;
        if (field === 1 && wire === 2)
            piece = decodeUtf8(reader.bytesField());
        else if (field === 2 && wire === 5)
            score = reader.float();
        else if (field === 3 && wire === 0)
            type = reader.varint();
        else
            reader.skip(wire);
    }
    return { piece, score, type };
}
function parseNormalizer(bytes) {
    const reader = new Reader(bytes);
    let addDummyPrefix = true;
    let removeExtraWhitespaces = true; // proto default
    while (!reader.done) {
        const tag = reader.varint();
        const field = tag >>> 3;
        const wire = tag & 7;
        if (field === 3 && wire === 0)
            addDummyPrefix = reader.varint() !== 0;
        else if (field === 4 && wire === 0)
            removeExtraWhitespaces = reader.varint() !== 0;
        else
            reader.skip(wire);
    }
    return { addDummyPrefix, removeExtraWhitespaces };
}
/** TrainerSpec.model_type (field 3): 1 unigram (default), 2 BPE. */
function parseTrainerType(bytes) {
    const reader = new Reader(bytes);
    let type = 1;
    while (!reader.done) {
        const tag = reader.varint();
        const field = tag >>> 3;
        const wire = tag & 7;
        if (field === 3 && wire === 0)
            type = reader.varint();
        else
            reader.skip(wire);
    }
    return type;
}
export class SentencePiece {
    pieces;
    unkId = 0;
    ids = new Map();
    byteIds = new Map();
    maxPieceLength;
    unkScore;
    addDummyPrefix;
    removeExtraWhitespaces;
    bpe;
    constructor(model) {
        const parsed = parseModel(model);
        this.pieces = parsed.pieces;
        this.addDummyPrefix = parsed.addDummyPrefix;
        this.removeExtraWhitespaces = parsed.removeExtraWhitespaces;
        this.bpe = parsed.modelType === 2;
        let minScore = Infinity;
        let longest = 1;
        this.pieces.forEach((piece, id) => {
            if (piece.type === NORMAL || piece.type === USER_DEFINED) {
                // Only these take part in the segmentation; control, unknown and byte
                // pieces are reachable another way or not at all.
                this.ids.set(piece.piece, id);
                longest = Math.max(longest, piece.piece.length);
                minScore = Math.min(minScore, piece.score);
            }
            else if (piece.type === BYTE) {
                this.byteIds.set(parseInt(piece.piece.slice(3, 5), 16), id);
            }
            else if (piece.type === UNKNOWN) {
                this.ids.delete(piece.piece);
            }
        });
        this.maxPieceLength = longest;
        this.unkScore = minScore - UNK_PENALTY;
    }
    get vocabSize() {
        return this.pieces.length;
    }
    pieceToId(piece) {
        return this.ids.get(piece) ?? this.unkId;
    }
    encode(text) {
        if (text === "")
            return [];
        // The dummy prefix goes on unconditionally: this model keeps
        // remove_extra_whitespaces off, so leading spaces are content.
        let source = text;
        if (this.removeExtraWhitespaces) {
            source = source.replace(/ +/g, " ").replace(/^ | $/g, "");
            if (source === "")
                return [];
        }
        let normalized = source.replaceAll(" ", SPACE);
        if (this.addDummyPrefix)
            normalized = SPACE + normalized;
        if (this.bpe)
            return this.encodeBpe(normalized);
        // Viterbi: best[i] is the best score for the first i characters, and
        // back[i] the start of the piece that got there.
        const length = normalized.length;
        const best = new Float64Array(length + 1).fill(-Infinity);
        const back = new Int32Array(length + 1).fill(-1);
        best[0] = 0;
        for (let end = 1; end <= length; end++) {
            const earliest = Math.max(0, end - this.maxPieceLength);
            for (let start = earliest; start < end; start++) {
                if (best[start] === -Infinity)
                    continue;
                const id = this.ids.get(normalized.slice(start, end));
                if (id === undefined)
                    continue;
                const score = best[start] + this.pieces[id].score;
                if (score > best[end]) {
                    best[end] = score;
                    back[end] = start;
                }
            }
            if (best[end] === -Infinity) {
                // Nothing in the vocabulary reaches here; fall back to one unknown
                // character, which byte fallback will spell out later.
                const start = end - charLengthEndingAt(normalized, end);
                if (best[start] !== -Infinity) {
                    best[end] = best[start] + this.unkScore;
                    back[end] = start;
                }
            }
        }
        const spans = [];
        for (let end = length; end > 0;) {
            const start = back[end];
            if (start < 0)
                break;
            spans.push([start, end]);
            end = start;
        }
        spans.reverse();
        const out = [];
        for (const [start, end] of spans) {
            const text = normalized.slice(start, end);
            const id = this.ids.get(text);
            if (id !== undefined) {
                out.push(id);
                continue;
            }
            const bytes = new TextEncoder().encode(text);
            let spelled = true;
            for (const byte of bytes) {
                const byteId = this.byteIds.get(byte);
                if (byteId === undefined) {
                    spelled = false;
                    break;
                }
            }
            if (spelled)
                for (const byte of bytes)
                    out.push(this.byteIds.get(byte));
            else
                out.push(this.unkId);
        }
        return out;
    }
    /** SentencePiece BPE: merge the adjacent pair with the best-scoring piece until none is left. */
    encodeBpe(normalized) {
        const syms = [...normalized];
        for (;;) {
            let bestAt = -1;
            let bestScore = -Infinity;
            for (let i = 0; i + 1 < syms.length; i++) {
                const id = this.ids.get(syms[i] + syms[i + 1]);
                if (id === undefined)
                    continue;
                const score = this.pieces[id].score;
                if (score > bestScore) {
                    bestScore = score;
                    bestAt = i;
                }
            }
            if (bestAt < 0)
                break;
            syms.splice(bestAt, 2, syms[bestAt] + syms[bestAt + 1]);
        }
        const out = [];
        for (const sym of syms) {
            const id = this.ids.get(sym);
            if (id !== undefined) {
                out.push(id);
                continue;
            }
            const bytes = new TextEncoder().encode(sym);
            if (bytes.length > 0 && bytes.every((b) => this.byteIds.has(b))) {
                for (const b of bytes)
                    out.push(this.byteIds.get(b));
            }
            else
                out.push(this.unkId);
        }
        return out;
    }
    decode(ids) {
        const out = [];
        let pending = [];
        const flush = () => {
            if (pending.length) {
                out.push(new TextDecoder().decode(new Uint8Array(pending)));
                pending = [];
            }
        };
        for (const id of ids) {
            const piece = this.pieces[id];
            if (!piece)
                continue;
            if (piece.type === BYTE) {
                pending.push(parseInt(piece.piece.slice(3, 5), 16));
                continue;
            }
            flush();
            if (piece.type === NORMAL || piece.type === USER_DEFINED)
                out.push(piece.piece);
            else if (piece.type === UNKNOWN)
                out.push(" \u2047 "); // sentencepiece's unk surface
        }
        flush();
        return out.join("").replaceAll(SPACE, " ").replace(/^ /, "");
    }
}
/** Length in UTF-16 units of the character ending at `end` (surrogates count as one). */
function charLengthEndingAt(text, end) {
    const code = text.charCodeAt(end - 1);
    const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
    return isLowSurrogate && end >= 2 ? 2 : 1;
}
