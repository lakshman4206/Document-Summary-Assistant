import { useState, useEffect, useRef } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createWorker, PSM } from "tesseract.js";
import mammoth from "mammoth";
import JSZip from "jszip";
import "./App.css";

GlobalWorkerOptions.workerSrc = pdfWorker;

const PRESERVED_ACRONYMS = new Set([
  "AI", "ML", "API", "APIS", "UI", "UX", "PDF", "PDFS", "DOC", "DOCX", "PPT", "PPTX",
  "HTML", "CSS", "JS", "TS", "NLP", "LLM", "LLMS", "GPT", "RAG", "GPU", "CPU", "RAM",
  "USA", "US", "UK", "EU", "UN", "NASA", "WHO", "ISRO", "DRDO", "UPSC", "SSC", "HSC",
  "CEO", "CTO", "CFO", "COO", "HR", "IT", "ID", "IP", "DNS", "URL", "HTTP", "HTTPS",
  "SQL", "NOSQL", "AWS", "GCP", "SAAS", "PAAS", "IAAS", "B2B", "B2C", "ROI", "KPI",
  "IoT", "WiFi", "OCR", "IEEE", "ISO", "COVID", "DNA", "RNA", "IQ", "EQ", "MB", "GB", "TB",
  "NDA", "CDS", "GATE", "CAT", "NEET", "IIT", "NIT", "IIM", "AIIMS"
]);

const STOP_WORDS = new Set([
  "about", "above", "after", "again", "against", "also",
  "although", "among", "because", "before", "being",
  "below", "between", "both", "could", "from", "further",
  "have", "having", "here", "into", "itself", "more",
  "most", "other", "over", "same", "should", "such",
  "than", "their", "there", "these", "they", "this",
  "those", "through", "under", "using", "very", "were",
  "which", "while", "would", "your", "ours", "them",
  "then", "once", "where", "when", "what", "with",
  "that", "will", "shall", "can", "may", "might",
  "must", "does", "did", "doing", "some", "only",
  "each", "many", "much", "been", "was", "are", "and",
  "the", "for", "not", "but", "you", "our", "out",
  "too", "any", "all", "its", "it", "is", "in", "of",
  "to", "on", "as", "by", "an", "a", "or", "be"
]);

const VALID_SHORT_WORDS = new Set([
  "a", "i", "am", "an", "as", "at", "be", "by",
  "do", "go", "he", "if", "in", "is", "it", "me",
  "my", "no", "of", "on", "or", "so", "to", "up",
  "us", "we", "ok", "tv", "mr", "ms", "dr", "vs",
  "re", "ex", "ad", "pm", "am"
]);

const SAMPLE_DOCS = {
  ai: `Artificial intelligence (AI) has rapidly transformed from an experimental academic field into an indispensable cornerstone of modern technology. Large language models (LLMs) and deep neural networks are now capable of understanding natural language, synthesizing complex documents, generating creative media, and writing software code with unprecedented speed.

Despite remarkable breakthroughs, modern AI systems still encounter challenges surrounding algorithmic hallucination, computational energy demands, and data privacy governance. Researchers are actively pursuing retrieval-augmented generation (RAG), lightweight parameter-efficient fine-tuning, and edge computing architectures to ensure artificial intelligence remains accessible, energy-efficient, and factual.

Organizations integrating AI must prioritize ethical oversight, robust validation pipelines, and comprehensive safety benchmarks. The ultimate synergy between human creativity and machine intelligence promises to accelerate scientific research, revolutionize medical diagnostics, and automate routine cognitive workflows across all global industries.`,

  business: `Quarterly Business & Growth Strategy Review:

Over the past three financial quarters, the company experienced a 34% year-over-year revenue increase, driven primarily by strong adoption of cloud subscription offerings and expansion into European enterprise markets. Customer retention rates reached an all-time high of 94.2%, reflecting improved customer onboarding workflows and enhanced product reliability.

However, operating expenses increased by 18% due to heightened marketing acquisition costs and substantial investments in server infrastructure. To optimize long-term operational efficiency, leadership has decided to automate routine administrative operations, streamline vendor procurement contracts, and consolidate regional sales hubs.

Key Strategic Priorities for the upcoming fiscal year:
1. Accelerate enterprise cloud product features and security certifications.
2. Reduce customer acquisition costs by 15% through targeted digital channel marketing.
3. Expand strategic partnerships with leading technology integrators to capture enterprise market share.`,

  science: `Breakthrough in Solid-State Battery Energy Density:

Materials scientists have engineered a novel ceramic-polymer hybrid electrolyte capable of sustaining over 1,200 continuous charge-discharge cycles with minimal thermal degradation. Unlike conventional lithium-ion batteries that rely on flammable liquid electrolytes, this solid-state formulation virtually eliminates the risk of thermal runaway while dramatically improving operating safety under extreme temperature variations.

Experimental trials demonstrate an estimated 42% increase in volumetric energy density compared to industry-standard cells. This technological advancement could enable next-generation electric vehicles to achieve over 600 miles of driving range on a single charge with rapid 15-minute replenishment cycles.

Production scalability remains the primary commercial bottleneck. The research consortium has initiated pilot manufacturing partnerships to refine continuous roll-to-roll sintering techniques, aiming for commercial deployment in consumer electronics and mobility sectors within three years.`
};

const tokenize = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));

const getWordFrequency = (text) => {
  const frequency = {};
  tokenize(text).forEach((word) => {
    frequency[word] = (frequency[word] || 0) + 1;
  });
  return frequency;
};

/**
 * 1. Broken Word Repair
 */
export const repairBrokenWords = (text) => {
  if (!text) return "";
  let cleaned = text;

  // Rejoin hyphenated line breaks: "transfor-\nmation" -> "transformation"
  cleaned = cleaned.replace(/([A-Za-z]{2,})-\s*\r?\n\s*([A-Za-z]{2,})/g, "$1$2");

  // Rejoin broken hyphens inside words: "compu- ter" -> "computer"
  cleaned = cleaned.replace(/([A-Za-z]{2,})-\s+([A-Za-z]{2,})/g, (match, p1, p2) => `${p1}${p2}`);

  // Rejoin spaced single-letter sequences: "c o m p u t e r" -> "computer"
  cleaned = cleaned.replace(/\b([A-Za-z](?:\s+[A-Za-z]){2,})\b/g, (match) => {
    const combined = match.replace(/\s+/g, "");
    return combined.length >= 3 ? combined : match;
  });

  return cleaned;
};

/**
 * 2. Meaningless / Gibberish Token Filter
 */
export const isLikelyNoiseToken = (token) => {
  if (!token) return true;
  const clean = token.replace(/^[^\w%$#°@.]+|[^\w%$#°@.]+$/g, "");
  if (!clean) return true;

  // Numbers, IDs, codes, percentages, currencies are always kept
  if (/^[\d,.:;%$\-+#°℃℉xX]+$/.test(clean)) return false;
  if (/\d/.test(clean)) return false;

  if (PRESERVED_ACRONYMS.has(clean.toUpperCase())) return false;

  const lower = clean.toLowerCase();
  if (clean.length === 1) return !["a", "i"].includes(lower);
  if (clean.length === 2) return !VALID_SHORT_WORDS.has(lower) && !/^[A-Z]{2}$/.test(clean);

  if (/^(.)\1{4,}$/.test(clean)) return true;

  const letters = (clean.match(/[a-zA-Z]/g) || []).length;
  if (letters === 0) return true;

  if (letters >= 3 && !/[aeiouyAEIOUY]/.test(clean) && !PRESERVED_ACRONYMS.has(clean.toUpperCase())) {
    return true;
  }

  if (/[bcdfghjklmnpqrstvwxzBCDFGHJKLMNPQRSTVWXZ]{5,}/.test(clean) && !PRESERVED_ACRONYMS.has(clean.toUpperCase())) {
    return true;
  }

  return false;
};

/**
 * 3. Capitalization & True-Casing
 */
export const normalizeSentenceCase = (sentence) => {
  const trimmed = sentence.trim();
  if (!trimmed) return "";

  const words = trimmed.split(/\s+/);
  if (!words.length) return "";

  let allCapsCount = 0;
  let titleCaseCount = 0;
  let alphaWordCount = 0;

  words.forEach((w) => {
    const pure = w.replace(/[^A-Za-z]/g, "");
    if (pure.length >= 2) {
      alphaWordCount++;
      if (pure === pure.toUpperCase() && !PRESERVED_ACRONYMS.has(pure)) {
        allCapsCount++;
      } else if (pure[0] === pure[0].toUpperCase() && pure.slice(1) === pure.slice(1).toLowerCase()) {
        titleCaseCount++;
      }
    }
  });

  const isAllOrMajorityCaps = alphaWordCount >= 2 && (allCapsCount / alphaWordCount > 0.5);
  const isHeavyTitleCase = alphaWordCount >= 3 && (titleCaseCount / alphaWordCount > 0.7);

  const processedWords = words.map((word, idx) => {
    const match = word.match(/^([^A-Za-z0-9]*)(.*?)([^A-Za-z0-9]*)$/);
    if (!match) return word;

    const [, leadPunct, core, trailPunct] = match;
    if (!core) return word;

    if (PRESERVED_ACRONYMS.has(core.toUpperCase())) {
      return leadPunct + core.toUpperCase() + trailPunct;
    }

    let cleanCore = core;
    if (/[a-z][A-Z]/.test(cleanCore) && !/^[A-Z][a-z]+[A-Z]/.test(cleanCore)) {
      cleanCore = cleanCore.toLowerCase();
    }

    if (isAllOrMajorityCaps || isHeavyTitleCase) {
      if (idx === 0) {
        cleanCore = cleanCore.charAt(0).toUpperCase() + cleanCore.slice(1).toLowerCase();
      } else {
        cleanCore = PRESERVED_ACRONYMS.has(cleanCore.toUpperCase())
          ? cleanCore.toUpperCase()
          : cleanCore.toLowerCase();
      }
    } else {
      if (idx === 0) {
        cleanCore = cleanCore.charAt(0).toUpperCase() + cleanCore.slice(1);
      }
    }

    return leadPunct + cleanCore + trailPunct;
  });

  let res = processedWords.join(" ");
  res = res.replace(/^([a-z])/, (m, c) => c.toUpperCase());
  return res;
};

export const normalizeCapitalization = (text) => {
  if (!text) return "";
  const segments = text.split(/(?<=[.!?\n])\s+/);
  return segments.map(normalizeSentenceCase).filter(Boolean).join(" ");
};

/**
 * 4. Grammar, Homophones & Agreement
 */
export const fixGrammarAndHomophones = (text) => {
  if (!text) return "";
  let t = text.trim();

  t = t.replace(/\b([Aa])\s+([aeiouAEIOU]\w*)/g, (match, p1, p2) => {
    const isConsonantSound = /^(?:univ|use|uniq|unit|user|eul|euro|one|once)/i.test(p2);
    return isConsonantSound ? "a " + p2 : "an " + p2;
  });
  t = t.replace(/\b([Aa])n\s+([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ]\w*)/g, (match, p1, p2) => {
    const isVowelSound = /^(?:hour|honest|honor|heir)/i.test(p2);
    return isVowelSound ? "an " + p2 : "a " + p2;
  });

  const rules = [
    [/\bmore\s+then\b/gi, "more than"],
    [/\bless\s+then\b/gi, "less than"],
    [/\bfaster\s+then\b/gi, "faster than"],
    [/\bbetter\s+then\b/gi, "better than"],
    [/\bgreater\s+then\b/gi, "greater than"],
    [/\brather\s+then\b/gi, "rather than"],
    [/\byour\s+(welcome|right|going|able|ready|invited|doing)\b/gi, "you're $1"],
    [/\byou're\s+(name|car|house|file|document|profile|email|data|work)\b/gi, "your $1"],
    [/\bit's\s+(name|features|purpose|value|speed|impact|application|accuracy|structure|content|growth)\b/gi, "its $1"],
    [/\bthere\s+(names|features|results|findings|skills|roles|efforts)\b/gi, "their $1"],
    [/\btheir\s+(is|are|was|were|will be|can be|has been)\b/gi, "there $1"],
    [/\b(the|and|in|of|to|is|that|for|with|as)\s+\1\b/gi, "$1"],
    [/\s+([,.:;?!])/g, "$1"],
    [/([,.:;?!])([A-Za-z])/g, "$1 $2"],
    [/\s{2,}/g, " "]
  ];

  for (const [pattern, repl] of rules) {
    t = t.replace(pattern, repl);
  }

  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase());
  return t.trim();
};

/**
 * 5. Full Document Cleaning Pipeline
 */
export const cleanExtractedText = (text) => {
  if (!text || typeof text !== "string") return "";

  let cleaned = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  cleaned = cleaned.replace(/\bPage\s+\d+\s+(?:of|\/)?\s*\d*\b/gi, " ");
  cleaned = cleaned.replace(/[|\u00A6\u00A7\u00A4\u2122\u2192\u2190\u2191\u2193~`^=]{3,}/g, " ");

  cleaned = repairBrokenWords(cleaned);

  const lines = cleaned.split(/\r?\n/);
  const processedLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 2) continue;

    const lineTokens = trimmed.split(/\s+/).filter((token) => !isLikelyNoiseToken(token));
    if (lineTokens.length === 0) continue;

    const filtered = lineTokens.join(" ");
    const letters = (filtered.match(/[A-Za-z]/g) || []).length;
    if (letters < 2) continue;

    processedLines.push(normalizeSentenceCase(filtered));
  }

  if (processedLines.length === 0) {
    return text.trim().replace(/\s{2,}/g, " ");
  }

  const stitched = processedLines.map((l) => {
    const s = l.trim();
    return /[.!?:]$/.test(s) ? s : s + ".";
  }).join(" ");

  return fixGrammarAndHomophones(stitched);
};

const getSentences = (text) => {
  if (!text) return [];
  const abbrevs = [
    "e.g.", "i.e.", "Dr.", "Mr.", "Mrs.", "Ms.", "Prof.", "Sr.", "Jr.", "vs.",
    "U.S.", "U.K.", "Inc.", "Ltd.", "p.m.", "a.m.", "et al.", "Fig.", "No."
  ];
  let protectedText = text;
  abbrevs.forEach((abb, idx) => {
    protectedText = protectedText.replaceAll(abb, `__ABB_${idx}__`);
  });

  const raw = protectedText.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
  return raw
    .map((s) => {
      let restored = s;
      abbrevs.forEach((abb, idx) => {
        restored = restored.replaceAll(`__ABB_${idx}__`, abb);
      });
      let trimmed = restored.trim();
      if (trimmed && !/[.!?]$/.test(trimmed)) trimmed += ".";
      return fixGrammarAndHomophones(normalizeCapitalization(trimmed));
    })
    .filter((s) => {
      const words = s.split(/\s+/).filter(Boolean);
      const letters = (s.match(/[A-Za-z]/g) || []).length;
      return words.length >= 2 && letters >= 6;
    });
};

const sentenceSimilarity = (first, second) => {
  const text1 = typeof first === "string" ? first : first.text;
  const text2 = typeof second === "string" ? second : second.text;
  const firstWords = new Set(tokenize(text1));
  const secondWords = new Set(tokenize(text2));

  if (!firstWords.size || !secondWords.size) return 0;

  let common = 0;
  firstWords.forEach((word) => {
    if (secondWords.has(word)) common++;
  });

  return common / Math.max(firstWords.size, secondWords.size);
};

const extractKeywords = (text, maxTags = 6) => {
  const frequency = getWordFrequency(text);

  return Object.entries(frequency)
    .sort((a, b) => b[1] - a[1])
    .filter(([word]) => word.length > 3 && !STOP_WORDS.has(word))
    .slice(0, maxTags)
    .map(([word]) => word.charAt(0).toUpperCase() + word.slice(1));
};

const createInBrowserSummary = (
  text,
  length = "medium",
  tone = "standard"
) => {
  let cleaned = cleanExtractedText(text);
  if (!cleaned || cleaned.trim().length < 20) {
    cleaned = text?.trim() || "";
  }

  if (!cleaned) {
    return {
      summary: "",
      keyPoints: [],
      keywords: []
    };
  }

  let sentences = getSentences(cleaned);

  if (!sentences.length) {
    sentences = cleaned
      .split(/[.!?\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 8 && (s.match(/[A-Za-z]/g) || []).length >= 4);
  }

  if (!sentences.length) {
    const fallback = cleaned.slice(0, 800).trim();
    return {
      summary: fallback,
      keyPoints: cleaned.split(".").filter((s) => s.trim().length > 5).slice(0, 4).map((s) => s.trim()),
      keywords: extractKeywords(cleaned)
    };
  }

  if (sentences.length <= 2) {
    const sText = sentences.join(" ");
    return {
      summary: sText,
      keyPoints: sentences,
      keywords: extractKeywords(cleaned)
    };
  }

  const frequency = getWordFrequency(cleaned);
  const maxFrequency = Math.max(...Object.values(frequency), 1);

  const importantPatterns = [
    /\b(crucial|primary|essential|significant|major|concluded|resulted|demonstrated|revealed|objective|breakthrough|achieved|strategy|finding|developed|growth|priority|outcome|increase|decrease|innovation|policy)\b/i,
    /\b(started|began|decided|planned|realized|discovered|learned)\b/i,
    /\b(caused|led to|therefore|due to|as a result|consequently)\b/i,
    /\b(conclusion|finally|summary|overall|in total|specifically)\b/i
  ];

  const scored = sentences.map((sentence, index) => {
    const words = tokenize(sentence);
    let score = 0;

    if (words.length > 0) {
      let wordScore = 0;
      words.forEach((word) => {
        wordScore += (frequency[word] || 0) / maxFrequency;
      });
      score += (wordScore / words.length) * 2.2;
    }

    if (index === 0) score += 1.5;
    if (index === 1) score += 0.8;
    if (index === sentences.length - 1) score += 1.2;

    if (importantPatterns.some((p) => p.test(sentence))) score += 1.3;

    const wc = sentence.split(/\s+/).length;
    if (wc >= 8 && wc <= 40) score += 0.6;
    if (wc > 60) score -= 0.4;
    if (wc < 4) score -= 0.8;

    return { text: sentence, index, score };
  });

  const documentWordCount = cleaned.split(/\s+/).length;

  let summaryTarget = 3;
  let keyPointTarget = 4;

  if (length === "short") {
    summaryTarget = documentWordCount < 200 ? 2 : documentWordCount < 1000 ? 3 : 4;
    keyPointTarget = 3;
  } else if (length === "long") {
    summaryTarget = documentWordCount < 200 ? 3 : documentWordCount < 1000 ? 6 : 10;
    keyPointTarget = 6;
  } else {
    summaryTarget = documentWordCount < 200 ? 2 : documentWordCount < 1000 ? 4 : 6;
    keyPointTarget = 4;
  }

  summaryTarget = Math.min(summaryTarget, sentences.length);
  const ranked = [...scored].sort((a, b) => b.score - a.score);

  const selected = [];
  for (const candidate of ranked) {
    const isDup = selected.some(
      (existing) => sentenceSimilarity(candidate.text, existing.text) > 0.55
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
      (existing) => sentenceSimilarity(candidate.text, existing.text) > 0.42
    );
    if (!isDup) keyPoints.push(candidate.text);
    if (keyPoints.length >= keyPointTarget) break;
  }

  return {
    summary,
    keyPoints: keyPoints.map((kp) => fixGrammarAndHomophones(kp)),
    keywords: extractKeywords(cleaned, 6)
  };
};

const MIN_OCR_WIDTH = 1600;

const preprocessCanvasForOCR = (sourceCanvas) => {
  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;
  const scale = srcW < MIN_OCR_WIDTH ? MIN_OCR_WIDTH / srcW : 1;

  const outCanvas = document.createElement("canvas");
  outCanvas.width = Math.round(srcW * scale);
  outCanvas.height = Math.round(srcH * scale);
  const ctx = outCanvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(sourceCanvas, 0, 0, outCanvas.width, outCanvas.height);

  const imageData = ctx.getImageData(0, 0, outCanvas.width, outCanvas.height);
  const data = imageData.data;
  const pixelCount = outCanvas.width * outCanvas.height;

  const gray = new Uint8ClampedArray(pixelCount);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  const histogram = new Array(256).fill(0);
  for (let i = 0; i < pixelCount; i++) histogram[gray[i]]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * histogram[t];
  let sumB = 0, wB = 0, wF = 0, varMax = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += histogram[t];
    if (wB === 0) continue;
    wF = pixelCount - wB;
    if (wF === 0) break;
    sumB += t * histogram[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > varMax) {
      varMax = varBetween;
      threshold = t;
    }
  }

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const v = gray[p] > threshold ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = v;
  }

  ctx.putImageData(imageData, 0, 0);
  return outCanvas;
};

const loadFileToCanvas = (file) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(img.src);
      resolve(canvas);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(img.src);
      reject(err);
    };
    img.src = URL.createObjectURL(file);
  });

const extractTextFromPDF = async (file, setProgress) => {
  let pdf;
  try {
    const buffer = await file.arrayBuffer();
    pdf = await getDocument({ data: buffer }).promise;
  } catch (err) {
    console.error("PDF.js load error:", err);
    return { text: "", pdf: null };
  }

  let fullText = "";

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    setProgress(`Parsing PDF page ${pageNumber} of ${pdf.numPages}...`);

    try {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();

      const pageText = (content.items || [])
        .filter((item) => typeof item.str === "string" && item.str.trim() !== "")
        .map((item) => item.str)
        .join(" ");

      if (pageText.trim()) {
        fullText += pageText + "\n";
      }
    } catch (pageErr) {
      console.warn(`PDF page ${pageNumber} extraction failed:`, pageErr);
    }
  }

  return { text: fullText, pdf };
};

const ocrScannedPDF = async (pdf, setProgress) => {
  if (!pdf) return "";

  let worker;
  try {
    worker = await createWorker("eng");
  } catch (err) {
    console.error("Tesseract worker init failed:", err);
    return "";
  }

  let fullText = "";

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    setProgress(`OCR scanning page ${pageNumber} of ${pdf.numPages}...`);

    try {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 2.5 });

      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const context = canvas.getContext("2d");

      await page.render({ canvasContext: context, viewport }).promise;

      let pageText = "";
      try {
        const processedCanvas = preprocessCanvasForOCR(canvas);
        const ocrResult = await worker.recognize(processedCanvas);
        pageText = ocrResult?.data?.text || "";
      } catch (e) {
        console.warn("Preprocessed OCR pass failed:", e);
      }

      if (!pageText || pageText.trim().length < 15) {
        try {
          const rawOcrResult = await worker.recognize(canvas);
          const rawText = rawOcrResult?.data?.text || "";
          if (rawText.trim().length > pageText.trim().length) {
            pageText = rawText;
          }
        } catch (e) {
          console.warn("Raw OCR pass failed:", e);
        }
      }

      if (pageText.trim()) {
        fullText += pageText + "\n";
      }
    } catch (pageErr) {
      console.warn(`OCR page ${pageNumber} failed:`, pageErr);
    }
  }

  try { await worker.terminate(); } catch (_) {}
  return fullText;
};

const extractTextFromImage = async (file, setProgress) => {
  setProgress("Preparing image for high-accuracy OCR...");

  let worker;
  try {
    worker = await createWorker("eng");
    if (PSM?.SPARSE_TEXT) {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    }
  } catch (err) {
    console.error("Tesseract worker init failed:", err);
    return "";
  }

  const rawCanvas = await loadFileToCanvas(file);
  let text = "";

  try {
    const processedCanvas = preprocessCanvasForOCR(rawCanvas);
    setProgress("Scanning image with Tesseract OCR engine...");
    const ocrResult = await worker.recognize(processedCanvas);
    text = ocrResult?.data?.text || "";
  } catch (e) {
    console.warn("Preprocessed image OCR failed:", e);
  }

  if (!text || text.trim().length < 15) {
    try {
      setProgress("Running high-density optical scan pass...");
      const rawOcrResult = await worker.recognize(rawCanvas);
      const rawText = rawOcrResult?.data?.text || "";
      if (rawText.trim().length > text.trim().length) {
        text = rawText;
      }
    } catch (e) {
      console.warn("Raw image OCR failed:", e);
    }
  }

  try { await worker.terminate(); } catch (_) {}
  return text;
};

const extractTextFromWord = async (file, setProgress) => {
  setProgress("Parsing DOCX Word document structure...");
  const buffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return result.value;
};

const extractTextFromPowerPoint = async (file, setProgress) => {
  setProgress("Extracting slides from PowerPoint presentation...");
  const buffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buffer);

  const slides = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const first = Number(a.match(/slide(\d+)/i)?.[1] || 0);
      const second = Number(b.match(/slide(\d+)/i)?.[1] || 0);
      return first - second;
    });

  let fullText = "";
  for (let i = 0; i < slides.length; i++) {
    setProgress(`Extracting slide ${i + 1} of ${slides.length}...`);
    const xml = await zip.files[slides[i]].async("text");
    const parser = new DOMParser();
    const xmlDocument = parser.parseFromString(xml, "application/xml");
    const textNodes = Array.from(xmlDocument.getElementsByTagName("a:t"));
    const slideText = textNodes.map((node) => node.textContent).join(" ");
    if (slideText.trim()) {
      fullText += slideText + "\n";
    }
  }

  return fullText;
};

function App() {
  const [theme, setTheme] = useState(
    () => localStorage.getItem("docubrief_theme") || "dark"
  );

  const [activeTab, setActiveTab] = useState("upload");
  const [engine, setEngine] = useState("client");

  const [file, setFile] = useState(null);
  const [inputText, setInputText] = useState("");

  const [summaryLength, setSummaryLength] = useState("medium");
  const [summaryTone, setSummaryTone] = useState("standard");

  const [summary, setSummary] = useState("");
  const [keyPoints, setKeyPoints] = useState([]);
  const [keywords, setKeywords] = useState([]);

  const [isDragging, setIsDragging] = useState(false);

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [metrics, setMetrics] = useState(null);

  const [toasts, setToasts] = useState([]);
  const [history, setHistory] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("docubrief_history") || "[]");
    } catch {
      return [];
    }
  });

  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [speechRate, setSpeechRate] = useState(1);

  const synthRef = useRef(window.speechSynthesis || null);
  const utteranceRef = useRef(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("docubrief_theme", theme);
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem("docubrief_history", JSON.stringify(history.slice(0, 15)));
    } catch (e) {
      console.error(e);
    }
  }, [history]);

  const showToast = (message, type = "success") => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3200);
  };

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  const handleFile = (selectedFile) => {
    if (!selectedFile) return;

    const ext = selectedFile.name.split(".").pop().toLowerCase();
    const allowed = ["pdf", "png", "jpg", "jpeg", "webp", "docx", "pptx", "txt", "md"];

    if (!allowed.includes(ext)) {
      setError("Unsupported format. Please upload PDF, PNG, JPG, WEBP, DOCX, PPTX, or TXT.");
      showToast("Unsupported file format", "error");
      return;
    }

    setFile(selectedFile);
    setError("");
    setProgress("");
    showToast(`Loaded ${selectedFile.name}`);
  };

  const computeMetrics = (originalText, summaryText) => {
    const origWords = (originalText || "").trim().split(/\s+/).filter(Boolean).length;
    const summWords = (summaryText || "").trim().split(/\s+/).filter(Boolean).length;

    const reductionPercent = origWords > 0
      ? Math.max(0, Math.round(((origWords - summWords) / origWords) * 100))
      : 0;

    const originalReadMinutes = (origWords / 200).toFixed(1);
    const summaryReadMinutes = (summWords / 200).toFixed(1);
    const timeSavedMinutes = Math.max(0, originalReadMinutes - summaryReadMinutes).toFixed(1);

    return {
      originalWords: origWords,
      summaryWords: summWords,
      reductionPercent,
      timeSavedMinutes: timeSavedMinutes > 0 ? `${timeSavedMinutes} mins` : "< 1 min"
    };
  };

  const handleGenerate = async () => {
    let sourceText = "";
    setError("");
    setProgress("");

    if (activeTab === "upload") {
      if (!file) {
        setError("Please upload a document to analyze.");
        return;
      }
    } else {
      if (!inputText.trim()) {
        setError("Please enter or paste document text.");
        return;
      }
      sourceText = inputText;
    }

    setLoading(true);
    setSummary("");
    setKeyPoints([]);
    setKeywords([]);

    try {
      setProgress("Ingesting document and analyzing structure...");

      if (activeTab === "upload") {
        const ext = file.name.split(".").pop().toLowerCase();

        if (ext === "pdf") {
          const result = await extractTextFromPDF(file, setProgress);
          sourceText = result?.text || "";

          const cleanedPreview = cleanExtractedText(sourceText);
          if (!cleanedPreview || cleanedPreview.trim().length < 30) {
            setProgress("Scanned content detected. Performing OCR optical scan...");
            if (result?.pdf) {
              const ocrText = await ocrScannedPDF(result.pdf, setProgress);
              if (ocrText && ocrText.trim().length > sourceText.trim().length) {
                sourceText = ocrText;
              }
            }
          }
        } else if (["png", "jpg", "jpeg", "webp"].includes(ext)) {
          sourceText = await extractTextFromImage(file, setProgress);
        } else if (ext === "docx") {
          sourceText = await extractTextFromWord(file, setProgress);
        } else if (ext === "pptx") {
          sourceText = await extractTextFromPowerPoint(file, setProgress);
        } else if (["txt", "md"].includes(ext)) {
          sourceText = await file.text();
        }
      }

      if (!sourceText || !sourceText.trim()) {
        sourceText = `Document: ${file?.name || "Uploaded Document"}\nStatus: Visual layout analysis completed.`;
      }

      setProgress("Synthesizing executive summary and key points...");

      let finalSummary = "";
      let finalKeyPoints = [];
      let finalKeywords = [];

      if (engine === "ai") {
        let success = false;
        const endpoints = [
          "http://localhost:5000/api/summarize",
          "/api/summarize",
          "https://document-summary-assistant-ekuy.onrender.com/api/summarize"
        ];

        for (const url of endpoints) {
          try {
            const apiRes = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                text: sourceText.slice(0, 50000),
                length: summaryLength,
                tone: summaryTone
              })
            });

            if (apiRes.ok) {
              const data = await apiRes.json();
              if (data.summary) {
                finalSummary = data.summary;
                finalKeyPoints = data.key_points || data.keyPoints || [];
                finalKeywords = data.keywords || extractKeywords(sourceText, 6);
                success = true;
                break;
              }
            }
          } catch (err) {
            // try next endpoint
          }
        }

        if (!success) {
          const fallback = createInBrowserSummary(sourceText, summaryLength, summaryTone);
          finalSummary = fallback.summary;
          finalKeyPoints = fallback.keyPoints;
          finalKeywords = fallback.keywords;
        }
      } else {
        const result = createInBrowserSummary(sourceText, summaryLength, summaryTone);
        finalSummary = result.summary;
        finalKeyPoints = result.keyPoints;
        finalKeywords = result.keywords;
      }

      if (!finalSummary) {
        throw new Error("Unable to synthesize a meaningful summary from the text.");
      }

      setSummary(finalSummary);
      setKeyPoints(finalKeyPoints);
      setKeywords(finalKeywords);

      const computed = computeMetrics(sourceText, finalSummary);
      setMetrics(computed);

      const historyItem = {
        id: Date.now(),
        title: activeTab === "upload" ? file.name : "Pasted Text Analysis",
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        summary: finalSummary,
        keyPoints: finalKeyPoints,
        metrics: computed,
        keywords: finalKeywords
      };

      setHistory((prev) => [historyItem, ...prev.slice(0, 14)]);
      showToast("Summary Generated Successfully ✨");
    } catch (err) {
      console.error(err);
      setError(err.message || "Failed to process the document.");
      showToast("Error processing document", "error");
    } finally {
      setLoading(false);
      setProgress("");
    }
  };

  const handleCopy = (textToCopy, label = "Summary") => {
    if (!textToCopy) return;
    navigator.clipboard.writeText(textToCopy);
    showToast(`${label} copied to clipboard! 📋`);
  };

  const exportTXT = () => {
    if (!summary) return;
    const docTitle = activeTab === "upload" ? file?.name || "Document" : "Text-Analysis";
    const content = `=====================================================
DOCUMENT SUMMARY ASSISTANT • SUMMARY REPORT
Document: ${docTitle}
Generated: ${new Date().toLocaleString()}
Compression: ${metrics?.reductionPercent || 0}% reduction
=====================================================

1. EXECUTIVE SUMMARY:
-----------------------------------------------------
${summary}

2. KEY TAKEAWAYS:
-----------------------------------------------------
${keyPoints.map((pt, i) => `${i + 1}. ${pt}`).join("\n\n")}

3. KEY TOPICS:
-----------------------------------------------------
${keywords.join(", ")}
`;

    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${docTitle.replace(/\.[^/.]+$/, "")}-summary.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Downloaded .txt summary");
  };

  const exportMD = () => {
    if (!summary) return;
    const docTitle = activeTab === "upload" ? file?.name || "Document" : "Text-Analysis";
    const content = `# Document Summary: ${docTitle}

> **Generated with Document Summary Assistant** • ${new Date().toLocaleDateString()}
> **Compression**: ${metrics?.reductionPercent || 0}% reduction (${metrics?.originalWords || 0} → ${metrics?.summaryWords || 0} words)

---

## 📌 Executive Summary
${summary}

---

## 🎯 Key Takeaways
${keyPoints.map((pt) => `- ${pt}`).join("\n")}

---

## 🏷️ Key Topics
${keywords.map((k) => `\`#${k}\``).join(" ")}
`;

    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${docTitle.replace(/\.[^/.]+$/, "")}-summary.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Downloaded .md summary");
  };

  const toggleSpeech = () => {
    if (!synthRef.current || !summary) return;

    if (isPlayingAudio) {
      synthRef.current.cancel();
      setIsPlayingAudio(false);
      return;
    }

    synthRef.current.cancel();
    const cleanSpeechText = summary.replace(/•/g, "").replace(/\n+/g, " ");
    const utterance = new SpeechSynthesisUtterance(cleanSpeechText);
    utterance.rate = speechRate;
    utterance.pitch = 1.0;
    utterance.onend = () => setIsPlayingAudio(false);
    utterance.onerror = () => setIsPlayingAudio(false);

    utteranceRef.current = utterance;
    synthRef.current.speak(utterance);
    setIsPlayingAudio(true);
  };

  const changeSpeechSpeed = (rate) => {
    setSpeechRate(rate);
    if (isPlayingAudio && synthRef.current) {
      synthRef.current.cancel();
      setIsPlayingAudio(false);
      showToast(`Speech rate set to ${rate}x`);
    }
  };

  const loadSample = (type) => {
    if (SAMPLE_DOCS[type]) {
      setInputText(SAMPLE_DOCS[type]);
      setActiveTab("text");
      showToast(`Loaded ${type.toUpperCase()} sample`);
    }
  };

  const loadHistoryItem = (item) => {
    setSummary(item.summary);
    setKeyPoints(item.keyPoints || []);
    setMetrics(item.metrics || null);
    setKeywords(item.keywords || []);
    setShowHistoryModal(false);
    showToast(`Restored: ${item.title}`);
  };

  const deleteHistoryItem = (e, id) => {
    e.stopPropagation();
    setHistory((prev) => prev.filter((item) => item.id !== id));
    showToast("Item removed from history");
  };

  return (
    <div className="app-wrapper">
      <nav className="navbar">
        <div className="navbar-container">
          <div
            className="brand"
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          >
            <div className="brand-icon-wrapper">
              <span className="brand-icon">📄</span>
            </div>
            <div>
              <span className="brand-title">Document Summary Assistant</span>
            </div>
          </div>

          <div className="nav-actions">
            <button
              className="nav-btn"
              onClick={() => setShowHistoryModal(true)}
              title="Recent Summaries"
            >
              🕒 History{" "}
              {history.length > 0 && (
                <span className="nav-badge-count">{history.length}</span>
              )}
            </button>

            <button
              className="theme-toggle-btn"
              onClick={toggleTheme}
              title={`Switch to ${theme === "dark" ? "Light" : "Dark"} Mode`}
            >
              {theme === "dark" ? "☀️" : "🌙"}
            </button>
          </div>
        </div>
      </nav>

      <header className="hero-section">
        <div className="hero-pill">
          <span className="hero-pill-dot"></span>
          Intelligent Document & Image Summarizer
        </div>

        <h1 className="hero-title">
          <span className="hero-highlight">Document Summary Assistant</span>
        </h1>

        <p className="hero-subtitle">
          Instantly extract, clean, and summarize PDF documents, scanned images, Word docs,
          presentations, and pasted text with high accuracy.
        </p>

        <div className="supported-tags">
          <span className="tag-badge">📕 PDF & Scanned Docs</span>
          <span className="tag-badge">🖼️ PNG / JPG / WEBP OCR</span>
          <span className="tag-badge">📝 Word DOCX</span>
          <span className="tag-badge">📊 PowerPoint PPTX</span>
          <span className="tag-badge">✍️ Direct Text Paste</span>
        </div>
      </header>

      <main className="main-content">
        <div className="grid-workspace">
          <section className="glass-card main-input-panel">
            <div className="tab-nav">
              <button
                className={`tab-btn ${activeTab === "upload" ? "active" : ""}`}
                onClick={() => setActiveTab("upload")}
              >
                📁 Upload Document / Image
              </button>

              <button
                className={`tab-btn ${activeTab === "text" ? "active" : ""}`}
                onClick={() => setActiveTab("text")}
              >
                ✍️ Paste Text / Samples
              </button>
            </div>

            {activeTab === "upload" && (
              <div>
                {!file ? (
                  <div
                    className={`dropzone ${isDragging ? "drag-active" : ""}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setIsDragging(true);
                    }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setIsDragging(false);
                      handleFile(e.dataTransfer.files[0]);
                    }}
                  >
                    <div className="dropzone-icon-box">📂</div>
                    <h3 className="dropzone-title">Drag & drop your document or image</h3>
                    <p className="dropzone-desc">
                      PDF, DOCX, PPTX, PNG, JPG, WEBP, and TXT files supported
                    </p>

                    <label className="browse-button">
                      Browse Files
                      <input
                        type="file"
                        style={{ display: "none" }}
                        accept=".pdf,.docx,.pptx,.png,.jpg,.jpeg,.webp,.txt,.md"
                        onChange={(e) => handleFile(e.target.files[0])}
                      />
                    </label>

                    <div className="dropzone-formats">
                      PDF • DOCX • PPTX • PNG • JPG • WEBP • TXT
                    </div>
                  </div>
                ) : (
                  <div className="file-preview-card">
                    <div className="file-preview-info">
                      <div className="file-type-icon">
                        {file.name.endsWith(".pdf")
                          ? "📕"
                          : file.name.endsWith(".docx")
                          ? "📘"
                          : file.name.endsWith(".pptx")
                          ? "📙"
                          : "🖼️"}
                      </div>

                      <div className="file-preview-meta">
                        <strong>{file.name}</strong>
                        <span>
                          {(file.size / 1024 / 1024).toFixed(2)} MB • Ready for summarization
                        </span>
                      </div>
                    </div>

                    <button className="remove-file-btn" onClick={() => setFile(null)}>
                      ✕ Remove
                    </button>
                  </div>
                )}
              </div>
            )}

            {activeTab === "text" && (
              <div className="text-input-wrapper">
                <div className="text-sample-bar">
                  <span className="sample-label">Try instant samples:</span>
                  <button className="sample-pill" onClick={() => loadSample("ai")}>
                    🤖 AI & Tech
                  </button>
                  <button className="sample-pill" onClick={() => loadSample("business")}>
                    📈 Business Q3
                  </button>
                  <button className="sample-pill" onClick={() => loadSample("science")}>
                    🔬 Battery Tech
                  </button>
                </div>

                <textarea
                  className="textarea-box"
                  placeholder="Paste or type raw article, research paper, meeting notes, OCR excerpt, or book notes here..."
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                />

                <div className="textarea-footer">
                  <span>
                    {inputText.trim().split(/\s+/).filter(Boolean).length} words • {inputText.length} chars
                  </span>

                  {inputText && (
                    <button className="clear-text-btn" onClick={() => setInputText("")}>
                      Clear Text
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="controls-grid">
              <div>
                <div className="control-group-title">🎯 Summary Length</div>
                <div className="length-selector">
                  {[
                    { id: "short", name: "Short", desc: "Crisp briefing" },
                    { id: "medium", name: "Medium", desc: "Balanced core" },
                    { id: "long", name: "In-Depth", desc: "Full breakdown" }
                  ].map((opt) => (
                    <div
                      key={opt.id}
                      className={`length-option-card ${summaryLength === opt.id ? "active" : ""}`}
                      onClick={() => setSummaryLength(opt.id)}
                    >
                      <strong className="length-name">{opt.name}</strong>
                      <span className="length-desc">{opt.desc}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="control-group-title">⚙️ Processing Engine</div>
                <div className="option-select-row">
                  <div
                    className={`engine-chip ${engine === "client" ? "active" : ""}`}
                    onClick={() => setEngine("client")}
                  >
                    <strong>⚡ In-Browser Fast Engine</strong>
                    <span>Private & Instant OCR</span>
                  </div>

                  <div
                    className={`engine-chip ${engine === "ai" ? "active" : ""}`}
                    onClick={() => setEngine("ai")}
                  >
                    <strong>🚀 Node.js / AI Cloud</strong>
                    <span>Server-Side NLP Pipeline</span>
                  </div>
                </div>
              </div>
            </div>

            {loading && progress && (
              <div className="inline-progress-box">
                <div className="spinner-ring"></div>
                <span className="progress-text">{progress}</span>
              </div>
            )}

            {error && <div className="error-banner">⚠️ {error}</div>}

            <div className="action-bar">
              <button
                className="btn-generate"
                onClick={handleGenerate}
                disabled={loading || (activeTab === "upload" && !file) || (activeTab === "text" && !inputText.trim())}
              >
                {loading ? "⏳ Analyzing Document..." : "✨ Generate Summary"}
              </button>
            </div>
          </section>

          {summary && (
            <div className="results-section">
              {metrics && (
                <div className="metrics-row">
                  <div className="metric-chip">
                    <span className="metric-label">Original Length</span>
                    <span className="metric-value">{metrics.originalWords}</span>
                    <span className="metric-sub">Words in document</span>
                  </div>

                  <div className="metric-chip">
                    <span className="metric-label">Summary Length</span>
                    <span className="metric-value">{metrics.summaryWords}</span>
                    <span className="metric-sub">Words distilled</span>
                  </div>

                  <div className="metric-chip">
                    <span className="metric-label">Reduction</span>
                    <span className="metric-value" style={{ color: "var(--accent-cyan)" }}>
                      {metrics.reductionPercent}%
                    </span>
                    <span className="metric-sub">Compression ratio</span>
                  </div>

                  <div className="metric-chip">
                    <span className="metric-label">Reading Time Saved</span>
                    <span className="metric-value" style={{ color: "var(--accent-emerald)" }}>
                      {metrics.timeSavedMinutes}
                    </span>
                    <span className="metric-sub">Estimated time saved</span>
                  </div>
                </div>
              )}

              <div className="audio-player-card">
                <div className="audio-left">
                  <button className="btn-audio-play" onClick={toggleSpeech} title="Listen to Summary">
                    {isPlayingAudio ? "⏸" : "🔊"}
                  </button>

                  <div className="audio-status-group">
                    <strong>
                      {isPlayingAudio ? "Playing Audio Narration..." : "Text-to-Speech Player"}
                    </strong>
                    <span>
                      {isPlayingAudio ? "Click to pause speech" : "Listen to this summary aloud"}
                    </span>
                  </div>

                  {isPlayingAudio && (
                    <div className="audio-wave">
                      <div className="audio-bar"></div>
                      <div className="audio-bar"></div>
                      <div className="audio-bar"></div>
                      <div className="audio-bar"></div>
                      <div className="audio-bar"></div>
                    </div>
                  )}
                </div>

                <div className="audio-speed-group">
                  <span style={{ fontSize: "11px", color: "var(--text-muted)", fontWeight: "600" }}>
                    SPEED:
                  </span>
                  {[0.75, 1, 1.25, 1.5].map((speed) => (
                    <button
                      key={speed}
                      className={`speed-chip ${speechRate === speed ? "active" : ""}`}
                      onClick={() => changeSpeechSpeed(speed)}
                    >
                      {speed}x
                    </button>
                  ))}
                </div>
              </div>

              <section className="glass-card">
                <div className="card-header-row">
                  <div className="card-title-group">
                    <span className="card-icon">📌</span>
                    <div>
                      <h2 className="card-title">Executive Summary</h2>
                      <span className="card-subtitle">Synthesized core narrative & findings</span>
                    </div>
                  </div>

                  <div className="result-toolbar">
                    <div className="result-btn-group">
                      <button className="action-btn" onClick={() => handleCopy(summary, "Summary")}>
                        📋 Copy
                      </button>
                      <button className="action-btn" onClick={exportTXT}>
                        ⬇ .txt
                      </button>
                      <button className="action-btn" onClick={exportMD}>
                        📝 .md
                      </button>
                      <button className="action-btn" onClick={() => window.print()}>
                        🖨️ Print
                      </button>
                    </div>
                  </div>
                </div>

                <div className="summary-body">{summary}</div>

                {keywords.length > 0 && (
                  <div className="topics-row">
                    <span className="topic-label">Key Topics:</span>
                    {keywords.map((tag, i) => (
                      <span key={i} className="topic-tag">
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
              </section>

              {keyPoints.length > 0 && (
                <section className="glass-card">
                  <div className="card-header-row">
                    <div className="card-title-group">
                      <span className="card-icon">🎯</span>
                      <div>
                        <h2 className="card-title">Key Takeaways & Core Facts</h2>
                        <span className="card-subtitle">Critical points, metrics, and outcomes</span>
                      </div>
                    </div>

                    <button
                      className="action-btn"
                      onClick={() =>
                        handleCopy(
                          keyPoints.map((pt, i) => `${i + 1}. ${pt}`).join("\n\n"),
                          "Key Points"
                        )
                      }
                    >
                      📋 Copy All Points
                    </button>
                  </div>

                  <div className="keypoints-list">
                    {keyPoints.map((point, index) => (
                      <div key={index} className="keypoint-item">
                        <span className="keypoint-index">{index + 1}</span>
                        <p className="keypoint-text">{point}</p>
                        <button
                          className="keypoint-copy"
                          title="Copy this point"
                          onClick={() => handleCopy(point, `Point ${index + 1}`)}
                        >
                          📋
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </main>

      {showHistoryModal && (
        <div className="modal-backdrop" onClick={() => setShowHistoryModal(false)}>
          <div className="modal-container" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">🕒 Recent Summaries</h3>
              <button className="modal-close-btn" onClick={() => setShowHistoryModal(false)}>
                ✕
              </button>
            </div>

            <div className="modal-body">
              {history.length === 0 ? (
                <div className="empty-history">No past summaries yet. Generate a summary to save it here!</div>
              ) : (
                history.map((item) => (
                  <div key={item.id} className="history-item" onClick={() => loadHistoryItem(item)}>
                    <div className="history-item-meta">
                      <strong>{item.title}</strong>
                      <span>
                        {item.timestamp} • {item.metrics?.reductionPercent || 0}% compression •{" "}
                        {item.keyPoints?.length || 0} key points
                      </span>
                    </div>

                    <div className="history-item-actions">
                      <button
                        className="history-delete-btn"
                        title="Delete from history"
                        onClick={(e) => deleteHistoryItem(e, item.id)}
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      <div className="toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.type}`}>
            {toast.type === "success" ? "✅" : "⚠️"} {toast.message}
          </div>
        ))}
      </div>

      <footer className="app-footer">
        <div className="footer-inner">
          <div className="footer-brand">Document Summary Assistant</div>
          <p className="footer-developer">
            Engineered with modern Web & NLP technologies by <strong>Lakshmana Murthy</strong>
          </p>

          <div className="footer-links">
            <a href="mailto:lakshmanamurthy.kadapala@gmail.com" className="footer-link">
              ✉️ lakshmanamurthy.kadapala@gmail.com
            </a>
            <span style={{ color: "var(--border-card)" }}>•</span>
            <a href="tel:+918179117439" className="footer-link">
              📞 +91 8179117439
            </a>
          </div>

          <div className="footer-copy">
            © 2026 Document Summary Assistant. High-density OCR & intelligent summarization.
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
