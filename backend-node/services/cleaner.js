/**
 * High-Precision NLP Cleaner & OCR Normalizer
 * Resolves:
 * 1. Unnecessary / chaotic capital letters (converts ALL-CAPS/TitleCase to natural sentence case)
 * 2. Words with no meaning / OCR noise tokens / gibberish character clusters
 * 3. Broken words across linebreaks, hyphens, and spaced characters
 * 4. Improper sentences, missing punctuation, and grammatical agreement
 */

// Whitelist of legitimate uppercase acronyms and proper abbreviations
const PRESERVED_ACRONYMS = new Set([
  "AI", "ML", "API", "APIS", "UI", "UX", "PDF", "PDFS", "DOC", "DOCX", "PPT", "PPTX",
  "HTML", "CSS", "JS", "NLP", "LLM", "LLMS", "GPT", "RAG", "GPU", "CPU", "RAM",
  "USA", "US", "UK", "EU", "UN", "NASA", "WHO", "ISRO", "DRDO", "UPSC", "SSC", "HSC",
  "CEO", "CTO", "CFO", "COO", "HR", "IT", "ID", "IP", "DNS", "URL", "HTTP", "HTTPS",
  "SQL", "NOSQL", "AWS", "GCP", "SAAS", "PAAS", "IAAS", "B2B", "B2C", "ROI", "KPI",
  "IoT", "WiFi", "OCR", "IEEE", "ISO", "COVID", "DNA", "RNA", "IQ", "EQ", "MB", "GB", "TB"
]);

// Valid single and two-letter English words
const VALID_SHORT_WORDS = new Set([
  "a", "i", "am", "an", "as", "at", "be", "by", "do", "go", "he", "if", "in", "is",
  "it", "me", "my", "no", "of", "on", "or", "so", "to", "up", "us", "we", "ok", "tv",
  "mr", "ms", "dr", "vs", "re", "ex", "ad", "pm", "am"
]);

/**
 * 1. Broken Word Repair:
 * Handles hyphenated line wraps (e.g. "connec-\ntion"),
 * spaced characters inside words (e.g. "c o m p u t e r"),
 * and stray hyphenated fragments.
 */
export function repairBrokenWords(text) {
  if (!text) return "";

  let cleaned = text;

  // Rejoin hyphenated line breaks: "transfor-\nmation" -> "transformation"
  cleaned = cleaned.replace(/([A-Za-z]{2,})-\s*\r?\n\s*([A-Za-z]{2,})/g, "$1$2");

  // Rejoin broken hyphens inside words: "compu- ter" -> "computer"
  cleaned = cleaned.replace(/([A-Za-z]{2,})-\s+([A-Za-z]{2,})/g, (match, p1, p2) => {
    return `${p1}${p2}`;
  });

  // Rejoin spaced single-letter sequences: "c o m p u t e r" -> "computer"
  cleaned = cleaned.replace(/\b([A-Za-z](?:\s+[A-Za-z]){2,})\b/g, (match) => {
    const combined = match.replace(/\s+/g, "");
    // Only combine if it forms a word of 3+ letters and isn't separate known single words like "a i"
    if (combined.length >= 3) {
      return combined;
    }
    return match;
  });

  return cleaned;
}

/**
 * 2. OCR Garbage & Meaningless Word Removal:
 * Eliminates meaningless character strings, invalid consonant clusters,
 * OCR scan artifacts, stamp noise, and stray symbols.
 */
export function isMeaninglessToken(token) {
  if (!token) return true;
  const clean = token.replace(/^[^\w]+|[^\w]+$/g, "");
  if (!clean) return true;

  const lower = clean.toLowerCase();

  // Preserved acronyms (e.g. AI, ML, PDF) are always valid
  if (PRESERVED_ACRONYMS.has(clean.toUpperCase())) return false;

  // Single or two-letter tokens
  if (clean.length === 1) {
    return !["a", "i"].includes(lower);
  }
  if (clean.length === 2) {
    return !VALID_SHORT_WORDS.has(lower) && !PRESERVED_ACRONYMS.has(clean.toUpperCase());
  }

  // Pure numbers or mixed alphanumeric like "2024", "100%", "3.5x", "$500" are valid
  if (/^[\d,.:;%$\-+/]+$/.test(clean)) return false;

  // Words with excessive non-alphabet characters
  const letters = (clean.match(/[a-zA-Z]/g) || []).length;
  const nonLetters = clean.length - letters;
  if (nonLetters > letters) return true;

  // Repetitive single character noise (e.g. "aaaa", "xxxx", "----")
  if (/(.)\1{3,}/.test(clean)) return true;

  // English words of 3+ letters MUST have at least one vowel (a, e, i, o, u, y)
  // unless they are known acronyms
  if (letters >= 3 && !/[aeiouyAEIOUY]/.test(clean)) {
    return !PRESERVED_ACRONYMS.has(clean.toUpperCase());
  }

  // Excessive consonant clusters (5+ consonants in a row in English is virtually always OCR noise)
  if (/[bcdfghjklmnpqrstvwxzBCDFGHJKLMNPQRSTVWXZ]{5,}/.test(clean)) {
    return !PRESERVED_ACRONYMS.has(clean.toUpperCase());
  }

  return false;
}

/**
 * 3. Capitalization & True-Casing Normalization:
 * Eliminates unnecessary ALL-CAPS blocks, random mid-word caps (e.g. "dOcUmEnT" -> "document"),
 * and Title-Casing on regular sentences, while preserving proper nouns & acronyms.
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

    // Check if it's a known acronym
    if (PRESERVED_ACRONYMS.has(core.toUpperCase())) {
      return leadPunct + core.toUpperCase() + trailPunct;
    }

    // Fix random mid-word capitalizations: "dOcUmEnT" -> "document"
    let cleanCore = core;
    if (/[a-z][A-Z]/.test(cleanCore) && !/^[A-Z][a-z]+[A-Z]/.test(cleanCore)) {
      cleanCore = cleanCore.toLowerCase();
    }

    if (isAllOrMajorityCaps || isHeavyTitleCase) {
      if (idx === 0) {
        cleanCore = cleanCore.charAt(0).toUpperCase() + cleanCore.slice(1).toLowerCase();
      } else {
        if (PRESERVED_ACRONYMS.has(cleanCore.toUpperCase())) {
          cleanCore = cleanCore.toUpperCase();
        } else {
          cleanCore = cleanCore.toLowerCase();
        }
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

  // Split by line or sentence boundaries
  const segments = text.split(/(?<=[.!?\n])\s+/);
  return segments.map(normalizeSentenceCase).filter(Boolean).join(" ");
}

/**
 * 4. Grammatical Agreement, Homophones & Sentence Polish:
 * Fixes common homophone mixups, article agreement (a vs an),
 * duplicate words, and punctuation spacing.
 */
export function fixGrammarAndHomophones(text) {
  if (!text) return "";

  let t = text.trim();

  // 1. Article agreement ("a" vs "an" with phonetic exceptions)
  t = t.replace(/\b([Aa])\s+([aeiouAEIOU]\w*)/g, (match, p1, p2) => {
    const isConsonantSound = /^(?:univ|use|uniq|unit|user|eul|euro|one|once)/i.test(p2);
    return isConsonantSound ? "a " + p2 : "an " + p2;
  });
  t = t.replace(/\b([Aa])n\s+([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ]\w*)/g, (match, p1, p2) => {
    const isVowelSound = /^(?:hour|honest|honor|heir)/i.test(p2);
    return isVowelSound ? "an " + p2 : "a " + p2;
  });

  // 2. Grammar, Homophones & Phrasing Rules
  const grammarRules = [
    // than vs then
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
    [/\b(an|the|a|significant|direct|indirect|adverse|positive|negative|profound)\s+affect\b/gi, "$1 effect"],
    [/\bhave\s+an\s+affect\s+on\b/gi, "have an effect on"],

    // Duplicate words (e.g. "the the", "is is")
    [/\b(the|and|in|of|to|is|that|for|with|as)\s+\1\b/gi, "$1"],

    // Punctuation & spacing fixes
    [/\s+([,.:;?!])/g, "$1"],
    [/([,.:;?!])([A-Za-z])/g, "$1 $2"],
    [/\s{2,}/g, " "]
  ];

  for (const [pattern, repl] of grammarRules) {
    t = t.replace(pattern, repl);
  }

  // Capitalize after periods, question marks, and exclamation marks
  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase());

  return t.trim();
}

/**
 * 5. Full Document Text Pipeline:
 * Reassembles raw OCR / document text into clean, cohesive, grammatical prose.
 */
export function cleanDocumentText(rawText) {
  if (!rawText || typeof rawText !== "string") return "";

  // Normalize newlines and whitespace
  let text = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Step A: Strip common page headers, timestamps, citation brackets, footers
  text = text.replace(/\bPage\s+\d+\s+(?:of|\/)\s+\d+\b/gi, " ");
  text = text.replace(/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\s+\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");
  text = text.replace(/\[\s*\d+\s*\]/g, " ");
  text = text.replace(/[|\u00A6\u00A7\u00A4\u00A9\u00AE\u2122\u2192\u2190\u2191\u2193\u2194\u2195\u2022\u25AA\u25AB\u25E6\u25A0\u25A1\u25C6\u25C7~`^_=]+/g, " ");

  // Step B: Repair broken words & de-hyphenate line breaks
  text = repairBrokenWords(text);

  // Step C: Line-by-line validation and paragraph stitching
  const rawLines = text.split("\n");
  const processedLines = [];

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Filter noise tokens from the line
    const lineTokens = trimmed.split(/\s+/).filter((token) => !isMeaninglessToken(token));
    if (lineTokens.length === 0) continue;

    const filteredLine = lineTokens.join(" ");
    const letters = (filteredLine.match(/[A-Za-z]/g) || []).length;

    // Discard lines with almost no letters
    if (letters < 3) continue;

    // Normalize casing on each distinct header/line
    const normalizedLine = normalizeSentenceCase(filteredLine);
    processedLines.push(normalizedLine);
  }

  // Join lines into sentences/paragraphs
  const stitched = processedLines.map((line) => {
    let l = line.trim();
    if (!/[.!?:]$/.test(l)) l += ".";
    return l;
  }).join(" ");

  // Step D: Grammar, Homophones & Spacing polish
  const finalCleaned = fixGrammarAndHomophones(stitched);

  return finalCleaned;
}

/**
 * 6. Sentence Boundary Splitting:
 * Splits text into complete, grammatically valid sentences without breaking on abbreviations.
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
