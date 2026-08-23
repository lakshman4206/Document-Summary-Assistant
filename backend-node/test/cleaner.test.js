import {
  repairBrokenWords,
  isMeaninglessToken,
  normalizeCapitalization,
  fixGrammarAndHomophones,
  cleanDocumentText,
  splitSentences,
  restructureFullDocument,
  extractEntitiesAndMetrics,
  analyzeDocumentReadability
} from "../services/cleaner.js";
import { summarizeText } from "../services/summarizer.js";

console.log("=================================================");
console.log("🧪 TESTING DEEP-SCAN NLP & INTELLIGENCE ENGINE");
console.log("=================================================\n");

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

// Test 2: Meaningless noise tokens & metric preservation
assert(isMeaninglessToken("xjk"), "Detects non-vowel cluster 'xjk' as meaningless");
assert(isMeaninglessToken("sdfkj"), "Detects 5-consonant gibberish 'sdfkj' as meaningless");
assert(isMeaninglessToken("§¶"), "Detects symbol noise '§¶' as meaningless");
assert(!isMeaninglessToken("42%"), "Preserves percentage metric '42%'");
assert(!isMeaninglessToken("$1,200"), "Preserves currency '$1,200'");
assert(!isMeaninglessToken("AI"), "Preserves legitimate acronym 'AI'");

// Test 3: Capitalization Normalization
const noisyCaps = "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG. THIS IS A TEST OF AI TECHNOLOGY.";
const normalizedCaps = normalizeCapitalization(noisyCaps);
assert(normalizedCaps.startsWith("The quick brown fox"), "Converts ALL-CAPS sentence to natural sentence case");
assert(normalizedCaps.includes("AI technology"), "Preserves acronym AI in uppercase");

// Test 4: Entity Extraction
const sampleDoc = `
On August 23, 2026, OpenAI launched GPT-5 with a 42% performance boost across 1,200 continuous cycles, saving $3.5M in server costs. CEO Sam Altman stated the model transforms natural language understanding.
`;
const entities = extractEntitiesAndMetrics(sampleDoc);
console.log("Extracted Entities:", entities);
assert(entities.dates.length > 0, "Extracted dates");
assert(entities.metrics.length > 0, "Extracted metrics ($3.5M / 42% / 1,200 cycles)");
assert(entities.technicalTerms.includes("GPT") || entities.technicalTerms.includes("AI"), "Extracted technical terms");

// Test 5: Document Readability Analytics
const readability = analyzeDocumentReadability(sampleDoc);
console.log("Readability Analytics:", readability);
assert(readability.fleschScore > 0, "Calculated Flesch Reading Ease score");
assert(readability.gradeLevel.length > 0, "Assigned grade level");

// Test 6: Full Deep Scan Summarization
const summaryResult = summarizeText(sampleDoc, "medium");
assert(summaryResult.summary.length > 0, "Generated summary");
assert(summaryResult.restructured_document.length > 0, "Generated restructured document");
assert(summaryResult.entities.metrics.length > 0, "Attached entity intelligence");

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
