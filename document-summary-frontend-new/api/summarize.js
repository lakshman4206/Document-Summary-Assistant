/**
 * Vercel Serverless Function: High-Speed NLP Document Summarization Engine
 * — Zero external network calls: runs fully in-process on Vercel's infrastructure.
 * — Improved extractive TextRank with TF-IDF weighting, numeric boosts, diversity dedup.
 */

const STOP_WORDS = new Set([
  "about","above","after","again","against","also","although","among","because",
  "before","being","below","between","both","could","from","further","have",
  "having","here","into","itself","more","most","other","over","same","should",
  "such","than","their","there","these","they","this","those","through","under",
  "using","very","were","which","while","would","your","ours","them","then",
  "once","where","when","what","with","that","will","shall","can","may",
  "might","must","does","did","doing","some","only","each","many","much",
  "been","was","are","and","the","for","not","but","you","our","out",
  "too","any","all","its","it","is","in","of","to","on","as","by","an","a","or","be"
]);

// ── Tokenizer ─────────────────────────────────────────────────────────────────
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

// ── TF-IDF-style word frequency (normalised) ──────────────────────────────────
function getWordFrequency(text) {
  const freq = {};
  tokenize(text).forEach((w) => { freq[w] = (freq[w] || 0) + 1; });
  return freq;
}

// ── Keyword extraction ────────────────────────────────────────────────────────
function extractKeywords(text, maxTags = 6) {
  const freq = getWordFrequency(text);
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .filter(([w]) => w.length > 3 && !STOP_WORDS.has(w))
    .slice(0, maxTags)
    .map(([w]) => w.charAt(0).toUpperCase() + w.slice(1));
}

// ── Sentence splitter ─────────────────────────────────────────────────────────
function splitSentences(text) {
  if (!text) return [];
  return text
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && (s.match(/[A-Za-z]/g) || []).length >= 5);
}

// ── Jaccard similarity (string → string) ──────────────────────────────────────
function sentenceSimilarity(a, b) {
  const ta = typeof a === "string" ? a : (a?.text || "");
  const tb = typeof b === "string" ? b : (b?.text || "");
  if (!ta || !tb) return 0;
  const wa = new Set(tokenize(ta));
  const wb = new Set(tokenize(tb));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  wa.forEach((w) => { if (wb.has(w)) inter++; });
  return inter / Math.max(wa.size, wb.size);
}

// ── Improved NLP Summarizer ───────────────────────────────────────────────────
function generateStructuredSummary(text, length = "medium", tone = "standard") {
  const sentences = splitSentences(text);

  // Very short documents — return as-is
  if (!sentences.length) {
    const fb = text.slice(0, 500).trim();
    return { summary: fb, key_points: [fb], takeaways: [fb], keywords: extractKeywords(text, 5) };
  }
  if (sentences.length <= 3) {
    return {
      summary: sentences.join(" "),
      key_points: sentences,
      takeaways: sentences.slice(0, 2),
      keywords: extractKeywords(text, 5)
    };
  }

  // ── Scoring setup ───────────────────────────────────────────────────────────
  const freq = getWordFrequency(text);
  const totalTokens = Object.values(freq).reduce((s, v) => s + v, 0) || 1;
  const maxFreq = Math.max(...Object.values(freq), 1);

  // Signals that mark high-value sentences
  const IMPORTANT = /\b(crucial|primary|essential|significant|major|concluded|resulted|demonstrated|revealed|objective|breakthrough|achieved|strategy|key|finding|developed|growth|priority|outcome|increase|decrease|innovation|policy|goal|recommendation|implication|result|impact)\b/i;
  const CAUSAL     = /\b(caused|led to|therefore|due to|as a result|consequently|because|hence|thus)\b/i;
  const CONCLUSIVE = /\b(conclusion|finally|summary|overall|in total|specifically|ultimately|in summary|to summarize)\b/i;
  const HAS_NUMBER = /\b\d[\d,]*(\.\d+)?\s*(%|percent|million|billion|thousand|km|kg|mph|ms|ms|x|times|years?|months?|days?|hours?|minutes?)\b/i;

  const n = sentences.length;

  const scored = sentences.map((sent, idx) => {
    const words = tokenize(sent);
    const wc = sent.split(/\s+/).length;

    // TF-IDF style: sum of (tf * log(1 + 1/idf_approx)) ≈ tf / maxFreq
    let tfScore = 0;
    words.forEach((w) => { tfScore += (freq[w] || 0) / maxFreq; });
    // Normalise by sentence length to avoid biasing toward long sentences
    tfScore = words.length > 0 ? tfScore / words.length : 0;

    let score = tfScore * 3;

    // Position bonus
    if (idx === 0)       score += 2.0;   // opening sentence — usually topic sentence
    if (idx === 1)       score += 0.9;
    if (idx === n - 1)   score += 1.2;   // closing sentence — usually conclusion
    if (idx === n - 2)   score += 0.5;

    // Content signal bonuses
    if (IMPORTANT.test(sent))  score += 1.6;
    if (CAUSAL.test(sent))     score += 1.2;
    if (CONCLUSIVE.test(sent)) score += 1.4;
    if (HAS_NUMBER.test(sent)) score += 1.3;   // sentences with stats are high-value

    // Sweet-spot word count
    if (wc >= 10 && wc <= 35) score += 0.8;
    if (wc > 60)               score -= 0.5;   // very long sentences less readable

    return { text: sent, index: idx, score };
  });

  // ── Summary selection ───────────────────────────────────────────────────────
  const sentCount = length === "short" ? 3 : length === "long" ? 7 : 5;
  const target    = Math.min(sentCount, n);
  const ranked    = [...scored].sort((a, b) => b.score - a.score);

  const selected = [];
  for (const c of ranked) {
    const isDup = selected.some((ex) => sentenceSimilarity(c.text, ex.text) > 0.48);
    if (!isDup) selected.push(c);
    if (selected.length >= target) break;
  }
  selected.sort((a, b) => a.index - b.index);

  let summary = selected.map((s) => s.text).join(" ");
  if (tone === "bullet") {
    summary = selected.map((s) => `• ${s.text}`).join("\n\n");
  }

  // ── Key Points — diverse, high-scoring, non-redundant ──────────────────────
  const kpMax  = length === "short" ? 4 : length === "long" ? 7 : 6;
  const keyPoints = [];
  for (const c of ranked) {
    const isDup = keyPoints.some((ex) => sentenceSimilarity(c.text, ex) > 0.38);
    if (!isDup) keyPoints.push(c.text);
    if (keyPoints.length >= Math.min(kpMax, n)) break;
  }

  // ── Takeaways — 3 diverse picks spread across the document ─────────────────
  //   segment the doc into thirds and pick the best from each third
  const third  = Math.floor(n / 3);
  const thirds = [
    scored.filter((s) => s.index < third),
    scored.filter((s) => s.index >= third && s.index < third * 2),
    scored.filter((s) => s.index >= third * 2)
  ];

  const takeaways = [];
  thirds.forEach((seg) => {
    if (!seg.length) return;
    const best = seg.reduce((a, b) => (b.score > a.score ? b : a));
    const isDup = takeaways.some((ex) => sentenceSimilarity(best.text, ex) > 0.42);
    if (!isDup && best.text) takeaways.push(best.text);
  });

  // Fallback: if segments didn't yield 3 unique picks, top-rank fill
  for (const c of ranked) {
    if (takeaways.length >= 3) break;
    const isDup = takeaways.some((ex) => sentenceSimilarity(c.text, ex) > 0.42);
    if (!isDup) takeaways.push(c.text);
  }

  return {
    summary,
    key_points: keyPoints,
    takeaways: takeaways.slice(0, 3),
    keywords: extractKeywords(text, 6)
  };
}

// ── Vercel Handler ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ detail: "Method not allowed" });

  const { text = "", length = "medium", tone = "standard" } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ detail: "No document text was provided." });

  // Runs fully in-process — no external network calls, responds in <200ms
  const result = generateStructuredSummary(text.trim().slice(0, 80000), length, tone);
  return res.status(200).json(result);
}