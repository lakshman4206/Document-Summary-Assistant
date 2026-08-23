import {
  repairBrokenWords,
  isMeaninglessToken,
  normalizeCapitalization,
  fixGrammarAndHomophones,
  cleanDocumentText,
  splitSentences
} from "../services/cleaner.js";
import { summarizeText } from "../services/summarizer.js";

console.log("=========================================");
console.log("🧪 TESTING NLP CLEANER & OCR NORMALIZER");
console.log("=========================================\n");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${message}`);
    failed++;
  }
}

// Test 1: Broken Words
const brokenInput = "The compu- ter system provides transfor-\nmation of data and c o m p u t e r vision.";
const repaired = repairBrokenWords(brokenInput);
assert(repaired.includes("computer system"), "Repairs hyphenated word 'compu- ter'");
assert(repaired.includes("transformation"), "Repairs line-wrapped word 'transfor-\\nmation'");
assert(repaired.includes("computer vision"), "Rejoins spaced letters 'c o m p u t e r'");

// Test 2: Meaningless noise tokens
assert(isMeaninglessToken("xjk"), "Detects non-vowel cluster 'xjk' as meaningless");
assert(isMeaninglessToken("sdfkj"), "Detects 5-consonant gibberish 'sdfkj' as meaningless");
assert(isMeaninglessToken("§¶"), "Detects symbol noise '§¶' as meaningless");
assert(isMeaninglessToken("q"), "Detects isolated letter 'q' as meaningless");
assert(!isMeaninglessToken("AI"), "Preserves legitimate acronym 'AI'");
assert(!isMeaninglessToken("the"), "Preserves valid word 'the'");
assert(!isMeaninglessToken("2024"), "Preserves numbers '2024'");

// Test 3: Capitalization Normalization
const noisyCaps = "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG. THIS IS A TEST OF AI TECHNOLOGY.";
const normalizedCaps = normalizeCapitalization(noisyCaps);
assert(normalizedCaps.startsWith("The quick brown fox"), "Converts ALL-CAPS sentence to natural sentence case");
assert(normalizedCaps.includes("AI technology"), "Preserves acronym AI in uppercase");

const midWordCaps = "The dOcUmEnT was sPeLLiNg checked successfully.";
const fixedMidWord = normalizeCapitalization(midWordCaps);
assert(fixedMidWord.includes("document"), "Fixes mid-word capital glitch 'dOcUmEnT'");
assert(fixedMidWord.includes("spelling"), "Fixes mid-word capital glitch 'sPeLLiNg'");

// Test 4: Grammar, homophones, article agreement
const badGrammar = "He had a apple and it was more then he wanted. The the system has an affect on data.";
const fixedGrammar = fixGrammarAndHomophones(badGrammar);
assert(fixedGrammar.includes("an apple"), "Fixes article agreement 'a apple' -> 'an apple'");
assert(fixedGrammar.includes("more than"), "Fixes homophone 'more then' -> 'more than'");
assert(!fixedGrammar.includes("The the"), "Removes duplicate word 'The the'");
assert(fixedGrammar.includes("an effect"), "Fixes 'an affect' -> 'an effect'");

// Test 5: Full document pipeline
const rawOCRText = `
ANNUAL REPORT FOR ENTERPRISE AI SOLUTIONS
Page 1 of 5   12/04/2026 14:30:00

The organi- zation has achieved more then 40% growth in AI mod-
els. xjk sdfkj We deployed an system to auto- mate routine tasks.
T H I S   I S   A N E W   E R A   O F   A U T O M A T I O N .
`;

const cleanedDoc = cleanDocumentText(rawOCRText);
console.log("\n--- Full Document Cleaned Output ---");
console.log(cleanedDoc);
console.log("------------------------------------\n");

assert(!cleanedDoc.includes("Page 1 of 5"), "Stripped page header");
assert(!cleanedDoc.includes("xjk"), "Removed noise token 'xjk'");
assert(!cleanedDoc.includes("sdfkj"), "Removed noise token 'sdfkj'");
assert(cleanedDoc.includes("organization"), "Repaired 'organi- zation'");
assert(cleanedDoc.includes("more than"), "Corrected 'more then' to 'more than'");
assert(cleanedDoc.includes("AI models"), "Preserved 'AI models'");

// Test 6: Summarization
const summaryRes = summarizeText(cleanedDoc, "short");
console.log("--- Summary Output ---");
console.log("Summary:", summaryRes.summary);
console.log("Key Points:", summaryRes.key_points);
console.log("Keywords:", summaryRes.keywords);
console.log("Metrics:", summaryRes.metrics);
console.log("----------------------\n");

assert(summaryRes.summary.length > 0, "Generated non-empty summary");
assert(summaryRes.key_points.length > 0, "Generated key points");
assert(summaryRes.keywords.length > 0, "Extracted keywords");

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
