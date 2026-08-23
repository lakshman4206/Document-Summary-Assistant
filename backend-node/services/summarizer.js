import {
  splitSentences,
  fixGrammarAndHomophones,
  cleanDocumentText,
  restructureFullDocument,
  extractEntitiesAndMetrics,
  analyzeDocumentReadability
} from "./cleaner.js";

const STOP_WORDS = new Set([
  "about", "above", "after", "again", "against", "also", "although", "among", "because",
  "before", "being", "below", "between", "both", "could", "from", "further", "have",
  "having", "here", "into", "itself", "more", "most", "other", "over", "same", "should",
  "such", "than", "their", "there", "these", "they", "this", "those", "through", "under",
  "using", "very", "were", "which", "while", "would", "your", "ours", "them", "then",
  "once", "where", "when", "what", "with", "that", "will", "shall", "can", "may",
  "might", "must", "does", "did", "doing", "some", "only", "each", "many", "much",
  "been", "was", "are", "and", "the", "for", "not", "but", "you", "our", "out",
  "too", "any", "all", "its", "it", "is", "in", "of", "to", "on", "as", "by", "an", "a", "or", "be"
]);

const IMPORTANT_PATTERNS = [
  /\b(crucial|primary|essential|significant|major|concluded|resulted|demonstrated|revealed|objective|breakthrough|achieved|strategy|finding|developed|growth|priority|outcome|increase|decrease|innovation|policy)\b/i,
  /\b(started|began|decided|planned|realized|discovered|learned)\b/i,
  /\b(caused|led to|therefore|due to|as a result|consequently)\b/i,
  /\b(conclusion|finally|summary|overall|in total|specifically)\b/i
];

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

function getWordFrequency(text) {
  const freq = {};
  tokenize(text).forEach((w) => {
    freq[w] = (freq[w] || 0) + 1;
  });
  return freq;
}

function sentenceSimilarity(sentA, sentB) {
  const textA = typeof sentA === "string" ? sentA : sentA?.text || "";
  const textB = typeof sentB === "string" ? sentB : sentB?.text || "";
  if (!textA || !textB) return 0;
  const wordsA = new Set(tokenize(textA));
  const wordsB = new Set(tokenize(textB));
  if (!wordsA.size || !wordsB.size) return 0;

  let common = 0;
  wordsA.forEach((w) => {
    if (wordsB.has(w)) common++;
  });
  return common / Math.max(wordsA.size, wordsB.size);
}

export function extractKeywords(text, maxTags = 6) {
  const freq = getWordFrequency(text);
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .filter(([word]) => word.length > 3 && !STOP_WORDS.has(word))
    .slice(0, maxTags)
    .map(([word]) => word.charAt(0).toUpperCase() + word.slice(1));
}

export function computeMetrics(originalText, summaryText) {
  const origWords = (originalText || "").trim().split(/\s+/).filter(Boolean).length;
  const summWords = (summaryText || "").trim().split(/\s+/).filter(Boolean).length;

  const reductionPercent = origWords > 0
    ? Math.max(0, Math.round(((origWords - summWords) / origWords) * 100))
    : 0;

  const origReadMins = (origWords / 200).toFixed(1);
  const summReadMins = (summWords / 200).toFixed(1);
  const savedMins = Math.max(0, origReadMins - summReadMins).toFixed(1);

  return {
    originalWords: origWords,
    summaryWords: summWords,
    reductionPercent,
    timeSavedMinutes: savedMins > 0 ? `${savedMins} mins` : "< 1 min"
  };
}

/**
 * High-performance Extractive NLP Summarization & Document Restoration Engine
 */
export function summarizeText(text, length = "medium", tone = "standard") {
  const cleaned = cleanDocumentText(text);
  const restructuredDocument = restructureFullDocument(text);
  const entities = extractEntitiesAndMetrics(cleaned);
  const readability = analyzeDocumentReadability(cleaned);

  if (!cleaned) {
    return {
      summary: "",
      key_points: [],
      keywords: [],
      restructured_document: "",
      entities,
      readability,
      metrics: computeMetrics("", "")
    };
  }

  let sentences = splitSentences(cleaned);
  if (!sentences.length) {
    sentences = cleaned
      .split(/[.!?\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 8 && (s.match(/[A-Za-z]/g) || []).length >= 4);
  }

  if (sentences.length <= 2) {
    const sText = sentences.join(" ") || cleaned;
    return {
      summary: sText,
      key_points: sentences.length > 0 ? sentences : [cleaned],
      keywords: extractKeywords(cleaned, 6),
      restructured_document: restructuredDocument,
      entities,
      readability,
      metrics: computeMetrics(cleaned, sText)
    };
  }

  const freq = getWordFrequency(cleaned);
  const maxFreq = Math.max(...Object.values(freq), 1);

  const scored = sentences.map((sentence, index) => {
    const words = tokenize(sentence);
    let score = 0;

    if (words.length > 0) {
      let wordScore = 0;
      words.forEach((w) => {
        wordScore += (freq[w] || 0) / maxFreq;
      });
      score += (wordScore / words.length) * 2.2;
    }

    if (index === 0) score += 1.5;
    if (index === 1) score += 0.8;
    if (index === sentences.length - 1) score += 1.2;

    if (IMPORTANT_PATTERNS.some((p) => p.test(sentence))) score += 1.3;

    const wc = sentence.split(/\s+/).length;
    if (wc >= 10 && wc <= 35) score += 0.6;
    if (wc > 50) score -= 0.4;
    if (wc < 6) score -= 0.5;

    return { text: sentence, index, score };
  });

  const totalWords = cleaned.split(/\s+/).length;
  let summaryTarget = 3;
  let keyPointTarget = 4;

  if (length === "short") {
    summaryTarget = totalWords < 400 ? 2 : totalWords < 1500 ? 3 : 4;
    keyPointTarget = 3;
  } else if (length === "long") {
    summaryTarget = totalWords < 400 ? 4 : totalWords < 1500 ? 7 : 10;
    keyPointTarget = 6;
  } else {
    summaryTarget = totalWords < 400 ? 3 : totalWords < 1500 ? 5 : 7;
    keyPointTarget = 4;
  }

  summaryTarget = Math.min(summaryTarget, sentences.length);
  const ranked = [...scored].sort((a, b) => b.score - a.score);

  // Maximal Marginal Relevance (MMR) for summary sentences
  const selected = [];
  for (const candidate of ranked) {
    const isDup = selected.some(
      (existing) => sentenceSimilarity(candidate.text, existing) > 0.52
    );
    if (!isDup) selected.push(candidate);
    if (selected.length >= summaryTarget) break;
  }

  selected.sort((a, b) => a.index - b.index);

  let summary = selected.map((item) => item.text).join(" ");
  summary = fixGrammarAndHomophones(summary);

  if (tone === "bullet") {
    summary = selected.map((item) => `• ${item.text}`).join("\n\n");
  }

  const keyPoints = [];
  for (const candidate of ranked) {
    const isDup = keyPoints.some(
      (existing) => sentenceSimilarity(candidate.text, existing) > 0.42
    );
    if (!isDup) keyPoints.push(candidate.text);
    if (keyPoints.length >= keyPointTarget) break;
  }

  const keywords = extractKeywords(cleaned, 6);
  const metrics = computeMetrics(cleaned, summary);

  return {
    summary,
    key_points: keyPoints.map((kp) => fixGrammarAndHomophones(kp)),
    keywords,
    restructured_document: restructuredDocument,
    entities,
    readability,
    metrics
  };
}
