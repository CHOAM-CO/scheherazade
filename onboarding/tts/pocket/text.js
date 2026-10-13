/**
 * Text preparation, ported from the Python package.
 *
 * The model is trained on single sentences, so long input is split on sentence
 * boundaries and regrouped into chunks that fit the per-chunk token budget.
 * Phoneme input takes a different path: the English normalisation would corrupt
 * IPA, and a phoneme string that already fits is passed through untouched.
 */
const MARKER = /<IPA_U([0-9A-Fa-f]{4,6})>/g;
const SENTENCE_END = ".!?";
const CLAUSE_END = ",;:";
/**
 * A blank line is a sentence boundary; a single line break is not.
 *
 * Newlines are flattened to spaces before splitting, so a title or a paragraph
 * that ends without punctuation ran straight into the next line. Only a blank
 * line is unambiguous enough to act on: it gets a period when the line before
 * it ends in a letter or digit, and a single break is left alone, since a
 * sentence that merely wraps must not be cut.
 */
const PARAGRAPH = /([^\s"'”’)\]])(["'”’)\]]*)[ \t]*\n[ \t]*\n\s*/gu;
export function breakParagraphs(text) {
    return text.replace(PARAGRAPH, (_, last, closers) => /[\p{L}\p{N}]/u.test(last) ? `${last}${closers}. ` : `${last}${closers} `);
}
export function prepareTextPrompt(text, padShortInputs, removeSemicolons) {
    let prompt = breakParagraphs(text.trim());
    if (prompt === "")
        throw new Error("Text prompt cannot be empty");
    prompt = prompt.replaceAll("\n", " ").replaceAll("\r", " ").replaceAll("  ", " ");
    if (removeSemicolons)
        prompt = prompt.replaceAll(";", ",");
    const guess = prompt.trim().split(/\s+/).length <= 4 ? 3 : 1;
    const first = prompt[0];
    if (first !== first.toUpperCase())
        prompt = first.toUpperCase() + prompt.slice(1);
    if (/[\p{L}\p{N}]/u.test(prompt[prompt.length - 1]))
        prompt += ".";
    if (padShortInputs && prompt.trim().split(/\s+/).length < 5)
        prompt = " ".repeat(8) + prompt;
    return { prompt, framesAfterEosGuess: guess };
}
/** Whitespace tidying only: IPA must not be capitalised or given a period. */
export function preparePhonemePrompt(text) {
    let prompt = breakParagraphs(text.trim()).replaceAll("\n", " ").replaceAll("\r", " ").trim();
    while (prompt.includes("  "))
        prompt = prompt.replaceAll("  ", " ");
    if (prompt === "")
        throw new Error("Text prompt cannot be empty");
    return prompt;
}
/**
 * SentencePiece for text and punctuation, one id per IPA character.
 *
 * Ids run `0..vocabBase-1` for the pretrained pieces, then one per character of
 * the IPA inventory. Everything that is not IPA keeps going through
 * SentencePiece, which is what lets one string mix phonemes with words.
 */
export class MixedTokenizer {
    sp;
    charToId = new Map();
    constructor(sp, ipaChars, vocabBase) {
        this.sp = sp;
        [...ipaChars].forEach((char, index) => this.charToId.set(char, vocabBase + index));
    }
    encode(text) {
        const expanded = text.replace(MARKER, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
        const ids = [];
        let pending = "";
        const flush = () => {
            if (pending === "")
                return;
            let pieces = this.sp.encode(pending);
            if (pieces.length === 0 && pending.trim() === "")
                pieces = [this.sp.pieceToId("▁")];
            ids.push(...pieces);
            pending = "";
        };
        for (const char of expanded) {
            const id = this.charToId.get(char);
            if (id === undefined) {
                pending += char;
            }
            else {
                flush();
                ids.push(id);
            }
        }
        flush();
        return ids;
    }
}
function boundaryIndices(tokens, boundaries, sp, skipDecimalPeriods = false) {
    const set = new Set(boundaries);
    const indices = [0];
    let previousWasBoundary = false;
    tokens.forEach((token, index) => {
        if (set.has(token)) {
            previousWasBoundary = true;
            return;
        }
        if (previousWasBoundary) {
            if (skipDecimalPeriods && sp && isDecimalPeriod(tokens, index, sp)) {
                previousWasBoundary = false;
                return;
            }
            indices.push(index);
        }
        previousWasBoundary = false;
    });
    indices.push(tokens.length);
    return indices;
}
function isDecimalPeriod(tokens, start, sp) {
    const prefix = sp.decode(tokens.slice(0, start));
    const suffix = sp.decode(tokens.slice(start));
    return (prefix.length >= 2 &&
        prefix.endsWith(".") &&
        /[0-9]/.test(prefix[prefix.length - 2]) &&
        suffix.length > 0 &&
        /[0-9]/.test(suffix[0]));
}
function segments(tokens, indices, sp) {
    const out = [];
    for (let i = 0; i < indices.length - 1; i++) {
        const [start, end] = [indices[i], indices[i + 1]];
        out.push([end - start, sp.decode(tokens.slice(start, end))]);
    }
    return out;
}
function regroup(parts, maxTokens) {
    const chunks = [];
    let current = "";
    let count = 0;
    for (const [tokens, text] of parts) {
        if (current === "") {
            current = text;
            count = tokens;
        }
        else if (count + tokens > maxTokens) {
            chunks.push(current.trim());
            current = text;
            count = tokens;
        }
        else {
            current += " " + text;
            count += tokens;
        }
    }
    if (current !== "")
        chunks.push(current.trim());
    return chunks;
}
export function splitIntoBestSentences(sp, text, maxTokens, padShortInputs, removeSemicolons) {
    const { prompt } = prepareTextPrompt(text, padShortInputs, removeSemicolons);
    const tokens = sp.encode(prompt.trim());
    const sentenceEnds = sp.encode(".!...?").slice(1);
    const sentences = segments(tokens, boundaryIndices(tokens, sentenceEnds, sp, true), sp);
    // Sub-split oversized sentences on clause punctuation, otherwise the model
    // tends to skip words.
    const fallback = sp.encode(",;:").slice(1);
    const refined = [];
    for (const [count, sentence] of sentences) {
        if (count <= maxTokens) {
            refined.push([count, sentence]);
            continue;
        }
        const subTokens = sp.encode(sentence.trim());
        const sub = segments(subTokens, boundaryIndices(subTokens, fallback), sp);
        refined.push(...(sub.length > 1 ? sub : [[count, sentence]]));
    }
    return regroup(refined, maxTokens);
}
function splitKeepingDelimiters(text, delimiters) {
    const parts = [];
    let current = "";
    for (const char of text) {
        current += char;
        if (delimiters.includes(char))
            continue;
        if (current.length > 1 && delimiters.includes(current[current.length - 2])) {
            parts.push(current.slice(0, -1).trim());
            current = char;
        }
    }
    if (current.trim())
        parts.push(current.trim());
    return parts.filter(Boolean);
}
/**
 * Leave short phoneme input alone; split longer input on punctuation.
 *
 * A phoneme string that already fits is passed through untouched, which is how
 * the adapter was trained and evaluated.
 */
export function splitPhonemeChunks(tokenizer, text, maxTokens) {
    const prompt = preparePhonemePrompt(text);
    if (tokenizer.encode(prompt).length <= maxTokens)
        return [prompt];
    const parts = [];
    for (const sentence of splitKeepingDelimiters(prompt, SENTENCE_END)) {
        if (tokenizer.encode(sentence).length <= maxTokens)
            parts.push(sentence);
        else
            parts.push(...splitKeepingDelimiters(sentence, CLAUSE_END));
    }
    return regroup(parts.map((part) => [tokenizer.encode(part).length, part]), maxTokens);
}
