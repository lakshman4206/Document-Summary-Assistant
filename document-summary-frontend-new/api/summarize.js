/**
 * Vercel Serverless Function: Standalone NLP Summarization & Document Cleaner
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
    .filter((s) => s.length > 8 && (s.match(/[A-Za-z]/g) || []).length >= 4);
}

function summarizeText(text, length = "medium", tone = "standard") {
  const sentences = splitSentences(text);
  if (!sentences.length) {
    const fallback = text.slice(0, 500).trim();
    return {
      summary: fallback,
      key_points: [fallback],
      keywords: extractKeywords(text, 5),
      restructured_document: text
    };
  }

  if (sentences.length <= 2) {
    return {
      summary: sentences.join(" "),
      key_points: sentences,
      keywords: extractKeywords(text, 5),
      restructured_document: text
    };
  }

  const freq = getWordFrequency(text);
  const maxFreq = Math.max(...Object.values(freq), 1);

  const scored = sentences.map((sent, index) => {
    const words = tokenize(sent);
    let score = 0;
    words.forEach((w) => {
      score += (freq[w] || 0) / maxFreq;
    });
    if (index === 0) score += 1.5;
    if (index === sentences.length - 1) score += 1.0;
    return { text: sent, index, score };
  });

  const count = length === "short" ? 2 : length === "long" ? 6 : 4;
  const target = Math.min(count, sentences.length);

  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const selected = ranked.slice(0, target).sort((a, b) => a.index - b.index);

  let summary = selected.map((s) => s.text).join(" ");
  if (tone === "bullet") {
    summary = selected.map((s) => `• ${s.text}`).join("\n\n");
  }

  return {
    summary,
    key_points: selected.map((s) => s.text),
    keywords: extractKeywords(text, 6),
    restructured_document: text
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

  // Try external microservice first
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
      // try next or fallback
    }
  }

  // Guaranteed fallback: execute internal NLP engine
  const result = summarizeText(text.trim(), length, tone);
  return res.status(200).json(result);
}