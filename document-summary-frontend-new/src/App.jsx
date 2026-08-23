import { useState, useEffect, useRef } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createWorker } from "tesseract.js";
import mammoth from "mammoth";
import JSZip from "jszip";
import "./App.css";

GlobalWorkerOptions.workerSrc = pdfWorker;

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

const KEEP_SHORT_WORDS = new Set([
  "a", "i", "am", "an", "as", "at", "be", "by",
  "do", "go", "he", "if", "in", "is", "it", "me",
  "my", "no", "of", "on", "or", "so", "to", "up",
  "us", "we", "ai", "ml", "ui", "ux", "id", "api"
]);

// Real acronyms/initialisms worth preserving in ALL CAPS when we
// normalize random OCR/extraction capitalization below. Anything
// ALL-CAPS that is NOT in this set gets treated as a casing glitch.
const KNOWN_ACRONYMS = new Set([
  "AI", "ML", "NLP", "API", "URL", "HTTP", "HTTPS", "PDF", "CSV", "JSON",
  "XML", "HTML", "CSS", "SQL", "CEO", "CFO", "CTO", "USA", "UK", "EU",
  "UN", "NASA", "FBI", "CIA", "FAQ", "ID", "IT", "OS", "CPU", "GPU",
  "RAM", "USB", "TV", "PC", "UI", "UX", "GDP", "WHO", "NATO", "IPO"
]);

// Fixes random mid-sentence ALL-CAPS words coming from OCR/PDF extraction
// glitches (e.g. "the DOCTOR Went TO the Hospital") without touching real
// acronyms. This runs on the client fallback path, which is what actually
// serves the summary whenever the backend AI engine is unreachable.
const normalizeRandomCaps = (text) => {
  if (!text) return "";
  return text.replace(/\b[A-Z]{2,}\b/g, (word) =>
    KNOWN_ACRONYMS.has(word) ? word : word.toLowerCase()
  );
};

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

const isLikelyNoiseToken = (token) => {
  const clean = token.trim();
  if (!clean) return true;

  const letters = (clean.match(/[A-Za-z]/g) || []).length;
  const numbers = (clean.match(/[0-9]/g) || []).length;
  const strange = (clean.match(/[^A-Za-z0-9'’-]/g) || []).length;

  if (letters === 1 && !KEEP_SHORT_WORDS.has(clean.toLowerCase())) return true;

  if (
    letters === 2 &&
    clean === clean.toUpperCase() &&
    !["AI", "IT", "TV", "UK", "US", "ML", "UI", "UX"].includes(clean)
  ) {
    return true;
  }

  if (strange > letters && letters < 4) return true;
  if (numbers > letters && letters < 4) return true;

  return false;
};

const cleanSentenceTokens = (sentence) => {
  return sentence
    .split(/\s+/)
    .filter((token) => !isLikelyNoiseToken(token))
    .join(" ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/([,.!?;:])([A-Za-z])/g, "$1 $2")
    .trim();
};

const cleanExtractedText = (text) => {
  if (!text) return "";

  let cleaned = text;

  // Generic document cleanup: page numbers, timestamps, citation brackets
  cleaned = cleaned.replace(/\bPage\s+\d+\s+of\s+\d+\b/gi, " ");
  cleaned = cleaned.replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");
  cleaned = cleaned.replace(/\[\s*\d+\s*\]/g, " ");

  // Remove common noise symbols and decorative glyphs
  cleaned = cleaned.replace(/(?:^|\s)(?:page\s*)?\d{1,4}(?:\s|$)/gi, " ");
  cleaned = cleaned.replace(/[|\u00A6\u00A7\u00A4\u00A9\u00AE\u2122\u2192\u2190\u2191\u2193\u2194\u2195\u2022\u25AA\u25AB\u25E6\u25A0\u25A1\u25C6\u25C7~`^_=]+/g, " ");
  cleaned = cleaned.replace(/\[[^\]]{0,150}\]/g, " ");
  cleaned = cleaned.replace(/([,.!?;:]){2,}/g, "$1");

  const lines = cleaned.split(/\r?\n/);
  const usefulLines = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) continue;

    const letters = (trimmed.match(/[A-Za-z]/g) || []).length;
    const numbers = (trimmed.match(/\d/g) || []).length;
    const symbols = (trimmed.match(/[^A-Za-z0-9\s.,!?'"\u2018\u2019():;\-]/g) || []).length;

    if (letters < 3) continue;
    if (symbols > letters * 1.2) continue;
    if (numbers > letters * 1.5) continue;

    usefulLines.push(trimmed);
  }

  cleaned = usefulLines.join(" ");
  cleaned = cleaned.replace(/\s+/g, " ");

  const roughSentences = cleaned.split(/(?<=[.!?])\s+/);
  const finalSentences = [];

  for (const sentence of roughSentences) {
    const cleanSentence = cleanSentenceTokens(sentence);
    const letters = (cleanSentence.match(/[A-Za-z]/g) || []).length;
    const words = cleanSentence.split(/\s+/).filter(Boolean);

    if (words.length < 4 || letters < 15) continue;

    finalSentences.push(cleanSentence);
  }

  return finalSentences.join(" ").trim();
};

const fixGrammarAndHomophones = (text) => {
  if (!text) return "";

  let t = text.trim();

  // Normalize stray ALL-CAPS words before anything else, so later steps
  // (like re-capitalizing the first letter of each sentence) work on
  // already-normalized casing instead of fighting it.
  t = normalizeRandomCaps(t);

  // 1. Article agreement ("a" vs "an" with phonetic exceptions)
  t = t.replace(/\b([Aa])\s+([aeiouAEIOU]\w*)/g, (match, p1, p2) => {
    const isConsonantSound = /^(?:univ|use|uniq|unit|user|eul|euro|one|once)/i.test(p2);
    return isConsonantSound ? "a " + p2 : "an " + p2;
  });
  t = t.replace(/\b([Aa])n\s+([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ]\w*)/g, (match, p1, p2) => {
    const isVowelSound = /^(?:hour|honest|honor|heir)/i.test(p2);
    return isVowelSound ? "an " + p2 : "a " + p2;
  });

  // 2. Comprehensive grammar, homophone, redundancy, and flow rules
  const rules = [
    // Comparisons: than vs then
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
    // you're vs your
    [/\byour\s+(welcome|right|going|able|ready|invited|doing)\b/gi, "you're $1"],
    [/\byou're\s+(name|car|house|file|document|profile|email|data|work)\b/gi, "your $1"],
    // its vs it's
    [/\bit's\s+(name|features|purpose|value|speed|impact|application|accuracy|structure|content|growth)\b/gi, "its $1"],
    // their vs there
    [/\bthere\s+(names|features|results|findings|skills|roles|efforts)\b/gi, "their $1"],
    [/\btheir\s+(is|are|was|were|will be|can be|has been)\b/gi, "there $1"],
    // affect vs effect
    [/\bthe\s+affect\s+of\b/gi, "the effect of"],
    [/\ba\s+significant\s+affect\b/gi, "a significant effect"],
    [/\bhave\s+an\s+affect\s+on\b/gi, "have an effect on"],
    // Conciseness
    [/\bin\s+order\s+to\b/gi, "to"],
    [/\bdue\s+to\s+the\s+fact\s+that\b/gi, "because"],
    [/\bat\s+the\s+present\s+time\b/gi, "currently"],
    // Subject-verb agreement
    [/\beveryone\s+are\b/gi, "everyone is"],
    [/\bsomeone\s+are\b/gi, "someone is"],
    // Duplicate word removal (e.g. "the the")
    [/\b(the|and|in|of|to|is|that)\s+\1\b/gi, "$1"],
    // Punctuation & spacing
    [/\s+([,.:;?!])/g, "$1"],
    [/([,.:;?!])([A-Za-z])/g, "$1 $2"],
    [/\s{2,}/g, " "]
  ];

  for (const [pattern, repl] of rules) {
    t = t.replace(pattern, repl);
  }

  // Capitalize the first letter of every sentence
  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase());

  return t.trim();
};

// (Form-specific hardcoded synthesis removed — the summarizer now works correctly for any document type)

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
      // Ensure sentence ends with punctuation
      let trimmed = restored.trim();
      if (trimmed && !/[.!?]$/.test(trimmed)) trimmed += ".";
      // Apply grammar polish to every extracted sentence
      return fixGrammarAndHomophones(trimmed);
    })
    .filter((s) => {
      const words = s.split(/\s+/).filter(Boolean);
      const letters = (s.match(/[A-Za-z]/g) || []).length;
      return words.length >= 4 && letters >= 15;
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

const extractKeywords = (text, maxTags = 5) => {
  const frequency = getWordFrequency(text);

  return Object.entries(frequency)
    .sort((a, b) => b[1] - a[1])
    .filter(([word]) => word.length > 3 && !STOP_WORDS.has(word))
    .slice(0, maxTags)
    .map(([word]) => word.charAt(0).toUpperCase() + word.slice(1));
};

const generateImprovementSuggestions = (keyPoints, keywords, originalText) => {
  const suggestions = [];
  if (!originalText) return suggestions;

  const words = originalText.trim().split(/\s+/).filter(Boolean);
  const totalWords = words.length;
  const sentences = getSentences(originalText);
  const avgSentenceLength = Math.round(totalWords / Math.max(sentences.length, 1));

  if (avgSentenceLength > 28) {
    suggestions.push(
      "Sentence Complexity: This document averages " + avgSentenceLength + " words per sentence. " +
      "Consider breaking lengthy sentences into shorter, focused statements to enhance readability."
    );
  } else if (avgSentenceLength < 10 && totalWords > 100) {
    suggestions.push(
      "Flow & Transitions: Sentences are quite brief. Adding transitional phrases such as " +
      "'Consequently' or 'Furthermore' will strengthen narrative cohesion between ideas."
    );
  } else {
    suggestions.push(
      "Readability: Sentence length is well-balanced (" + avgSentenceLength + " words/sentence), " +
      "providing a comfortable and engaging reading pace."
    );
  }

  if (originalText.includes(":") || originalText.includes("•")) {
    suggestions.push(
      "Structure: Good use of lists or section dividers. Ensure each section heading clearly " +
      "signals the topic covered below it for maximum clarity."
    );
  } else if (totalWords > 300) {
    suggestions.push(
      "Document Structure: Adding bullet points, bold key terms, or section headers would make " +
      "key insights easier to scan, especially for executive or summary review."
    );
  }

  if (keywords && keywords.length > 0) {
    suggestions.push(
      "Core Themes: The primary focus areas are — " + keywords.slice(0, 3).join(", ") + ". " +
      "Ensure your conclusion directly addresses each of these themes for a strong, unified narrative."
    );
  }

  return suggestions;
};

const createInBrowserSummary = (
  text,
  length = "medium",
  tone = "standard"
) => {
  const cleaned = cleanExtractedText(text);

  if (!cleaned) {
    return {
      summary: "",
      keyPoints: [],
      keywords: []
    };
  }

  const sentences = getSentences(cleaned);

  if (!sentences.length) {
    const fallback = fixGrammarAndHomophones(cleaned);
    return {
      summary: fallback,
      keyPoints: [fallback],
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

    // Positional bias
    if (index === 0) score += 1.5;
    if (index === 1) score += 0.8;
    if (index === sentences.length - 1) score += 1.2;

    if (importantPatterns.some((p) => p.test(sentence))) score += 1.3;

    // Sentence length suitability
    const wc = sentence.split(/\s+/).length;
    if (wc >= 10 && wc <= 35) score += 0.6;
    if (wc > 50) score -= 0.4;
    if (wc < 6) score -= 0.5;

    return { text: sentence, index, score };
  });

  const documentWordCount = cleaned.split(/\s+/).length;

  let summaryTarget = 3;
  let keyPointTarget = 4;

  if (length === "short") {
    summaryTarget = documentWordCount < 400 ? 2 : documentWordCount < 1500 ? 3 : 4;
    keyPointTarget = 3;
  } else if (length === "long") {
    summaryTarget = documentWordCount < 400 ? 4 : documentWordCount < 1500 ? 7 : 10;
    keyPointTarget = 6;
  } else {
    summaryTarget = documentWordCount < 400 ? 3 : documentWordCount < 1500 ? 5 : 7;
    keyPointTarget = 4;
  }

  summaryTarget = Math.min(summaryTarget, sentences.length);

  const ranked = [...scored].sort((a, b) => b.score - a.score);

  // Maximum Marginal Relevance: pick diverse, high-scoring sentences
  const selected = [];
  for (const candidate of ranked) {
    const isDup = selected.some(
      (existing) => sentenceSimilarity(candidate, existing) > 0.52
    );
    if (!isDup) selected.push(candidate);
    if (selected.length >= summaryTarget) break;
  }

  // Restore natural reading order
  selected.sort((a, b) => a.index - b.index);

  let summary = selected.map((item) => item.text).join(" ");
  summary = fixGrammarAndHomophones(summary);

  if (tone === "bullet") {
    summary = selected.map((item) => `• ${item.text}`).join("\n\n");
  }

  // Generate key takeaways with MMR diversity
  const keyPoints = [];
  for (const candidate of ranked) {
    const isDup = keyPoints.some(
      (existing) => sentenceSimilarity(candidate.text, existing) > 0.42
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

const extractTextFromPDF = async (file, setProgress) => {
  const buffer = await file.arrayBuffer();
  const pdf = await getDocument({ data: buffer }).promise;

  let fullText = "";

  for (
    let pageNumber = 1;
    pageNumber <= pdf.numPages;
    pageNumber++
  ) {
    setProgress(
      `Parsing PDF page ${pageNumber} of ${pdf.numPages}...`
    );

    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    const items = content.items
      .map((item) => {
        const transform = item.transform || [];

        return {
          text: item.str || "",
          x: transform[4] || 0,
          y: transform[5] || 0,
          angle:
            Math.atan2(
              transform[1] || 0,
              transform[0] || 1
            ) *
            (180 / Math.PI)
        };
      })
      .filter((item) => {
        if (!item.text.trim()) return false;
        if (Math.abs(item.angle) > 45) return false;
        if (item.y > viewport.height * 0.95) return false;
        if (item.y < viewport.height * 0.05) return false;

        return true;
      });

    items.sort((a, b) =>
      Math.abs(a.y - b.y) > 4
        ? b.y - a.y
        : a.x - b.x
    );

    const lines = [];

    items.forEach((item) => {
      const last = lines[lines.length - 1];

      if (last && Math.abs(last.y - item.y) <= 4) {
        last.items.push(item);
      } else {
        lines.push({
          y: item.y,
          items: [item]
        });
      }
    });

    const pageLines = lines.map((line) =>
      line.items
        .sort((a, b) => a.x - b.x)
        .map((item) => item.text)
        .join(" ")
    );

    fullText += pageLines.join("\n") + "\n";
  }

  return {
    text: fullText,
    pdf
  };
};

const ocrScannedPDF = async (pdf, setProgress) => {
  const worker = await createWorker("eng");

  let fullText = "";

  for (
    let pageNumber = 1;
    pageNumber <= pdf.numPages;
    pageNumber++
  ) {
    setProgress(
      `OCR optical recognition on page ${pageNumber} of ${pdf.numPages}...`
    );

    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 2 });

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({
      canvasContext: context,
      viewport
    }).promise;

    const {
      data: { text }
    } = await worker.recognize(canvas);

    fullText += text + "\n";
  }

  await worker.terminate();

  return fullText;
};

const extractTextFromImage = async (file, setProgress) => {
  setProgress(
    "Scanning image with Tesseract OCR engine..."
  );

  const worker = await createWorker("eng");

  const {
    data: { text }
  } = await worker.recognize(file);

  await worker.terminate();

  return text;
};

const extractTextFromWord = async (file, setProgress) => {
  setProgress(
    "Parsing DOCX Word document structure..."
  );

  const buffer = await file.arrayBuffer();

  const result = await mammoth.extractRawText({
    arrayBuffer: buffer
  });

  return result.value;
};

const extractTextFromPowerPoint = async (
  file,
  setProgress
) => {
  setProgress(
    "Extracting slides from PowerPoint presentation..."
  );

  const buffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buffer);

  const slides = Object.keys(zip.files)
    .filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/i.test(name)
    )
    .sort((a, b) => {
      const first = Number(
        a.match(/slide(\d+)/i)?.[1] || 0
      );

      const second = Number(
        b.match(/slide(\d+)/i)?.[1] || 0
      );

      return first - second;
    });

  let fullText = "";

  for (let i = 0; i < slides.length; i++) {
    setProgress(
      `Extracting slide ${i + 1} of ${slides.length}...`
    );

    const xml = await zip.files[
      slides[i]
    ].async("text");

    const parser = new DOMParser();

    const xmlDocument = parser.parseFromString(
      xml,
      "application/xml"
    );

    const textNodes = Array.from(
      xmlDocument.getElementsByTagName("a:t")
    );

    const slideText = textNodes
      .map((node) => node.textContent)
      .join(" ");

    if (slideText.trim()) {
      fullText += slideText + "\n";
    }
  }

  return fullText;
};

function App() {
  const [theme, setTheme] = useState(
    () =>
      localStorage.getItem("docubrief_theme") ||
      "dark"
  );

  const [activeTab, setActiveTab] =
    useState("upload");

  const [engine, setEngine] =
    useState("client");

  const [file, setFile] = useState(null);
  const [inputText, setInputText] = useState("");

  const [summaryLength, setSummaryLength] =
    useState("medium");

  const [summaryTone, setSummaryTone] =
    useState("standard");

  const [summary, setSummary] = useState("");
  const [keyPoints, setKeyPoints] = useState([]);
  const [keywords, setKeywords] = useState([]);
  const [improvements, setImprovements] =
    useState([]);

  const [rawExtractedText, setRawExtractedText] =
    useState("");

  const [showRawModal, setShowRawModal] =
    useState(false);

  const [isDragging, setIsDragging] =
    useState(false);

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  const [metrics, setMetrics] = useState(null);

  const [toasts, setToasts] = useState([]);

  const [history, setHistory] = useState(() => {
    try {
      return JSON.parse(
        localStorage.getItem(
          "docubrief_history"
        ) || "[]"
      );
    } catch {
      return [];
    }
  });

  const [showHistoryModal, setShowHistoryModal] =
    useState(false);

  const [isPlayingAudio, setIsPlayingAudio] =
    useState(false);

  const [speechRate, setSpeechRate] =
    useState(1);

  const synthRef = useRef(
    window.speechSynthesis || null
  );

  const utteranceRef = useRef(null);

  useEffect(() => {
    document.documentElement.setAttribute(
      "data-theme",
      theme
    );

    localStorage.setItem(
      "docubrief_theme",
      theme
    );
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "docubrief_history",
        JSON.stringify(history.slice(0, 15))
      );
    } catch (e) {
      console.error(e);
    }
  }, [history]);

  const showToast = (
    message,
    type = "success"
  ) => {
    const id = Date.now();

    setToasts((prev) => [
      ...prev,
      {
        id,
        message,
        type
      }
    ]);

    setTimeout(() => {
      setToasts((prev) =>
        prev.filter((t) => t.id !== id)
      );
    }, 3200);
  };

  const toggleTheme = () => {
    setTheme((prev) =>
      prev === "dark" ? "light" : "dark"
    );
  };

  const handleFile = (selectedFile) => {
    if (!selectedFile) return;

    const ext = selectedFile.name
      .split(".")
      .pop()
      .toLowerCase();

    const allowed = [
      "pdf",
      "png",
      "jpg",
      "jpeg",
      "webp",
      "docx",
      "pptx",
      "txt",
      "md"
    ];

    if (!allowed.includes(ext)) {
      setError(
        "Unsupported format. Please upload PDF, PNG, JPG, WEBP, DOCX, PPTX, or TXT."
      );

      showToast(
        "Unsupported file format",
        "error"
      );

      return;
    }

    setFile(selectedFile);
    setError("");
    setProgress("");

    showToast(
      `Loaded ${selectedFile.name}`
    );
  };

  const computeMetrics = (
    originalText,
    summaryText
  ) => {
    const origWords = originalText
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;

    const summWords = summaryText
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;

    const reductionPercent =
      origWords > 0
        ? Math.max(
          0,
          Math.round(
            ((origWords - summWords) /
              origWords) *
            100
          )
        )
        : 0;

    const originalReadMinutes = (
      origWords / 200
    ).toFixed(1);

    const summaryReadMinutes = (
      summWords / 200
    ).toFixed(1);

    const timeSavedMinutes = Math.max(
      0,
      originalReadMinutes -
      summaryReadMinutes
    ).toFixed(1);

    return {
      originalWords: origWords,
      summaryWords: summWords,
      reductionPercent,
      timeSavedMinutes:
        timeSavedMinutes > 0
          ? `${timeSavedMinutes} mins`
          : "< 1 min"
    };
  };

  const handleGenerate = async () => {
    let sourceText = "";

    setError("");
    setProgress("");

    if (activeTab === "upload") {
      if (!file) {
        setError(
          "Please upload a document to analyze."
        );
        return;
      }
    } else {
      if (!inputText.trim()) {
        setError(
          "Please enter or paste document text."
        );
        return;
      }

      sourceText = inputText;
    }

    setLoading(true);
    setSummary("");
    setKeyPoints([]);
    setKeywords([]);
    setImprovements([]);
    setRawExtractedText("");

    try {
      if (activeTab === "upload") {
        const ext = file.name
          .split(".")
          .pop()
          .toLowerCase();

        if (ext === "pdf") {
          const result =
            await extractTextFromPDF(
              file,
              setProgress
            );

          sourceText = result.text;

          const cleanedPreview =
            cleanExtractedText(
              sourceText
            );

          if (
            cleanedPreview.replace(
              /\s/g,
              ""
            ).length < 60
          ) {
            setProgress(
              "Scanned PDF detected. Running OCR image recognition..."
            );

            sourceText =
              await ocrScannedPDF(
                result.pdf,
                setProgress
              );
          }
        } else if (
          [
            "png",
            "jpg",
            "jpeg",
            "webp"
          ].includes(ext)
        ) {
          sourceText =
            await extractTextFromImage(
              file,
              setProgress
            );
        } else if (ext === "docx") {
          sourceText =
            await extractTextFromWord(
              file,
              setProgress
            );
        } else if (ext === "pptx") {
          sourceText =
            await extractTextFromPowerPoint(
              file,
              setProgress
            );
        } else if (
          ["txt", "md"].includes(ext)
        ) {
          sourceText =
            await file.text();
        }
      }

      if (
        !sourceText ||
        !sourceText.trim()
      ) {
        throw new Error(
          "No readable text could be extracted from this source."
        );
      }

      setRawExtractedText(sourceText);

      setProgress(
        "Analyzing semantics and distilling key insights..."
      );

      let finalSummary = "";
      let finalKeyPoints = [];

      let finalKeywords =
        extractKeywords(
          sourceText,
          6
        );

      if (engine === "ai") {
        setProgress(
          "Connecting to AI Deep Summary Engine..."
        );

        try {
          /*
           * IMPORTANT:
           * This now calls your deployed FastAPI backend
           * instead of the old /api/summarize endpoint.
           */
          const apiRes = await fetch(
            "https://document-summary-assistant-ekuy.onrender.com/api/summarize",
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body: JSON.stringify({
                text: sourceText.slice(
                  0,
                  50000
                ),
                length: summaryLength
              })
            }
          );

          if (apiRes.ok) {
            const data =
              await apiRes.json();

            finalSummary =
              data.summary;

            finalKeyPoints =
              data.key_points || [];
          } else {
            console.warn(
              "AI API unavailable, falling back to instant client engine"
            );

            showToast(
              "AI server unavailable — used instant in-browser engine instead",
              "error"
            );

            const fallback =
              createInBrowserSummary(
                sourceText,
                summaryLength,
                summaryTone
              );

            finalSummary =
              fallback.summary;

            finalKeyPoints =
              fallback.keyPoints;

            finalKeywords =
              fallback.keywords;
          }
        } catch (apiErr) {
          console.warn(
            "AI server error, fallback to client engine",
            apiErr
          );

          const fallback =
            createInBrowserSummary(
              sourceText,
              summaryLength,
              summaryTone
            );

          finalSummary =
            fallback.summary;

          finalKeyPoints =
            fallback.keyPoints;

          finalKeywords =
            fallback.keywords;
        }
      } else {
        const result =
          createInBrowserSummary(
            sourceText,
            summaryLength,
            summaryTone
          );

        finalSummary =
          result.summary;

        finalKeyPoints =
          result.keyPoints;

        finalKeywords =
          result.keywords;
      }

      if (!finalSummary) {
        throw new Error(
          "Unable to synthesize a meaningful summary from the text."
        );
      }

      setSummary(finalSummary);
      setKeyPoints(finalKeyPoints);
      setKeywords(finalKeywords);

      const suggestions =
        generateImprovementSuggestions(
          finalKeyPoints,
          finalKeywords,
          sourceText
        );

      setImprovements(
        suggestions
      );

      const computed =
        computeMetrics(
          sourceText,
          finalSummary
        );

      setMetrics(computed);

      const historyItem = {
        id: Date.now(),

        title:
          activeTab === "upload"
            ? file.name
            : "Pasted Text Analysis",

        timestamp:
          new Date().toLocaleTimeString(
            [],
            {
              hour: "2-digit",
              minute: "2-digit"
            }
          ),

        summary: finalSummary,

        keyPoints:
          finalKeyPoints,

        metrics: computed,

        keywords:
          finalKeywords
      };

      setHistory((prev) => [
        historyItem,
        ...prev.slice(0, 14)
      ]);

      showToast(
        "Summary generated ✨"
      );
    } catch (err) {
      console.error(err);

      setError(
        err.message ||
        "Failed to process the document."
      );

      showToast(
        "Error processing document",
        "error"
      );
    } finally {
      setLoading(false);
      setProgress("");
    }
  };

  const handleCopy = (
    textToCopy,
    label = "Summary"
  ) => {
    if (!textToCopy) return;

    navigator.clipboard.writeText(
      textToCopy
    );

    showToast(
      `${label} copied to clipboard! 📋`
    );
  };

  const exportTXT = () => {
    if (!summary) return;

    const docTitle =
      activeTab === "upload"
        ? file?.name || "Document"
        : "Text-Summary";

    const content = `=====================================================
DOCUMENT SUMMARY ASSISTANT • SUMMARY REPORT
Document: ${docTitle}
Generated: ${new Date().toLocaleString()}
Compression: ${metrics?.reductionPercent || 0}% reduction
=====================================================

SUMMARY:
-----------------------------------------------------
${summary}

KEY TAKEAWAYS:
-----------------------------------------------------
${keyPoints
        .map(
          (pt, i) =>
            `${i + 1}. ${pt}`
        )
        .join("\n\n")}

TOP TOPICS:
-----------------------------------------------------
${keywords.join(", ")}
`;

    const blob = new Blob(
      [content],
      {
        type: "text/plain"
      }
    );

    const url =
      URL.createObjectURL(blob);

    const a =
      document.createElement("a");

    a.href = url;

    a.download = `${docTitle.replace(
      /\.[^/.]+$/,
      ""
    )}-summary.txt`;

    a.click();

    URL.revokeObjectURL(url);

    showToast(
      "Downloaded .txt report"
    );
  };

  const exportMD = () => {
    if (!summary) return;

    const docTitle =
      activeTab === "upload"
        ? file?.name || "Document"
        : "Text-Summary";

    const content = `# Document Summary: ${docTitle}

> **Generated with Document Summary Assistant** • ${new Date().toLocaleDateString()}
> **Stats**: ${metrics?.originalWords || 0} words reduced to ${metrics?.summaryWords || 0} words (${metrics?.reductionPercent || 0}% compression)

---

## 📌 Executive Summary
${summary}

---

## 🎯 Key Takeaways & Core Points
${keyPoints
        .map((pt) => `- ${pt}`)
        .join("\n")}

---

### 🏷️ Topic Tags
${keywords
        .map((k) => `\`${k}\``)
        .join(" ")}
`;

    const blob = new Blob(
      [content],
      {
        type: "text/markdown"
      }
    );

    const url =
      URL.createObjectURL(blob);

    const a =
      document.createElement("a");

    a.href = url;

    a.download = `${docTitle.replace(
      /\.[^/.]+$/,
      ""
    )}-summary.md`;

    a.click();

    URL.revokeObjectURL(url);

    showToast(
      "Downloaded .md Markdown report"
    );
  };

  const toggleSpeech = () => {
    if (
      !synthRef.current ||
      !summary
    ) {
      return;
    }

    if (isPlayingAudio) {
      synthRef.current.cancel();
      setIsPlayingAudio(false);
      return;
    }

    synthRef.current.cancel();

    const cleanSpeechText =
      summary
        .replace(/•/g, "")
        .replace(/\n+/g, " ");

    const utterance =
      new SpeechSynthesisUtterance(
        cleanSpeechText
      );

    utterance.rate =
      speechRate;

    utterance.pitch = 1.0;

    utterance.onend = () =>
      setIsPlayingAudio(false);

    utterance.onerror = () =>
      setIsPlayingAudio(false);

    utteranceRef.current =
      utterance;

    synthRef.current.speak(
      utterance
    );

    setIsPlayingAudio(true);
  };

  const changeSpeechSpeed = (
    rate
  ) => {
    setSpeechRate(rate);

    if (
      isPlayingAudio &&
      synthRef.current
    ) {
      synthRef.current.cancel();

      setIsPlayingAudio(false);

      showToast(
        `Speech rate set to ${rate}x`
      );
    }
  };

  const loadSample = (type) => {
    if (SAMPLE_DOCS[type]) {
      setInputText(
        SAMPLE_DOCS[type]
      );

      setActiveTab("text");

      showToast(
        `Loaded ${type.toUpperCase()} sample`
      );
    }
  };

  const loadHistoryItem = (
    item
  ) => {
    setSummary(item.summary);
    setKeyPoints(
      item.keyPoints || []
    );
    setMetrics(
      item.metrics || null
    );
    setKeywords(
      item.keywords || []
    );

    setShowHistoryModal(
      false
    );

    showToast(
      `Restored: ${item.title}`
    );
  };

  const deleteHistoryItem = (
    e,
    id
  ) => {
    e.stopPropagation();

    setHistory((prev) =>
      prev.filter(
        (item) => item.id !== id
      )
    );

    showToast(
      "Item removed from history"
    );
  };

  const generateImprovementSuggestions = (
    points,
    tags,
    text
  ) => {
    const suggestions = [];

    const wordCount =
      text
        .trim()
        .split(/\s+/).length;

    const sentenceCount =
      text
        .split(/[.!?]+/)
        .filter(Boolean)
        .length;

    const avgWordsPerSentence =
      sentenceCount > 0
        ? Math.round(
          wordCount /
          sentenceCount
        )
        : 0;

    if (
      avgWordsPerSentence > 25
    ) {
      suggestions.push(
        "✂️ Sentences are quite long (avg " +
        avgWordsPerSentence +
        " words). Consider breaking them into shorter, clearer statements."
      );
    }

    if (wordCount > 3000) {
      suggestions.push(
        "📋 The document is lengthy. Adding an executive summary or table of contents at the top would improve navigation."
      );
    }

    if (points.length <= 2) {
      suggestions.push(
        "📌 Only a few key points were found. Adding clear headings and distinct sections can improve overall structure."
      );
    }

    if (points.length >= 8) {
      suggestions.push(
        "🗂️ Many key points detected. Grouping related points under themed sub-sections can improve clarity."
      );
    }

    if (tags.length < 3) {
      suggestions.push(
        "🏷️ Limited topic coverage detected. Expanding on specific topics or adding data/examples will enrich the content."
      );
    }

    const hasNumbers =
      /\b\d+(\.\d+)?(%|x|\+)?\b/.test(
        text
      );

    if (!hasNumbers) {
      suggestions.push(
        "📊 No quantitative data found. Including metrics, statistics, or measurable outcomes strengthens credibility."
      );
    }

    const passiveCount =
      (
        text.match(
          /\b(is|are|was|were|been|being)\s+\w+ed\b/gi
        ) || []
      ).length;

    if (passiveCount > 5) {
      suggestions.push(
        "🖊️ Several passive voice constructions detected. Using active voice makes writing more direct and engaging."
      );
    }

    const hasConclusion =
      /\b(conclusion|summary|in summary|to summarize|finally|in conclusion)\b/i.test(
        text
      );

    if (
      !hasConclusion &&
      wordCount > 300
    ) {
      suggestions.push(
        "🎯 No concluding section found. Adding a conclusion or key takeaway section gives readers a clear finish."
      );
    }

    if (
      suggestions.length === 0
    ) {
      suggestions.push(
        "✅ The document is well-structured with clear points and good topic coverage."
      );

      suggestions.push(
        "💡 Consider adding visual aids (charts, diagrams) to complement the written content."
      );
    }

    return suggestions.slice(0, 5);
  };

  return (
    <div className="app-wrapper">
      <nav className="navbar">
        <div className="navbar-container">
          <div
            className="brand"
            onClick={() =>
              window.scrollTo({
                top: 0,
                behavior: "smooth"
              })
            }
          >
            <div className="brand-icon-wrapper">
              <span className="brand-icon">
                📄
              </span>
            </div>

            <div>
              <span className="brand-title">
                Document Summary Assistant
              </span>

              <span
                className="brand-badge"
                style={{
                  marginLeft: "8px"
                }}
              >
                AI
              </span>
            </div>
          </div>

          <div className="nav-actions">
            <button
              className="nav-btn"
              onClick={() =>
                setShowHistoryModal(
                  true
                )
              }
              title="Recent Summaries"
            >
              🕒 History{" "}
              {history.length > 0 && (
                <span className="nav-badge-count">
                  {history.length}
                </span>
              )}
            </button>

            <button
              className="theme-toggle-btn"
              onClick={toggleTheme}
              title={`Switch to ${theme === "dark"
                ? "Light"
                : "Dark"
                } Mode`}
            >
              {theme === "dark"
                ? "☀️"
                : "🌙"}
            </button>
          </div>
        </div>
      </nav>

      <header className="hero-section">
        <div className="hero-pill">
          <span className="hero-pill-dot"></span>
          Intelligent Document & Text
          Summarizer
        </div>

        <h1 className="hero-title">
          <span className="hero-highlight">
            Document Summary Assistant
          </span>
        </h1>

        <p className="hero-subtitle">
          Upload a document or paste text
          to get an instant summary, key
          points, topic tags, and
          improvement suggestions.
        </p>

        <div className="supported-tags">
          <span className="tag-badge">
            📄 PDF (Scanned & Text)
          </span>

          <span className="tag-badge">
            📝 Word DOCX
          </span>

          <span className="tag-badge">
            📊 PowerPoint PPTX
          </span>

          <span className="tag-badge">
            🖼️ PNG / JPG OCR
          </span>

          <span className="tag-badge">
            ✍️ Direct Text Paste
          </span>
        </div>
      </header>

      <main className="main-content">
        <div className="grid-workspace">
          <section className="glass-card">
            <div className="tab-nav">
              <button
                className={`tab-btn ${activeTab === "upload"
                  ? "active"
                  : ""
                  }`}
                onClick={() =>
                  setActiveTab(
                    "upload"
                  )
                }
              >
                📁 Upload Document
              </button>

              <button
                className={`tab-btn ${activeTab === "text"
                  ? "active"
                  : ""
                  }`}
                onClick={() =>
                  setActiveTab("text")
                }
              >
                ✍️ Paste Text / Samples
              </button>
            </div>

            {activeTab === "upload" && (
              <div>
                {!file ? (
                  <div
                    className={`dropzone ${isDragging
                      ? "drag-active"
                      : ""
                      }`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setIsDragging(
                        true
                      );
                    }}
                    onDragLeave={() =>
                      setIsDragging(
                        false
                      )
                    }
                    onDrop={(e) => {
                      e.preventDefault();
                      setIsDragging(
                        false
                      );

                      handleFile(
                        e.dataTransfer
                          .files[0]
                      );
                    }}
                  >
                    <div className="dropzone-icon-box">
                      📂
                    </div>

                    <h3 className="dropzone-title">
                      Drag & drop your
                      file here
                    </h3>

                    <p className="dropzone-desc">
                      Supports PDF, DOCX,
                      PPTX, PNG, JPG,
                      WEBP, and TXT files
                    </p>

                    <label className="browse-button">
                      Browse Files

                      <input
                        type="file"
                        style={{
                          display: "none"
                        }}
                        accept=".pdf,.docx,.pptx,.png,.jpg,.jpeg,.webp,.txt,.md"
                        onChange={(e) =>
                          handleFile(
                            e.target
                              .files[0]
                          )
                        }
                      />
                    </label>

                    <div className="dropzone-formats">
                      PDF • DOCX • PPTX •
                      PNG • JPG • WEBP •
                      TXT
                    </div>
                  </div>
                ) : (
                  <div className="file-preview-card">
                    <div className="file-preview-info">
                      <div className="file-type-icon">
                        {file.name.endsWith(
                          ".pdf"
                        )
                          ? "📕"
                          : file.name.endsWith(
                            ".docx"
                          )
                            ? "📘"
                            : file.name.endsWith(
                              ".pptx"
                            )
                              ? "📙"
                              : "🖼️"}
                      </div>

                      <div className="file-preview-meta">
                        <strong>
                          {file.name}
                        </strong>

                        <span>
                          {(
                            file.size /
                            1024 /
                            1024
                          ).toFixed(2)}{" "}
                          MB • Ready to
                          analyze
                        </span>
                      </div>
                    </div>

                    <button
                      className="remove-file-btn"
                      onClick={() =>
                        setFile(null)
                      }
                    >
                      ✕ Remove
                    </button>
                  </div>
                )}
              </div>
            )}

            {activeTab === "text" && (
              <div className="text-input-wrapper">
                <div className="text-sample-bar">
                  <span className="sample-label">
                    Try instant samples:
                  </span>

                  <button
                    className="sample-pill"
                    onClick={() =>
                      loadSample("ai")
                    }
                  >
                    🤖 AI & Tech
                  </button>

                  <button
                    className="sample-pill"
                    onClick={() =>
                      loadSample(
                        "business"
                      )
                    }
                  >
                    📈 Business Strategy
                  </button>

                  <button
                    className="sample-pill"
                    onClick={() =>
                      loadSample(
                        "science"
                      )
                    }
                  >
                    🔬 Materials Science
                  </button>
                </div>

                <textarea
                  className="textarea-box"
                  placeholder="Paste or type raw article, research paper, meeting notes, or book excerpt here..."
                  value={inputText}
                  onChange={(e) =>
                    setInputText(
                      e.target.value
                    )
                  }
                />

                <div className="textarea-footer">
                  <span>
                    {
                      inputText
                        .trim()
                        .split(/\s+/)
                        .filter(Boolean)
                        .length
                    }{" "}
                    words •{" "}
                    {inputText.length} chars
                  </span>

                  {inputText && (
                    <button
                      className="clear-text-btn"
                      onClick={() =>
                        setInputText("")
                      }
                    >
                      Clear Text
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="controls-grid">
              <div>
                <div className="control-group-title">
                  🎯 Summary Length
                </div>

                <div className="length-selector">
                  {[
                    {
                      id: "short",
                      name: "Short",
                      desc: "CRISP"
                    },
                    {
                      id: "medium",
                      name: "Medium",
                      desc: "Balanced core"
                    },
                    {
                      id: "long",
                      name: "In-Depth",
                      desc: "Full breakdown"
                    }
                  ].map((opt) => (
                    <div
                      key={opt.id}
                      className={`length-option-card ${summaryLength ===
                        opt.id
                        ? "active"
                        : ""
                        }`}
                      onClick={() =>
                        setSummaryLength(
                          opt.id
                        )
                      }
                    >
                      <strong className="length-name">
                        {opt.name}
                      </strong>

                      <span className="length-desc">
                        {opt.desc}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="control-group-title">
                  ⚙️ Engine & Format
                </div>

                <div className="option-select-row">
                  <div
                    className={`engine-chip ${engine === "client"
                      ? "active"
                      : ""
                      }`}
                    onClick={() =>
                      setEngine("client")
                    }
                  >
                    <strong>
                      ⚡ In-Browser Fast
                    </strong>

                    <span>
                      100% Private & Instant
                    </span>
                  </div>

                  <div
                    className={`engine-chip ${engine === "ai"
                      ? "active"
                      : ""
                      }`}
                    onClick={() =>
                      setEngine("ai")
                    }
                  >
                    <strong>
                      🤖 AI Deep Mode
                    </strong>

                    <span>
                      Cloud AI Synthesis
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {loading && progress && (
              <div className="progress-card">
                <div className="progress-spinner"></div>

                <div className="progress-text">
                  {progress}
                </div>
              </div>
            )}

            {error && (
              <div className="error-banner">
                ⚠️ {error}
              </div>
            )}

            <div className="action-bar">
              <button
                className="btn-generate"
                onClick={
                  handleGenerate
                }
                disabled={
                  loading ||
                  (activeTab ===
                    "upload" &&
                    !file) ||
                  (activeTab ===
                    "text" &&
                    !inputText.trim())
                }
              >
                {loading
                  ? "⏳ Processing & Analyzing..."
                  : "✨ Generate Summary & Insights"}
              </button>
            </div>
          </section>

          {summary && (
            <div className="results-section">
              {metrics && (
                <div className="metrics-row">
                  <div className="metric-chip">
                    <span className="metric-label">
                      Original Length
                    </span>

                    <span className="metric-value">
                      {
                        metrics.originalWords
                      }
                    </span>

                    <span className="metric-sub">
                      Words in document
                    </span>
                  </div>

                  <div className="metric-chip">
                    <span className="metric-label">
                      Summary Length
                    </span>

                    <span className="metric-value">
                      {
                        metrics.summaryWords
                      }
                    </span>

                    <span className="metric-sub">
                      Words distilled
                    </span>
                  </div>

                  <div className="metric-chip">
                    <span className="metric-label">
                      Reduction
                    </span>

                    <span
                      className="metric-value"
                      style={{
                        color:
                          "var(--accent-cyan)"
                      }}
                    >
                      {
                        metrics.reductionPercent
                      }
                      %
                    </span>

                    <span className="metric-sub">
                      Compression ratio
                    </span>
                  </div>

                  <div className="metric-chip">
                    <span className="metric-label">
                      Reading Time
                      Saved
                    </span>

                    <span
                      className="metric-value"
                      style={{
                        color:
                          "var(--accent-emerald)"
                      }}
                    >
                      {
                        metrics.timeSavedMinutes
                      }
                    </span>

                    <span className="metric-sub">
                      Estimated time
                      saved
                    </span>
                  </div>
                </div>
              )}

              <div className="audio-player-card">
                <div className="audio-left">
                  <button
                    className="btn-audio-play"
                    onClick={
                      toggleSpeech
                    }
                    title="Listen to Summary"
                  >
                    {isPlayingAudio
                      ? "⏸"
                      : "🔊"}
                  </button>

                  <div className="audio-status-group">
                    <strong>
                      {isPlayingAudio
                        ? "Playing Audio Narration..."
                        : "Text-to-Speech Player"}
                    </strong>

                    <span>
                      {isPlayingAudio
                        ? "Click to pause speech"
                        : "Listen to this summary aloud"}
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
                  <span
                    style={{
                      fontSize: "11px",
                      color:
                        "var(--text-muted)",
                      fontWeight: "600"
                    }}
                  >
                    SPEED:
                  </span>

                  {[0.75, 1, 1.25, 1.5].map(
                    (speed) => (
                      <button
                        key={speed}
                        className={`speed-chip ${speechRate ===
                          speed
                          ? "active"
                          : ""
                          }`}
                        onClick={() =>
                          changeSpeechSpeed(
                            speed
                          )
                        }
                      >
                        {speed}x
                      </button>
                    )
                  )}
                </div>
              </div>

              <section className="glass-card">
                <div className="card-header-row">
                  <div className="card-title-group">
                    <span className="card-icon">
                      📌
                    </span>

                    <div>
                      <h2 className="card-title">
                        Executive Summary
                      </h2>

                      <span className="card-subtitle">
                        Synthesized overview
                        and context
                      </span>
                    </div>
                  </div>

                  <div className="result-toolbar">
                    <div className="result-btn-group">
                      <button
                        className="action-btn"
                        onClick={() =>
                          handleCopy(
                            summary,
                            "Summary"
                          )
                        }
                      >
                        📋 Copy
                      </button>

                      <button
                        className="action-btn"
                        onClick={
                          exportTXT
                        }
                      >
                        ⬇ .txt
                      </button>

                      <button
                        className="action-btn"
                        onClick={
                          exportMD
                        }
                      >
                        📝 .md
                      </button>

                      <button
                        className="action-btn"
                        onClick={() =>
                          window.print()
                        }
                      >
                        🖨️ Print
                      </button>

                      {rawExtractedText && (
                        <button
                          className="action-btn"
                          onClick={() =>
                            setShowRawModal(
                              !showRawModal
                            )
                          }
                        >
                          🔍{" "}
                          {showRawModal
                            ? "Hide Raw"
                            : "View Raw"}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="summary-body">
                  {summary}
                </div>

                {keywords.length > 0 && (
                  <div className="topics-row">
                    <span className="topic-label">
                      Key Topics:
                    </span>

                    {keywords.map(
                      (tag, i) => (
                        <span
                          key={i}
                          className="topic-tag"
                        >
                          #{tag}
                        </span>
                      )
                    )}
                  </div>
                )}

                {showRawModal &&
                  rawExtractedText && (
                    <div className="raw-text-card">
                      <strong
                        style={{
                          fontSize:
                            "13px",
                          display:
                            "block",
                          marginBottom:
                            "8px"
                        }}
                      >
                        Extracted Text from
                        Parser / OCR:
                      </strong>

                      <div className="raw-text-box">
                        {
                          rawExtractedText
                        }
                      </div>
                    </div>
                  )}
              </section>

              {keyPoints.length > 0 && (
                <section className="glass-card">
                  <div className="card-header-row">
                    <div className="card-title-group">
                      <span className="card-icon">
                        🎯
                      </span>

                      <div>
                        <h2 className="card-title">
                          Key Takeaways
                        </h2>

                        <span className="card-subtitle">
                          Critical facts,
                          decisions, and
                          conclusions
                        </span>
                      </div>
                    </div>

                    <button
                      className="action-btn"
                      onClick={() =>
                        handleCopy(
                          keyPoints
                            .map(
                              (
                                pt,
                                i
                              ) =>
                                `${i + 1
                                }. ${pt}`
                            )
                            .join(
                              "\n\n"
                            ),
                          "Key Points"
                        )
                      }
                    >
                      📋 Copy All Points
                    </button>
                  </div>

                  <div className="keypoints-list">
                    {keyPoints.map(
                      (
                        point,
                        index
                      ) => (
                        <div
                          key={index}
                          className="keypoint-item"
                        >
                          <span className="keypoint-index">
                            {index + 1}
                          </span>

                          <p className="keypoint-text">
                            {point}
                          </p>

                          <button
                            className="keypoint-copy"
                            title="Copy this point"
                            onClick={() =>
                              handleCopy(
                                point,
                                `Point ${index +
                                1
                                }`
                              )
                            }
                          >
                            📋
                          </button>
                        </div>
                      )
                    )}
                  </div>
                </section>
              )}

              {improvements.length > 0 && (
                <section className="glass-card improvement-card">
                  <div className="card-header-row">
                    <div className="card-title-group">
                      <span className="card-icon">
                        💡
                      </span>

                      <div>
                        <h2 className="card-title">
                          Improvement
                          Suggestions
                        </h2>

                        <span className="card-subtitle">
                          Ways to enhance
                          this document
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="improvements-list">
                    {improvements.map(
                      (
                        suggestion,
                        index
                      ) => (
                        <div
                          key={index}
                          className="improvement-item"
                        >
                          <p className="improvement-text">
                            {
                              suggestion
                            }
                          </p>
                        </div>
                      )
                    )}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </main>

      {showHistoryModal && (
        <div
          className="modal-backdrop"
          onClick={() =>
            setShowHistoryModal(
              false
            )
          }
        >
          <div
            className="modal-container"
            onClick={(e) =>
              e.stopPropagation()
            }
          >
            <div className="modal-header">
              <h3 className="modal-title">
                🕒 Recent Summaries
              </h3>

              <button
                className="modal-close-btn"
                onClick={() =>
                  setShowHistoryModal(
                    false
                  )
                }
              >
                ✕
              </button>
            </div>

            <div className="modal-body">
              {history.length === 0 ? (
                <div className="empty-history">
                  No past summaries yet.
                  Generate a summary to
                  save it here!
                </div>
              ) : (
                history.map(
                  (item) => (
                    <div
                      key={item.id}
                      className="history-item"
                      onClick={() =>
                        loadHistoryItem(
                          item
                        )
                      }
                    >
                      <div className="history-item-meta">
                        <strong>
                          {item.title}
                        </strong>

                        <span>
                          {
                            item.timestamp
                          }{" "}
                          •{" "}
                          {item.metrics
                            ?.reductionPercent ||
                            0}
                          % compression •{" "}
                          {item.keyPoints
                            ?.length ||
                            0}{" "}
                          key points
                        </span>
                      </div>

                      <div className="history-item-actions">
                        <button
                          className="history-delete-btn"
                          title="Delete from history"
                          onClick={(e) =>
                            deleteHistoryItem(
                              e,
                              item.id
                            )
                          }
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                  )
                )
              )}
            </div>
          </div>
        </div>
      )}

      <div className="toast-container">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast ${toast.type}`}
          >
            {toast.type ===
              "success"
              ? "✅"
              : "⚠️"}{" "}
            {toast.message}
          </div>
        ))}
      </div>

      <footer className="app-footer">
        <div className="footer-inner">
          <div className="footer-brand">
            Document Summary Assistant
          </div>

          <p className="footer-developer">
            Engineered with modern Web &
            NLP technologies by{" "}
            <strong>
              Lakshmana Murthy
            </strong>
          </p>

          <div className="footer-links">
            <a
              href="mailto:lakshmanamurthy.kadapala@gmail.com"
              className="footer-link"
            >
              ✉️
              {" "}
              lakshmanamurthy.kadapala@gmail.com
            </a>

            <span
              style={{
                color:
                  "var(--border-card)"
              }}
            >
              •
            </span>

            <a
              href="tel:+918179117439"
              className="footer-link"
            >
              📞 +91 8179117439
            </a>
          </div>

          <div className="footer-copy">
            © 2026 Document Summary
            Assistant. Designed for
            speed, intelligence, and
            privacy.
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
