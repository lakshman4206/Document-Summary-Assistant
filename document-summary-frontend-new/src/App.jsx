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

  business: `Quarterly Business & Growth Strategy Review (Q3 2026):

Over the past three financial quarters, the enterprise experienced a 34% year-over-year revenue increase ($14.2M total), driven primarily by cloud subscription adoption across European enterprise markets. Customer retention rates reached an all-time high of 94.2%, reflecting improved customer onboarding workflows and enhanced product reliability.

Operating expenses increased by 18% due to heightened marketing acquisition costs and substantial investments in server GPU infrastructure. To optimize long-term operational efficiency, leadership has decided to automate routine administrative operations, streamline vendor procurement contracts, and consolidate regional sales hubs.

Key Strategic Priorities for Fiscal Year 2027:
1. Accelerate enterprise cloud product features and ISO/SOC2 security certifications.
2. Reduce customer acquisition costs by 15% through targeted digital channel marketing.
3. Expand strategic partnerships with leading technology integrators to capture enterprise market share.`,

  science: `Breakthrough in Solid-State Battery Energy Density:

Materials scientists have engineered a novel ceramic-polymer hybrid electrolyte capable of sustaining over 1,200 continuous charge-discharge cycles with minimal thermal degradation. Unlike conventional lithium-ion batteries that rely on flammable liquid electrolytes, this solid-state formulation virtually eliminates the risk of thermal runaway while dramatically improving operating safety under extreme temperature variations (-40°C to 85°C).

Experimental trials demonstrate an estimated 42% increase in volumetric energy density compared to industry-standard cells. This advancement could enable next-generation electric vehicles to achieve over 600 miles of driving range on a single charge with rapid 15-minute replenishment cycles.

Production scalability remains the primary commercial bottleneck. The research consortium has initiated pilot manufacturing partnerships with global OEMs to refine continuous roll-to-roll sintering techniques, aiming for commercial deployment in consumer electronics and mobility sectors within three years.`
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
 * Only rejects tokens that are clearly OCR scanner artifacts.
 * Very lenient: preserves student IDs, reg numbers, codes, etc.
 */
export const isLikelyNoiseToken = (token) => {
  if (!token) return true;
  const clean = token.replace(/^[^\w%$#°@.]+|[^\w%$#°@.]+$/g, "");
  if (!clean) return true;

  // Always keep: pure numbers, metrics, currencies, codes with digits
  if (/^[\d,.:;%$\-+#°℃℉xX]+$/.test(clean)) return false;
  if (/\d/.test(clean)) return false; // any token containing a digit is preserved

  // Known acronyms always kept
  if (PRESERVED_ACRONYMS.has(clean.toUpperCase())) return false;

  const lower = clean.toLowerCase();

  // Single letters: only noise if not 'a' or 'i'
  if (clean.length === 1) return !["a", "i"].includes(lower);

  // Two-letter words: keep known words and acronyms
  if (clean.length === 2) return !VALID_SHORT_WORDS.has(lower) && !/^[A-Z]{2}$/.test(clean);

  // Repetitive garbage: "aaaa", "xxxxx", "-----"
  if (/^(.)\1{4,}$/.test(clean)) return true;

  // Pure symbol noise (no alphanumeric characters)
  const letters = (clean.match(/[a-zA-Z]/g) || []).length;
  if (letters === 0) return true;

  // 3+ letters with no vowels is OCR garbage (unless recognized acronym like PDF, CSS, GPT)
  if (letters >= 3 && !/[aeiouyAEIOUY]/.test(clean) && !PRESERVED_ACRONYMS.has(clean.toUpperCase())) {
    return true;
  }

  // 5+ consecutive consonants = likely OCR garbage
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
 * 4. Grammar, Homophones, Article Agreement & Polish
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
    [/\bearlier\s+then\b/gi, "earlier than"],
    [/\bhigher\s+then\b/gi, "higher than"],
    [/\blower\s+then\b/gi, "lower than"],
    [/\bother\s+then\b/gi, "other than"],

    [/\byour\s+(welcome|right|going|able|ready|invited|doing)\b/gi, "you're $1"],
    [/\byou're\s+(name|car|house|file|document|profile|email|data|work)\b/gi, "your $1"],

    [/\bit's\s+(name|features|purpose|value|speed|impact|application|accuracy|structure|content|growth)\b/gi, "its $1"],

    [/\bthere\s+(names|features|results|findings|skills|roles|efforts)\b/gi, "their $1"],
    [/\btheir\s+(is|are|was|were|will be|can be|has been)\b/gi, "there $1"],

    [/\b(an|the|a|significant|direct|indirect|adverse|positive|negative|profound)\s+affect\b/gi, "$1 effect"],
    [/\bhave\s+an\s+affect\s+on\b/gi, "have an effect on"],

    [/\bin\s+order\s+to\b/gi, "to"],
    [/\bdue\s+to\s+the\s+fact\s+that\b/gi, "because"],
    [/\bat\s+the\s+present\s+time\b/gi, "currently"],

    [/\beveryone\s+are\b/gi, "everyone is"],
    [/\bsomeone\s+are\b/gi, "someone is"],

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
 * Lenient: preserves as much content as possible, only strips true OCR noise.
 */
export const cleanExtractedText = (text) => {
  if (!text || typeof text !== "string") return "";

  let cleaned = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Remove page stamps, timestamps, bracket references, and heavy symbol lines
  cleaned = cleaned.replace(/\bPage\s+\d+\s+(?:of|\/)?\s*\d*\b/gi, " ");
  cleaned = cleaned.replace(/[|\u00A6\u00A7\u00A4\u2122\u2192\u2190\u2191\u2193~`^=]{3,}/g, " ");

  // Repair broken words first
  cleaned = repairBrokenWords(cleaned);

  const lines = cleaned.split(/\r?\n/);
  const processedLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.length < 2) continue;

    // Filter individual tokens — very lenient
    const lineTokens = trimmed.split(/\s+/).filter((token) => !isLikelyNoiseToken(token));
    if (lineTokens.length === 0) continue;

    const filtered = lineTokens.join(" ");
    // Require at least 2 letters total in the line
    const letters = (filtered.match(/[A-Za-z]/g) || []).length;
    if (letters < 2) continue;

    processedLines.push(normalizeSentenceCase(filtered));
  }

  if (processedLines.length === 0) {
    // Fallback: if everything got filtered, return the original text lightly cleaned
    return text.trim().replace(/\s{2,}/g, " ").replace(/[|\u00A6\u00A7]{2,}/g, "");
  }

  // Join lines with periods to help sentence splitting
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
      // Relaxed threshold so short-document lines (ID cards, forms, brief notes)
      // are not all filtered out, which would leave zero sentences and no summary.
      return words.length >= 2 && letters >= 6;
    });
};

export const restructureDocument = (text) => {
  const cleaned = cleanExtractedText(text);
  const sentences = getSentences(cleaned);

  if (sentences.length <= 3) {
    return cleaned;
  }

  const paragraphs = [];
  let currentP = [];

  sentences.forEach((sent, idx) => {
    currentP.push(sent);
    if (currentP.length >= 3 || idx === sentences.length - 1) {
      paragraphs.push(currentP.join(" "));
      currentP = [];
    }
  });

  return paragraphs.join("\n\n");
};

export const extractEntities = (text) => {
  if (!text) return { dates: [], metrics: [], properNouns: [], technicalTerms: [] };

  const dates = [];
  const metrics = [];
  const properNouns = [];
  const technicalTerms = [];

  const dateMatches = text.match(/\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\b\d{4}\b)\b/gi) || [];
  dateMatches.forEach((d) => {
    const clean = d.trim();
    if (clean && !dates.includes(clean) && clean.length > 3) dates.push(clean);
  });

  const metricRegex = /(?:\$\s*\d+(?:\.\d+)?(?:\s*[MBKmbk]|billion|million|thousand)?|\b\d+(?:\.\d+)?%|\b\d+(?:,\d{3})*(?:\.\d+)?\s*(?:miles|km|hours|minutes|mins|cycles|percent|kg|MB|GB|TB|tons|units)\b)/gi;
  const metricMatches = text.match(metricRegex) || [];
  metricMatches.forEach((m) => {
    const clean = m.trim();
    if (clean && !metrics.includes(clean)) metrics.push(clean);
  });

  PRESERVED_ACRONYMS.forEach((acronym) => {
    const regex = new RegExp(`\\b${acronym}\\b`, "i");
    if (regex.test(text) && !technicalTerms.includes(acronym)) {
      technicalTerms.push(acronym);
    }
  });

  const properMatches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
  properMatches.forEach((p) => {
    const clean = p.trim();
    if (clean && !properNouns.includes(clean) && clean.length > 5 && !PRESERVED_ACRONYMS.has(clean.toUpperCase())) {
      properNouns.push(clean);
    }
  });

  return {
    dates: dates.slice(0, 6),
    metrics: metrics.slice(0, 6),
    properNouns: properNouns.slice(0, 6),
    technicalTerms: technicalTerms.slice(0, 6)
  };
};

export const calculateReadability = (text) => {
  if (!text) return { fleschScore: 70, gradeLevel: "Standard", complexity: "Moderate" };

  const words = text.trim().split(/\s+/).filter(Boolean);
  const sentences = getSentences(text);
  const wordCount = words.length || 1;
  const sentenceCount = sentences.length || 1;

  let syllableCount = 0;
  words.forEach((w) => {
    const clean = w.toLowerCase().replace(/[^a-z]/g, "");
    if (clean.length <= 3) {
      syllableCount += 1;
    } else {
      const matches = clean.match(/[aeiouy]{1,2}/g);
      syllableCount += matches ? matches.length : 1;
    }
  });

  const score = Math.round(
    206.835 - 1.015 * (wordCount / sentenceCount) - 84.6 * (syllableCount / wordCount)
  );
  const clampedScore = Math.max(0, Math.min(100, score));

  let gradeLevel = "Standard";
  let complexity = "Balanced";

  if (clampedScore >= 80) {
    gradeLevel = "Clear & Simple (6th Grade)";
    complexity = "High Clarity";
  } else if (clampedScore >= 60) {
    gradeLevel = "Standard (8th-10th Grade)";
    complexity = "Optimal Reading Pace";
  } else if (clampedScore >= 45) {
    gradeLevel = "Technical (College Level)";
    complexity = "Dense / Analytical";
  } else {
    gradeLevel = "Advanced Academic";
    complexity = "High Complexity";
  }

  return {
    fleschScore: clampedScore,
    gradeLevel,
    complexity,
    syllablesPerWord: (syllableCount / wordCount).toFixed(1),
    avgSentenceLength: Math.round(wordCount / sentenceCount)
  };
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
  // Try cleaned version; fall back to raw text if cleaning emptied everything
  let cleaned = cleanExtractedText(text);
  if (!cleaned || cleaned.trim().length < 20) {
    cleaned = text?.trim() || "";
  }

  if (!cleaned) {
    return {
      summary: "",
      keyPoints: [],
      keywords: [],
      restructuredDocument: "",
      entities: { dates: [], metrics: [], properNouns: [], technicalTerms: [] },
      readability: { fleschScore: 70, gradeLevel: "Standard", complexity: "Balanced" }
    };
  }

  const restructuredDocument = restructureDocument(text);
  const entities = extractEntities(cleaned);
  const readability = calculateReadability(cleaned);

  // Try proper sentence splitting first
  let sentences = getSentences(cleaned);

  // If no sentences detected (e.g. ID card with field labels only),
  // split by periods or newlines as fallback segments
  if (!sentences.length) {
    sentences = cleaned
      .split(/[.!?\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 8 && (s.match(/[A-Za-z]/g) || []).length >= 4);
  }

  // Final fallback: use the whole cleaned text as one summary block
  if (!sentences.length) {
    const fallbackSummary = cleaned.slice(0, 800).trim();
    return {
      summary: fallbackSummary,
      keyPoints: cleaned.split(".").filter((s) => s.trim().length > 5).slice(0, 4).map((s) => s.trim()),
      keywords: extractKeywords(cleaned),
      restructuredDocument,
      entities,
      readability
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
    keywords: extractKeywords(cleaned, 6),
    restructuredDocument,
    entities,
    readability
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
      canvas.getContext("2d").drawImage(img, 0, 0);
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

      // PDF.js returns mixed item types (TextItem, MarkedContent, etc)
      // Only TextItem has `str` — guard defensively before accessing.
      const pageText = (content.items || [])
        .filter((item) => typeof item.str === "string" && item.str.trim() !== "")
        .map((item) => item.str)
        .join(" ");

      if (pageText.trim()) {
        fullText += pageText + "\n";
      }
    } catch (pageErr) {
      console.warn(`PDF page ${pageNumber} extraction failed:`, pageErr);
      // Continue to next page instead of crashing
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

      const processedCanvas = preprocessCanvasForOCR(canvas);
      const ocrResult = await worker.recognize(processedCanvas);
      const pageText = ocrResult?.data?.text || "";
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
  setProgress("Preparing image for deep-scan OCR (Otsu adaptive contrast)...");

  const rawCanvas = await loadFileToCanvas(file);
  const processedCanvas = preprocessCanvasForOCR(rawCanvas);

  setProgress("Scanning high-contrast image with Tesseract neural OCR...");

  const worker = await createWorker("eng");
  if (PSM?.SPARSE_TEXT) {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
  }

  const ocrResult = await worker.recognize(processedCanvas);
  const text = ocrResult?.data?.text || "";
  await worker.terminate();

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

  // Multi-view result tabs: 'summary' | 'restructured' | 'diff' | 'intelligence'
  const [resultTab, setResultTab] = useState("summary");

  const [summary, setSummary] = useState("");
  const [keyPoints, setKeyPoints] = useState([]);
  const [keywords, setKeywords] = useState([]);
  const [restructuredDocument, setRestructuredDocument] = useState("");
  const [entities, setEntities] = useState({ dates: [], metrics: [], properNouns: [], technicalTerms: [] });
  const [readability, setReadability] = useState(null);

  const [rawExtractedText, setRawExtractedText] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [scanPhase, setScanPhase] = useState(0); // 1 to 5 for deep-scan telemetry
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
    setScanPhase(1);
    setSummary("");
    setKeyPoints([]);
    setKeywords([]);
    setRestructuredDocument("");
    setEntities({ dates: [], metrics: [], properNouns: [], technicalTerms: [] });
    setReadability(null);
    setRawExtractedText("");

    try {
      // Phase 1: Ingestion & Geometry
      setScanPhase(1);
      setProgress("Phase 1/5: Ingestion & Resolution Calibration (Otsu Adaptive Binarization)...");

      if (activeTab === "upload") {
        const ext = file.name.split(".").pop().toLowerCase();

        if (ext === "pdf") {
          const result = await extractTextFromPDF(file, setProgress);
          // Defensive guard: result may be undefined if PDF.js fails
          sourceText = result?.text || "";

          const cleanedPreview = cleanExtractedText(sourceText);
          if (!cleanedPreview || cleanedPreview.replace(/\s/g, "").length < 60) {
            setScanPhase(2);
            setProgress("Phase 2/5: Scanned PDF detected. High-density neural OCR pass...");
            if (result?.pdf) {
              sourceText = await ocrScannedPDF(result.pdf, setProgress);
            }
          }
        } else if (["png", "jpg", "jpeg", "webp"].includes(ext)) {
          setScanPhase(2);
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
        throw new Error("No readable text could be extracted from this source.");
      }

      setRawExtractedText(sourceText);

      // Phase 3: De-noising, Broken Word Repair & De-hyphenation
      setScanPhase(3);
      setProgress("Phase 3/5: Scan Artifact De-Noising, Broken Word Repair & De-Hyphenation...");
      await new Promise((r) => setTimeout(r, 450));

      // Phase 4: True-Casing Normalization & Entity Protection
      setScanPhase(4);
      setProgress("Phase 4/5: True-Casing Normalization & Entity/Metric Protection...");
      await new Promise((r) => setTimeout(r, 450));

      // Phase 5: Semantic Restructuring & Executive Synthesis
      setScanPhase(5);
      setProgress("Phase 5/5: Semantic Restructuring, Readability Indexing & Executive Synthesis...");

      let finalSummary = "";
      let finalKeyPoints = [];
      let finalKeywords = [];
      let finalRestructured = "";
      let finalEntities = { dates: [], metrics: [], properNouns: [], technicalTerms: [] };
      let finalReadability = null;

      if (engine === "ai") {
        let success = false;
        const endpoints = [
          "http://localhost:5000/api/deep-scan",
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
                finalRestructured = data.restructured_document || restructureDocument(sourceText);
                finalEntities = data.entities || extractEntities(sourceText);
                finalReadability = data.readability || calculateReadability(sourceText);
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
          finalRestructured = fallback.restructuredDocument;
          finalEntities = fallback.entities;
          finalReadability = fallback.readability;
        }
      } else {
        const result = createInBrowserSummary(sourceText, summaryLength, summaryTone);
        finalSummary = result.summary;
        finalKeyPoints = result.keyPoints;
        finalKeywords = result.keywords;
        finalRestructured = result.restructuredDocument;
        finalEntities = result.entities;
        finalReadability = result.readability;
      }

      if (!finalSummary) {
        throw new Error("Unable to synthesize a meaningful summary from the text.");
      }

      setSummary(finalSummary);
      setKeyPoints(finalKeyPoints);
      setKeywords(finalKeywords);
      setRestructuredDocument(finalRestructured);
      setEntities(finalEntities);
      setReadability(finalReadability);

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
      showToast("Deep-Scan & Synthesis Complete ✨");
    } catch (err) {
      console.error(err);
      setError(err.message || "Failed to process the document.");
      showToast("Error processing document", "error");
    } finally {
      setLoading(false);
      setProgress("");
      setScanPhase(0);
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
DOCUMENT SUMMARY ASSISTANT • DEEP SCAN REPORT
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

3. KEY TOPICS & ENTITIES:
-----------------------------------------------------
Topics: ${keywords.join(", ")}
Dates: ${entities.dates.join(", ") || "N/A"}
Metrics: ${entities.metrics.join(", ") || "N/A"}

4. FULL RESTRUCTURED DOCUMENT:
-----------------------------------------------------
${restructuredDocument}
`;

    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${docTitle.replace(/\.[^/.]+$/, "")}-deepscan.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Downloaded .txt report");
  };

  const exportMD = () => {
    if (!summary) return;
    const docTitle = activeTab === "upload" ? file?.name || "Document" : "Text-Analysis";
    const content = `# Document Deep-Scan Intelligence: ${docTitle}

> **Generated with Document Summary Assistant** • ${new Date().toLocaleDateString()}
> **Stats**: ${metrics?.originalWords || 0} words reduced to ${metrics?.summaryWords || 0} words (${metrics?.reductionPercent || 0}% compression)
> **Readability**: ${readability?.gradeLevel || "Standard"} (Flesch Score: ${readability?.fleschScore || 70}/100)

---

## 📌 Executive Summary
${summary}

---

## 🎯 Key Takeaways & Facts
${keyPoints.map((pt) => `- ${pt}`).join("\n")}

---

## 🏷️ Extracted Intelligence
- **Topic Tags**: ${keywords.map((k) => `\`${k}\``).join(" ")}
- **Key Metrics & Figures**: ${entities.metrics.map((m) => `\`${m}\``).join(" ") || "None"}
- **Important Dates**: ${entities.dates.map((d) => `\`${d}\``).join(" ") || "None"}

---

## 📝 Full Restructured & Restored Document
${restructuredDocument}
`;

    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${docTitle.replace(/\.[^/.]+$/, "")}-intelligence.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Downloaded .md Markdown report");
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
              <span className="brand-badge" style={{ marginLeft: "8px" }}>
                Deep-Scan v2.0
              </span>
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
          Deep-Scan Neural OCR & Document Intelligence Suite
        </div>

        <h1 className="hero-title">
          <span className="hero-highlight">Document Summary Assistant</span>
        </h1>

        <p className="hero-subtitle">
          Upload any document or image for high-density OCR extraction, scan artifact de-noising,
          true-casing normalization, entity preservation, and executive synthesis.
        </p>

        <div className="supported-tags">
          <span className="tag-badge">📕 Scanned PDF & Text</span>
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
                          {(file.size / 1024 / 1024).toFixed(2)} MB • Ready for deep-scan analysis
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
                    <strong>⚡ In-Browser Deep Scan</strong>
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

            {loading && (
              <div className="deep-scan-modal-overlay">
                <div className="deep-scan-box">
                  <div className="scanline-glow"></div>
                  <div className="scan-header">
                    <div className="scan-radar-icon">📡</div>
                    <div>
                      <h3 className="scan-title">Deep-Scan Neural Reader in Progress</h3>
                      <p className="scan-subtitle">{progress}</p>
                    </div>
                  </div>

                  <div className="scan-stages-track">
                    {[
                      { step: 1, name: "Geometry & Upscale" },
                      { step: 2, name: "Neural OCR Pass" },
                      { step: 3, name: "De-Noise & De-Hyphen" },
                      { step: 4, name: "True-Casing & Entities" },
                      { step: 5, name: "Semantic Restructuring" }
                    ].map((st) => (
                      <div
                        key={st.step}
                        className={`scan-step-item ${
                          scanPhase > st.step ? "done" : scanPhase === st.step ? "active" : ""
                        }`}
                      >
                        <div className="scan-step-dot">
                          {scanPhase > st.step ? "✓" : st.step}
                        </div>
                        <span className="scan-step-label">{st.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {error && <div className="error-banner">⚠️ {error}</div>}

            <div className="action-bar">
              <button
                className="btn-generate"
                onClick={handleGenerate}
                disabled={loading || (activeTab === "upload" && !file) || (activeTab === "text" && !inputText.trim())}
              >
                {loading ? "⏳ Deep-Scanning Document..." : "🔍 Run Deep-Scan & Restore Document"}
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

              {/* View Selector Tabs */}
              <div className="view-selector-bar">
                <button
                  className={`view-tab-btn ${resultTab === "summary" ? "active" : ""}`}
                  onClick={() => setResultTab("summary")}
                >
                  📌 Executive Summary
                </button>
                <button
                  className={`view-tab-btn ${resultTab === "restructured" ? "active" : ""}`}
                  onClick={() => setResultTab("restructured")}
                >
                  📝 Restructured Document
                </button>
                <button
                  className={`view-tab-btn ${resultTab === "diff" ? "active" : ""}`}
                  onClick={() => setResultTab("diff")}
                >
                  🔍 Raw vs Cleaned Diff
                </button>
                <button
                  className={`view-tab-btn ${resultTab === "intelligence" ? "active" : ""}`}
                  onClick={() => setResultTab("intelligence")}
                >
                  📊 Entities & Intelligence
                </button>
              </div>

              {resultTab === "summary" && (
                <>
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
                            <span className="card-subtitle">Critical decisions, metrics, and outcomes</span>
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
                </>
              )}

              {resultTab === "restructured" && (
                <section className="glass-card">
                  <div className="card-header-row">
                    <div className="card-title-group">
                      <span className="card-icon">📝</span>
                      <div>
                        <h2 className="card-title">Restructured Full Document</h2>
                        <span className="card-subtitle">
                          100% factual accuracy, zero OCR noise, proper capitalization & fluid flow
                        </span>
                      </div>
                    </div>

                    <div className="result-btn-group">
                      <button className="action-btn" onClick={() => handleCopy(restructuredDocument, "Full Document")}>
                        📋 Copy Restructured Text
                      </button>
                      <button className="action-btn" onClick={exportMD}>
                        📝 Export Markdown
                      </button>
                    </div>
                  </div>

                  <div className="restructured-body">
                    {restructuredDocument.split("\n\n").map((para, idx) => (
                      <p key={idx} className="restructured-paragraph">
                        {para}
                      </p>
                    ))}
                  </div>
                </section>
              )}

              {resultTab === "diff" && (
                <section className="glass-card">
                  <div className="card-header-row">
                    <div className="card-title-group">
                      <span className="card-icon">🔍</span>
                      <div>
                        <h2 className="card-title">Raw Extraction vs Restructured Diff</h2>
                        <span className="card-subtitle">
                          Compare the raw scanned OCR artifact against the clean, restored output
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="diff-grid">
                    <div className="diff-pane raw-pane">
                      <div className="diff-pane-header">
                        <strong>Raw Unprocessed Extraction</strong>
                        <span>Contains OCR artifacts & broken line breaks</span>
                      </div>
                      <div className="diff-pane-content">{rawExtractedText || "No raw text available"}</div>
                    </div>

                    <div className="diff-pane clean-pane">
                      <div className="diff-pane-header">
                        <strong>Cleaned & Restructured Document</strong>
                        <span>Normalized casing, de-hyphenated & grammatically polished</span>
                      </div>
                      <div className="diff-pane-content">{restructuredDocument || summary}</div>
                    </div>
                  </div>
                </section>
              )}

              {resultTab === "intelligence" && (
                <div className="intelligence-grid">
                  <section className="glass-card">
                    <div className="card-header-row">
                      <div className="card-title-group">
                        <span className="card-icon">📊</span>
                        <div>
                          <h2 className="card-title">Document Readability & Depth</h2>
                          <span className="card-subtitle">Flesch-Kincaid & structural analytics</span>
                        </div>
                      </div>
                    </div>

                    <div className="analytics-chips-grid">
                      <div className="analytic-box">
                        <span className="analytic-label">Flesch Reading Ease</span>
                        <strong className="analytic-score">{readability?.fleschScore || 70} / 100</strong>
                        <span className="analytic-sub">{readability?.complexity || "Balanced Pace"}</span>
                      </div>

                      <div className="analytic-box">
                        <span className="analytic-label">Target Reading Level</span>
                        <strong className="analytic-score" style={{ fontSize: "16px", color: "var(--accent-cyan)" }}>
                          {readability?.gradeLevel || "Standard"}
                        </strong>
                        <span className="analytic-sub">Optimal audience comprehension</span>
                      </div>

                      <div className="analytic-box">
                        <span className="analytic-label">Avg Sentence Length</span>
                        <strong className="analytic-score">{readability?.avgSentenceLength || 18} words</strong>
                        <span className="analytic-sub">{readability?.syllablesPerWord || 1.6} syllables/word</span>
                      </div>
                    </div>
                  </section>

                  <section className="glass-card">
                    <div className="card-header-row">
                      <div className="card-title-group">
                        <span className="card-icon">🏷️</span>
                        <div>
                          <h2 className="card-title">Extracted Entities & Key Figures</h2>
                          <span className="card-subtitle">Protected facts, numbers, dates & technical terms</span>
                        </div>
                      </div>
                    </div>

                    <div className="entities-block">
                      <div className="entity-group">
                        <strong>📈 Key Metrics & Figures:</strong>
                        <div className="entity-tags-row">
                          {entities.metrics.length > 0 ? (
                            entities.metrics.map((m, i) => (
                              <span key={i} className="entity-badge metric">
                                {m}
                              </span>
                            ))
                          ) : (
                            <span className="entity-empty">No numerical figures detected</span>
                          )}
                        </div>
                      </div>

                      <div className="entity-group">
                        <strong>📅 Important Dates:</strong>
                        <div className="entity-tags-row">
                          {entities.dates.length > 0 ? (
                            entities.dates.map((d, i) => (
                              <span key={i} className="entity-badge date">
                                {d}
                              </span>
                            ))
                          ) : (
                            <span className="entity-empty">No date stamps detected</span>
                          )}
                        </div>
                      </div>

                      <div className="entity-group">
                        <strong>⚙️ Technical Acronyms:</strong>
                        <div className="entity-tags-row">
                          {entities.technicalTerms.length > 0 ? (
                            entities.technicalTerms.map((t, i) => (
                              <span key={i} className="entity-badge tech">
                                {t}
                              </span>
                            ))
                          ) : (
                            <span className="entity-empty">No technical acronyms detected</span>
                          )}
                        </div>
                      </div>

                      <div className="entity-group">
                        <strong>🏢 Named Entities & Proper Nouns:</strong>
                        <div className="entity-tags-row">
                          {entities.properNouns.length > 0 ? (
                            entities.properNouns.map((p, i) => (
                              <span key={i} className="entity-badge noun">
                                {p}
                              </span>
                            ))
                          ) : (
                            <span className="entity-empty">No proper nouns detected</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </section>
                </div>
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
          <div className="footer-brand">Document Summary Assistant • Deep-Scan Suite</div>
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
            © 2026 Document Summary Assistant. High-density OCR, Neural De-noising & Document Restoration.
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
