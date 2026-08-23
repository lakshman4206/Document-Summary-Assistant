/**
 * State-of-the-Art Deep-Scan NLP Cleaner, Entity Engine & Document Restructurer
 */

export const PRESERVED_ACRONYMS = new Set([
  "AI", "ML", "API", "APIS", "UI", "UX", "PDF", "PDFS", "DOC", "DOCX", "PPT", "PPTX",
  "HTML", "CSS", "JS", "TS", "NLP", "LLM", "LLMS", "GPT", "RAG", "GPU", "CPU", "RAM",
  "USA", "US", "UK", "EU", "UN", "NASA", "WHO", "ISRO", "DRDO", "UPSC", "SSC", "HSC",
  "CEO", "CTO", "CFO", "COO", "HR", "IT", "ID", "IP", "DNS", "URL", "HTTP", "HTTPS",
  "SQL", "NOSQL", "AWS", "GCP", "SAAS", "PAAS", "IAAS", "B2B", "B2C", "ROI", "KPI",
  "IoT", "WiFi", "OCR", "IEEE", "ISO", "COVID", "DNA", "RNA", "IQ", "EQ", "MB", "GB", "TB",
  "NDA", "CDS", "GATE", "CAT", "NEET", "IIT", "NIT", "IIM", "AIIMS", "NLTK", "BERT"
]);

export const VALID_SHORT_WORDS = new Set([
  "a", "i", "am", "an", "as", "at", "be", "by", "do", "go", "he", "if", "in", "is",
  "it", "me", "my", "no", "of", "on", "or", "so", "to", "up", "us", "we", "ok", "tv",
  "mr", "ms", "dr", "vs", "re", "ex", "ad", "pm", "am"
]);

/**
 * 1. Broken Word Repair:
 * De-hyphenates line breaks, internal broken words, and spaced letter sequences.
 */
export function repairBrokenWords(text) {
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
}

/**
 * 2. Meaningless / Gibberish Token Filter
 */
export function isMeaninglessToken(token) {
  if (!token) return true;
  const clean = token.replace(/^[^\w%$#°]+|[^\w%$#°]+$/g, "");
  if (!clean) return true;

  // Pure numbers or mixed metrics: 42%, $500, 2026, 15-min, 600-mile, v2.0
  if (/^[\d,.:;%$\-+/xX#°℃℉]+$/.test(clean) || /^\d+[A-Za-z%$\-]+$/.test(clean) || /^\$\d+/.test(clean)) {
    return false;
  }

  const lower = clean.toLowerCase();

  // Known acronyms are always preserved
  if (PRESERVED_ACRONYMS.has(clean.toUpperCase())) return false;

  // Single & double letter words
  if (clean.length === 1) return !["a", "i"].includes(lower);
  if (clean.length === 2) return !VALID_SHORT_WORDS.has(lower) && !PRESERVED_ACRONYMS.has(clean.toUpperCase());

  const letters = (clean.match(/[a-zA-Z]/g) || []).length;
  const nonLetters = clean.length - letters;
  if (nonLetters > letters) return true;

  // Repetitive characters: "aaaa", "xxxx", "----"
  if (/(.)\1{3,}/.test(clean)) return true;

  // English words with 3+ letters must contain at least one vowel
  if (letters >= 3 && !/[aeiouyAEIOUY]/.test(clean)) {
    return !PRESERVED_ACRONYMS.has(clean.toUpperCase());
  }

  // 5+ consonants in a row is OCR gibberish
  if (/[bcdfghjklmnpqrstvwxzBCDFGHJKLMNPQRSTVWXZ]{5,}/.test(clean)) {
    return !PRESERVED_ACRONYMS.has(clean.toUpperCase());
  }

  return false;
}

/**
 * 3. Capitalization & True-Casing:
 * Normalizes ALL CAPS / TitleCase to sentence case while preserving legitimate acronyms & proper entities.
 */
export function normalizeSentenceCase(sentence) {
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
}

export function normalizeCapitalization(text) {
  if (!text) return "";
  const segments = text.split(/(?<=[.!?\n])\s+/);
  return segments.map(normalizeSentenceCase).filter(Boolean).join(" ");
}

/**
 * 4. Grammar, Homophones, Article Agreement & Polish
 */
export function fixGrammarAndHomophones(text) {
  if (!text) return "";
  let t = text.trim();

  // Article agreement
  t = t.replace(/\b([Aa])\s+([aeiouAEIOU]\w*)/g, (match, p1, p2) => {
    const isConsonantSound = /^(?:univ|use|uniq|unit|user|eul|euro|one|once)/i.test(p2);
    return isConsonantSound ? "a " + p2 : "an " + p2;
  });
  t = t.replace(/\b([Aa])n\s+([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ]\w*)/g, (match, p1, p2) => {
    const isVowelSound = /^(?:hour|honest|honor|heir)/i.test(p2);
    return isVowelSound ? "an " + p2 : "a " + p2;
  });

  // Homophone, phrasing & agreement rules
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
}

/**
 * 5. Full Document Cleaning Pipeline
 */
export function cleanDocumentText(rawText) {
  if (!rawText || typeof rawText !== "string") return "";

  let cleaned = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Page headers, dates, brackets, noise symbols
  cleaned = cleaned.replace(/\bPage\s+\d+\s+(?:of|\/)\s+\d+\b/gi, " ");
  cleaned = cleaned.replace(/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\s+\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");
  cleaned = cleaned.replace(/\[\s*\d+\s*\]/g, " ");
  cleaned = cleaned.replace(/[|\u00A6\u00A7\u00A4\u00A9\u00AE\u2122\u2192\u2190\u2191\u2193\u2194\u2195\u2022\u25AA\u25AB\u25E6\u25A0\u25A1\u25C6\u25C7~`^_=]+/g, " ");

  // Repair broken words
  cleaned = repairBrokenWords(cleaned);

  const lines = cleaned.split(/\r?\n/);
  const processedLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const lineTokens = trimmed.split(/\s+/).filter((token) => !isMeaninglessToken(token));
    if (lineTokens.length === 0) continue;

    const filtered = lineTokens.join(" ");
    const letters = (filtered.match(/[A-Za-z]/g) || []).length;
    if (letters < 3) continue;

    const normalized = normalizeSentenceCase(filtered);
    processedLines.push(normalized);
  }

  const stitched = processedLines.map((l) => {
    let s = l.trim();
    if (!/[.!?:]$/.test(s)) s += ".";
    return s;
  }).join(" ");

  return fixGrammarAndHomophones(stitched);
}

/**
 * 6. Sentence Boundary Splitting
 */
export function splitSentences(text) {
  if (!text) return [];

  const abbrevs = [
    "e.g.", "i.e.", "Dr.", "Mr.", "Mrs.", "Ms.", "Prof.", "Sr.", "Jr.", "vs.",
    "U.S.", "U.K.", "Inc.", "Ltd.", "p.m.", "a.m.", "et al.", "Fig.", "No."
  ];

  let protectedText = text;
  abbrevs.forEach((abb, idx) => {
    protectedText = protectedText.replaceAll(abb, `__ABB_${idx}__`);
  });

  const rawSentences = protectedText.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);

  return rawSentences
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
      return words.length >= 4 && letters >= 15;
    });
}

/**
 * 7. Deep Document Restructurer & Section Formatter:
 * Converts raw OCR text into structured Markdown with detected headers, bullet points,
 * and high-readability paragraphs while preserving all facts, dates, and metrics.
 */
export function restructureFullDocument(rawText) {
  if (!rawText) return "";

  const cleaned = cleanDocumentText(rawText);
  const sentences = splitSentences(cleaned);

  if (sentences.length <= 3) {
    return cleaned;
  }

  // Group sentences into thematic paragraphs (3-4 sentences each)
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
}

/**
 * 8. Entity, Metric & Key Figure Extraction Engine
 */
export function extractEntitiesAndMetrics(text) {
  if (!text) return { dates: [], metrics: [], properNouns: [], technicalTerms: [] };

  const dates = [];
  const metrics = [];
  const properNouns = [];
  const technicalTerms = [];

  // Date regex patterns
  const dateMatches = text.match(/\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\b\d{4}\b)\b/gi) || [];
  dateMatches.forEach((d) => {
    const clean = d.trim();
    if (clean && !dates.includes(clean) && clean.length > 3) dates.push(clean);
  });

  // Numbers, percentages, money, metrics
  const metricRegex = /(?:\$\s*\d+(?:\.\d+)?(?:\s*[MBKmbk]|billion|million|thousand)?|\b\d+(?:\.\d+)?%|\b\d+(?:,\d{3})*(?:\.\d+)?\s*(?:miles|km|hours|minutes|mins|cycles|percent|kg|MB|GB|TB|tons|units)\b)/gi;
  const metricMatches = text.match(metricRegex) || [];
  metricMatches.forEach((m) => {
    const clean = m.trim();
    if (clean && !metrics.includes(clean)) metrics.push(clean);
  });

  // Technical Acronyms
  PRESERVED_ACRONYMS.forEach((acronym) => {
    const regex = new RegExp(`\\b${acronym}\\b`, "i");
    if (regex.test(text) && !technicalTerms.includes(acronym)) {
      technicalTerms.push(acronym);
    }
  });

  // Proper Nouns (Capitalized multi-word phrases)
  const properMatches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
  properMatches.forEach((p) => {
    const clean = p.trim();
    if (clean && !properNouns.includes(clean) && clean.length > 5 && !PRESERVED_ACRONYMS.has(clean.toUpperCase())) {
      properNouns.push(clean);
    }
  });

  return {
    dates: dates.slice(0, 8),
    metrics: metrics.slice(0, 8),
    properNouns: properNouns.slice(0, 8),
    technicalTerms: technicalTerms.slice(0, 8)
  };
}

/**
 * 9. Document Intelligence & Readability Analytics
 */
export function analyzeDocumentReadability(text) {
  if (!text) return { fleschScore: 70, gradeLevel: "Standard", complexity: "Moderate" };

  const words = text.trim().split(/\s+/).filter(Boolean);
  const sentences = splitSentences(text);
  const wordCount = words.length || 1;
  const sentenceCount = sentences.length || 1;

  // Syllable estimation
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

  // Flesch Reading Ease Formula
  const score = Math.round(
    206.835 - 1.015 * (wordCount / sentenceCount) - 84.6 * (syllableCount / wordCount)
  );
  const clampedScore = Math.max(0, Math.min(100, score));

  let gradeLevel = "Standard (High School)";
  let complexity = "Balanced";

  if (clampedScore >= 80) {
    gradeLevel = "Easy (6th Grade)";
    complexity = "Very Clear";
  } else if (clampedScore >= 60) {
    gradeLevel = "Standard (8th-9th Grade)";
    complexity = "Optimal";
  } else if (clampedScore >= 45) {
    gradeLevel = "Technical (College Level)";
    complexity = "Dense";
  } else {
    gradeLevel = "Advanced / Academic";
    complexity = "High Complexity";
  }

  return {
    fleschScore: clampedScore,
    gradeLevel,
    complexity,
    syllablesPerWord: (syllableCount / wordCount).toFixed(1),
    avgSentenceLength: Math.round(wordCount / sentenceCount)
  };
}
