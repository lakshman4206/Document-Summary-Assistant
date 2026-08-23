/**
 * Vercel Serverless Function: Advanced AI & NLP Document Summarization Engine
 */

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

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function getWordFrequency(text) {
  const freq = {};
  tokenize(text).forEach((w) => {
    freq[w] = (freq[w] || 0) + 1;
  });
  return freq;
}

function extractKeywords(text, maxTags = 6) {
  const freq = getWordFrequency(text);
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .filter(([word]) => word.length > 3 && !STOP_WORDS.has(word))
    .slice(0, maxTags)
    .map(([word]) => word.charAt(0).toUpperCase() + word.slice(1));
}

function splitSentences(text) {
  if (!text) return [];
  const raw = text.split(/(?<=[.!?\n])\s+/);
  return raw
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && (s.match(/[A-Za-z]/g) || []).length >= 4);
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

function generateStructuredSummary(text, length = "medium", tone = "standard") {
  const sentences = splitSentences(text);
  if (!sentences.length) {
    const fallback = text.slice(0, 500).trim();
    return {
      summary: fallback,
      key_points: [fallback],
      takeaways: [fallback],
      keywords: extractKeywords(text, 5)
    };
  }

  if (sentences.length <= 2) {
    return {
      summary: sentences.join(" "),
      key_points: sentences,
      takeaways: sentences,
      keywords: extractKeywords(text, 5)
    };
  }

  const freq = getWordFrequency(text);
  const maxFreq = Math.max(...Object.values(freq), 1);

  const importantPatterns = [
    /\b(crucial|primary|essential|significant|major|concluded|resulted|demonstrated|revealed|objective|breakthrough|achieved|strategy|finding|developed|growth|priority|outcome|increase|decrease|innovation|policy)\b/i,
    /\b(started|began|decided|planned|realized|discovered|learned)\b/i,
    /\b(caused|led to|therefore|due to|as a result|consequently)\b/i,
    /\b(conclusion|finally|summary|overall|in total|specifically)\b/i
  ];

  const scored = sentences.map((sent, index) => {
    const words = tokenize(sent);
    let score = 0;
    words.forEach((w) => {
      score += (freq[w] || 0) / maxFreq;
    });
    if (index === 0) score += 1.6;
    if (index === 1) score += 0.8;
    if (index === sentences.length - 1) score += 1.1;
    if (importantPatterns.some((p) => p.test(sent))) score += 1.4;

    const wc = sent.split(/\s+/).length;
    if (wc >= 8 && wc <= 40) score += 0.6;
    if (wc > 60) score -= 0.4;
    return { text: sent, index, score };
  });

  const count = length === "short" ? 2 : length === "long" ? 6 : 4;
  const target = Math.min(count, sentences.length);

  const ranked = [...scored].sort((a, b) => b.score - a.score);

  const selected = [];
  for (const candidate of ranked) {
    const isDup = selected.some((existing) => sentenceSimilarity(candidate.text, existing) > 0.52);
    if (!isDup) selected.push(candidate);
    if (selected.length >= target) break;
  }

  selected.sort((a, b) => a.index - b.index);

  let summary = selected.map((s) => s.text).join(" ");
  if (tone === "bullet") {
    summary = selected.map((s) => `• ${s.text}`).join("\n\n");
  }

  const keyPoints = [];
  for (const candidate of ranked) {
    const isDup = keyPoints.some((existing) => sentenceSimilarity(candidate.text, existing) > 0.42);
    if (!isDup) keyPoints.push(candidate.text);
    if (keyPoints.length >= Math.min(5, sentences.length)) break;
  }

  const takeaways = ranked
    .slice(0, Math.min(3, ranked.length))
    .map((item) => item.text);

  return {
    summary,
    key_points: keyPoints,
    takeaways,
    keywords: extractKeywords(text, 6)
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ detail: "Method not allowed" });
  }

  const { text = "", length = "medium", tone = "standard" } = req.body || {};

  if (!text || !text.trim()) {
    return res.status(400).json({ detail: "No document text was provided." });
  }

  // Try external local or render backend
  const endpoints = [
    "http://localhost:5000/api/summarize",
    "https://document-summary-assistant-ekuy.onrender.com/api/summarize"
  ];

  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), length, tone })
      });

      if (response.ok) {
        const data = await response.json();
        if (data && data.summary) {
          return res.status(200).json(data);
        }
      }
    } catch (error) {
      // continue to fallback
    }
  }

  // Standalone AI & NLP Summarizer
  const result = generateStructuredSummary(text.trim(), length, tone);
  return res.status(200).json(result);
}