import re
import math
from collections import Counter
from spellchecker import SpellChecker

# Initialize spell checker
spell = SpellChecker()

# --- Optional spaCy NER support -------------------------------------------
# Detects real proper nouns (people, cities, organizations) dynamically so
# we don't have to hand-maintain an ever-growing hardcoded word list.
# Import is guarded: if spacy or the model isn't installed in this
# environment, the app degrades gracefully to the old dictionary-only
# behavior instead of crashing on startup (the same mistake that broke the
# ftfy deploy earlier — a missing optional dependency should never take
# the whole service down).
try:
    import spacy
    _NLP = spacy.load("en_core_web_sm")
    SPACY_AVAILABLE = True
except Exception as _spacy_err:
    _NLP = None
    SPACY_AVAILABLE = False
    print(f"[Warning] spaCy NER unavailable, falling back to dictionary-only mode: {_spacy_err}")

_NER_LABELS = {"PERSON", "GPE", "ORG", "NORP", "FAC", "LOC"}


def get_protected_entities(text: str) -> set[str]:
    """
    Returns lowercase words that spaCy recognizes as real names, cities,
    organizations, etc. These should never be "corrected" by the
    spellchecker, no matter how unfamiliar they look. Returns an empty
    set (never raises) if spaCy isn't available or text is too short.
    """
    if not SPACY_AVAILABLE or not text or len(text) < 3:
        return set()

    try:
        doc = _NLP(text[:20000])  # cap length to keep this fast
        protected = set()
        for ent in doc.ents:
            if ent.label_ in _NER_LABELS:
                for w in re.findall(r"[A-Za-z']+", ent.text):
                    protected.add(w.lower())
        return protected
    except Exception as err:
        print(f"[Warning] spaCy NER extraction failed: {err}")
        return set()


# Comprehensive Domain & Proper Noun Lexicon.
# This still matters even with spaCy enabled: spaCy occasionally misses
# short/ambiguous domain terms (e.g. "SSC", "NDA") that aren't grammatically
# recognizable as entities. Kept as a fast first-pass check and as the
# fallback whenever spaCy is unavailable.
CUSTOM_DICTIONARY = {
    # Tech & Computing
    "ai", "ml", "api", "apis", "dataset", "datasets", "cybersecurity", "blockchain",
    "cloud", "devops", "fintech", "edtech", "healthtech", "saas", "paas", "iaas",
    "microservices", "frontend", "backend", "fullstack", "sql", "nosql", "fastapi",
    "uvicorn", "pydantic", "react", "nextjs", "vite", "huggingface", "llm", "llms",
    "gpt", "bert", "bart", "transformer", "transformers", "metadata", "workflow",
    "workflows", "dashboard", "dashboards", "analytics", "parameter", "parameters",
    "scalability", "framework", "frameworks", "infrastructure", "optimization",
    "algorithm", "algorithms", "automation", "authentication", "authorization",

    # Official & Educational Terminology
    "taekwondo", "matriculation", "ssc", "hsc", "upsc", "cds", "nda", "gate",
    "tehsildar", "tahsildar", "sachivalayam", "grama", "ward", "domicile", "cadet",
    "trainee", "candidate", "applicant", "curriculum", "extracurricular",

    # Indian States, UTs & Regions
    "andhra", "pradesh", "telangana", "karnataka", "tamil", "nadu", "kerala",
    "maharashtra", "gujarat", "rajasthan", "punjab", "haryana", "delhi", "uttar",
    "bihar", "bengal", "odisha", "assam", "kashmir", "ladakh", "goa", "mp", "up",

    # Districts & Cities
    "anantapur", "georgepet", "hyderabad", "bengaluru", "chennai", "mumbai",
    "amaravati", "vijayawada", "visakhapatnam", "tirupati", "guntur", "kurnool",

    # Common Names & Surnames
    "kadapala", "lakshmana", "murthy", "sreenivasa", "sammetla", "lavanya",
    "reddy", "rao", "naidu", "kumar", "singh", "sharma", "verma", "patel",
    "gupta", "joshi", "kulkarni", "chatterjee", "banerjee", "nair", "menon"
}
spell.word_frequency.load_words(CUSTOM_DICTIONARY)


def clean_person_name(raw_name: str) -> str:
    """Extract strictly the clean person name, eliminating any adjacent table/form labels or OCR noise."""
    if not raw_name:
        return ""

    stop_labels = {
        "identity", "profile", "first", "middle", "last", "name", "date", "birth", "dob",
        "father", "mother", "urn", "application", "gender", "email", "mobile", "uploaded",
        "live", "photo", "profi", "class", "matriculation", "board", "examination", "roll",
        "year", "passing", "percentage", "marks", "aadhaar", "nationality", "place", "state",
        "district", "mother tongue", "village", "post", "office", "pin", "marital", "spouse",
        "i", "pro", "signature", "status", "occupation", "annual", "income"
    }

    words = re.findall(r'[A-Za-z]+', raw_name)
    clean_words = []

    for w in words:
        if w.lower() in stop_labels:
            break
        if len(w) > 1:
            clean_words.append(w.capitalize())
        if len(clean_words) >= 4:
            break

    while clean_words and (len(clean_words[-1]) <= 2 or clean_words[-1].lower() in ["pro", "profi"]):
        clean_words.pop()

    return " ".join(clean_words)


def extract_form_candidate_name(text: str) -> str:
    """Extract the candidate's exact full name cleanly. Returns empty string if not found."""
    m1 = re.search(
        r'(?:Full Name as declared by Candidate|Candidate Name|Full Name)\s*:?\s*([A-Za-z\s]{4,60})',
        text, re.IGNORECASE
    )
    if m1:
        name = clean_person_name(m1.group(1))
        if len(name) >= 4:
            return name

    fn = re.search(r'First Name\s*:?\s*([A-Za-z]+)', text, re.IGNORECASE)
    mn = re.search(r'Middle Name\s*:?\s*([A-Za-z]+)', text, re.IGNORECASE)
    ln = re.search(r'Last Name\s*:?\s*([A-Za-z]+)', text, re.IGNORECASE)
    if fn and ln:
        parts = [fn.group(1).capitalize()]
        if mn and mn.group(1).lower() not in ["none", "na", "n/a", "last", "name"]:
            parts.append(mn.group(1).capitalize())
        parts.append(ln.group(1).capitalize())
        return " ".join(parts)

    return ""  # Never return a hardcoded name


def fix_grammar_and_homophones(text: str) -> str:
    """Enforces standard English grammatical rules, homophone corrections, and article agreement."""
    if not text:
        return ""

    t = text

    # 1. Article Agreement ("a" vs "an")
    t = re.sub(
        r'\b[Aa]\s+([aeiouAEIOU]\w*)',
        lambda m: 'an ' + m.group(1) if not re.match(r'^(?:univ|use|uniq|unit|user|eul|euro)', m.group(1), re.I) else 'a ' + m.group(1),
        t
    )
    t = re.sub(
        r'\b[Aa]n\s+([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ]\w*)',
        lambda m: 'an ' + m.group(1) if re.match(r'^(?:hour|honest|honor|heir)', m.group(1), re.I) else 'a ' + m.group(1),
        t
    )

    # 2. Homophones and Common Grammatical Errors
    rules = [
        # Comparison: than vs then
        (r'\bmore\s+then\b', 'more than'),
        (r'\bless\s+then\b', 'less than'),
        (r'\bfaster\s+then\b', 'faster than'),
        (r'\bbetter\s+then\b', 'better than'),
        (r'\bgreater\s+then\b', 'greater than'),
        (r'\brather\s+then\b', 'rather than'),
        (r'\bearlier\s+then\b', 'earlier than'),
        (r'\bhigher\s+then\b', 'higher than'),

        # Possessive vs Contraction: your vs you're
        (r'\byour\s+(welcome|right|going|able|ready|invited)\b', r"you're \1"),
        (r"\byou're\s+(name|car|house|file|document|profile|email)\b", r"your \1"),

        # its vs it's
        (r"\bit's\s+(name|features|purpose|value|speed|impact|application|accuracy)\b", r"its \1"),

        # their vs there vs they're
        (r'\bthere\s+(names|features|results|findings|skills)\b', r"their \1"),
        (r'\btheir\s+(is|are|was|were|will be)\b', r"there \1"),

        # affect vs effect
        (r'\bthe\s+affect\s+of\b', 'the effect of'),
        (r'\ba\s+significant\s+affect\b', 'a significant effect'),

        # Subject-Verb Agreement common fixes
        (r'\bdata\s+are\b', 'data is'),
        (r'\beveryone\s+are\b', 'everyone is'),
        (r'\bsomeone\s+are\b', 'someone is'),

        # Punctuation Spacing & Polish
        (r'\s+([,.:;?!])', r'\1'),
        (r'([,.:;?!])([A-Za-z])', r'\1 \2'),
        (r'\s{2,}', ' ')
    ]

    for pattern, repl in rules:
        t = re.sub(pattern, repl, t, flags=re.IGNORECASE)

    return t.strip()


PRESERVED_ACRONYMS = {
    "AI", "ML", "API", "APIS", "UI", "UX", "PDF", "PDFS", "DOC", "DOCX", "PPT", "PPTX",
    "HTML", "CSS", "JS", "NLP", "LLM", "LLMS", "GPT", "RAG", "GPU", "CPU", "RAM",
    "USA", "US", "UK", "EU", "UN", "NASA", "WHO", "ISRO", "DRDO", "UPSC", "SSC", "HSC",
    "CEO", "CTO", "CFO", "COO", "HR", "IT", "ID", "IP", "DNS", "URL", "HTTP", "HTTPS",
    "SQL", "NOSQL", "AWS", "GCP", "SAAS", "PAAS", "IAAS", "B2B", "B2C", "ROI", "KPI",
    "IOT", "WIFI", "OCR", "IEEE", "ISO", "COVID", "DNA", "RNA", "IQ", "EQ", "MB", "GB", "TB"
}

VALID_SHORT_WORDS = {
    "a", "i", "am", "an", "as", "at", "be", "by", "do", "go", "he", "if", "in", "is",
    "it", "me", "my", "no", "of", "on", "or", "so", "to", "up", "us", "we", "ok", "tv",
    "mr", "ms", "dr", "vs", "re", "ex", "ad", "pm", "am"
}


def is_meaningless_token(token: str) -> bool:
    """Filter OCR garbage, non-vowel clusters, and symbol noise."""
    if not token:
        return True
    clean = re.sub(r'^[^\w]+|[^\w]+$', '', token)
    if not clean:
        return True

    upper_val = clean.upper()
    lower_val = clean.lower()

    if upper_val in PRESERVED_ACRONYMS:
        return False

    if len(clean) == 1:
        return lower_val not in ["a", "i"]

    if len(clean) == 2:
        return lower_val not in VALID_SHORT_WORDS and upper_val not in PRESERVED_ACRONYMS

    if re.match(r'^[\d,.:;%$\-+/]+$', clean):
        return False

    letters = len(re.findall(r'[a-zA-Z]', clean))
    non_letters = len(clean) - letters
    if non_letters > letters:
        return True

    # 3+ letters without a vowel is OCR gibberish
    if letters >= 3 and not re.search(r'[aeiouyAEIOUY]', clean):
        return upper_val not in PRESERVED_ACRONYMS

    # 5+ consonants in a row
    if re.search(r'[bcdfghjklmnpqrstvwxzBCDFGHJKLMNPQRSTVWXZ]{5,}', clean):
        return upper_val not in PRESERVED_ACRONYMS

    return False


def normalize_capitalization(text: str) -> str:
    """Converts ALL-CAPS/TitleCase to natural sentence case and fixes mid-word capitals."""
    if not text:
        return ""

    sentences = re.split(r'(?<=[.!?\n])\s+', text)
    result_sentences = []

    for sentence in sentences:
        trimmed = sentence.strip()
        if not trimmed:
            continue

        words = trimmed.split()
        if not words:
            continue

        all_caps_count = sum(1 for w in words if len(re.findall(r'[A-Za-z]', w)) >= 2 and w == w.upper() and w.upper() not in PRESERVED_ACRONYMS)
        alpha_count = sum(1 for w in words if len(re.findall(r'[A-Za-z]', w)) >= 2)

        is_all_caps = alpha_count >= 2 and (all_caps_count / alpha_count > 0.5)

        processed = []
        for idx, w in enumerate(words):
            m = re.match(r'^([^A-Za-z0-9]*)(.*?)([^A-Za-z0-9]*)$', w)
            if not m:
                processed.append(w)
                continue

            lead, core, trail = m.groups()
            if not core:
                processed.append(w)
                continue

            if core.upper() in PRESERVED_ACRONYMS:
                processed.append(f"{lead}{core.upper()}{trail}")
                continue

            clean_core = core
            if re.search(r'[a-z][A-Z]', clean_core) and not re.match(r'^[A-Z][a-z]+[A-Z]', clean_core):
                clean_core = clean_core.lower()

            if is_all_caps:
                if idx == 0:
                    clean_core = clean_core.capitalize()
                else:
                    clean_core = clean_core.upper() if clean_core.upper() in PRESERVED_ACRONYMS else clean_core.lower()
            else:
                if idx == 0:
                    clean_core = clean_core.capitalize()

            processed.append(f"{lead}{clean_core}{trail}")

        res = " ".join(processed)
        res = re.sub(r'^([a-z])', lambda m: m.group(1).upper(), res)
        result_sentences.append(res)

    return " ".join(result_sentences)


def clean_text_formatting(text: str) -> str:
    """Clean PDF artifacts, OCR glitches, broken line-break hyphenations, and redundant whitespace."""
    if not text:
        return ""

    text = text.replace("\r\n", "\n").replace("\r", "\n")

    # Fix hyphenated line breaks e.g. "techno- \n logy" -> "technology"
    text = re.sub(r'([A-Za-z]{2,})-\s*\n\s*([A-Za-z]{2,})', r'\1\2', text)
    # Fix broken hyphens inside words: "compu- ter" -> "computer"
    text = re.sub(r'([A-Za-z]{2,})-\s+([A-Za-z]{2,})', r'\1\2', text)

    # Rejoin spaced letters: "c o m p u t e r" -> "computer"
    text = re.sub(r'\b([A-Za-z](?:\s+[A-Za-z]){2,})\b', lambda m: m.group(0).replace(" ", "") if len(m.group(0).replace(" ", "")) >= 3 else m.group(0), text)

    # Clean OCR noise and boilerplate headers
    text = re.sub(r'Combined Defence Services [A-Za-z]+\s+[A-Za-z]+\s+\([^)]+\)', '', text, flags=re.IGNORECASE)
    text = re.sub(r'Application Printed On:.*?(?=\n|$)', '', text, flags=re.IGNORECASE)
    text = re.sub(r'Sure\?\s*Te lies ar ran', '', text, flags=re.IGNORECASE)
    text = re.sub(r'Tr SYR STANT Curse', '', text, flags=re.IGNORECASE)
    text = re.sub(r'Page \d+ of \d+|\d{2}/\d{2}/\d{4}\s+\d{2}:\d{2}:\d{2}', '', text, flags=re.IGNORECASE)
    text = re.sub(r'Is the above name same as the name printed on.*?:\s*Yes', '', text, flags=re.IGNORECASE)
    text = re.sub(r'Applicable to those who are already in government service.*?(?=\n|$)', '', text, flags=re.IGNORECASE)

    # Standardize OCR and abbreviation errors
    ocr_fixes = {
        r'\btial Art\b': 'Martial Arts',
        r'\bBasic tial Art\b': 'Basic Martial Arts',
        r'\brainee\b': 'Trainee',
        r'\bApplicati\b': 'Application',
        r'\bExaminati\b': 'Examination',
        r'\bheadquaters\b': 'headquarters',
        r'\bPassout\b': 'Passing',
        r'\[Sender': '',
    }
    for pattern, repl in ocr_fixes.items():
        text = re.sub(pattern, repl, text, flags=re.IGNORECASE)

    lines = text.split("\n")
    processed_lines = []
    for line in lines:
        tokens = [t for t in line.split() if not is_meaningless_token(t)]
        if tokens:
            processed_lines.append(" ".join(tokens))

    text = " ".join(processed_lines)
    text = re.sub(r'[\t\f\v\xa0]', ' ', text)
    text = re.sub(r' +', ' ', text)
    text = re.sub(r'\s+([,.:;?!])', r'\1', text)

    text = normalize_capitalization(text)
    text = fix_grammar_and_homophones(text)

    return text.strip()


def correct_spelling(text: str, protected_words: set[str] | None = None) -> str:
    """
    Scans text and corrects spelling errors while preserving proper nouns,
    acronyms, and formatting.

    protected_words: lowercase words (typically from spaCy NER via
    get_protected_entities) that should never be "corrected" — e.g. a real
    city or person's name that just isn't in the spellchecker's dictionary.
    """
    if not text or len(text) < 3:
        return text

    protected = protected_words or set()

    tokens = re.findall(r"\w+(?:'\w+)?|[^\w\s]|\s+", text)
    corrected_tokens = []

    for token in tokens:
        if re.match(r"^[A-Za-z]+$", token):
            if token.isupper() and len(token) > 1:
                corrected_tokens.append(token)
                continue

            if token[0].isupper() and len(token) > 2:
                lower_val = token.lower()
                if lower_val in CUSTOM_DICTIONARY or lower_val in spell or lower_val in protected:
                    corrected_tokens.append(token)
                    continue
                # Previously this branch was identical to the one above —
                # it appended the token unchanged even when the word was
                # NOT recognized, so misspelled/garbled capitalized words
                # (e.g. sentence-initial BART output like "Excelent",
                # "Recieved") were never corrected at all. Now we attempt
                # a real correction, same as the lowercase path below.
                correction = spell.correction(lower_val)
                if correction and correction != lower_val:
                    corrected_tokens.append(correction.capitalize())
                else:
                    corrected_tokens.append(token)
                continue

            lower_word = token.lower()
            if lower_word not in spell and lower_word not in CUSTOM_DICTIONARY and lower_word not in protected:
                correction = spell.correction(lower_word)
                if correction and correction != lower_word:
                    if token[0].isupper():
                        corrected_tokens.append(correction.capitalize())
                    else:
                        corrected_tokens.append(correction)
                else:
                    corrected_tokens.append(token)
            else:
                corrected_tokens.append(token)
        else:
            corrected_tokens.append(token)

    result = "".join(corrected_tokens)
    result = normalize_capitalization(result)
    result = fix_grammar_and_homophones(result)
    return result


def detect_and_synthesize_form_document(text: str) -> tuple[str | None, list[str] | None]:
    """
    Detect a real structured application form and synthesize a clean narrative
    ONLY from fields that were actually extracted. No hardcoded personal data.
    """
    cleaned_text = clean_text_formatting(text)
    lower = cleaned_text.lower()

    # Much stricter indicators – require clear form language
    strong_indicators = [
        "application submitted",
        "public service commission",
        "universal registration number",
        "submitted application form",
        "identity profile",
        "full name as declared by candidate",
        "candidate name",
        "upsc",
        "combined defence services",
    ]
    strong_matches = sum(1 for ind in strong_indicators if ind in lower)

    # Weaker supporting signals
    weak_indicators = [
        "father's name", "mother's name", "date of birth",
        "matriculation", "roll number", "domicile", "district"
    ]
    weak_matches = sum(1 for ind in weak_indicators if ind in lower)

    # Require at least 2 strong signals OR 1 strong + 3 weak
    if strong_matches < 2 and not (strong_matches >= 1 and weak_matches >= 3):
        return None, None

    # ---- Extract only what is present ----
    candidate_name = extract_form_candidate_name(cleaned_text)

    exam_name = ""
    exam_match = re.search(
        r'(?:Exam Name|Submitted Application Form for|Application for)\s*:?\s*([A-Za-z0-9\s()]{5,60})',
        cleaned_text, re.IGNORECASE
    )
    if exam_match:
        ex = re.sub(
            r'\b(Application|Submitted|Identity|Profile|On|Page|Date)\b',
            '', exam_match.group(1), flags=re.IGNORECASE
        ).strip()
        if len(ex) > 4:
            exam_name = ex.title()

    dob = ""
    dob_match = re.search(
        r'Date of Birth\s*:?\s*([0-9/.\-\sA-Za-z()]{6,50})',
        cleaned_text, re.IGNORECASE
    )
    if dob_match:
        dob = re.sub(r'\s+', ' ', dob_match.group(1)).strip()

    father_name = ""
    father_match = re.search(
        r"Father'?s Name\s*:?\s*([A-Za-z\s]{4,40})",
        cleaned_text, re.IGNORECASE
    )
    if father_match:
        fname = clean_person_name(father_match.group(1))
        if len(fname) > 3:
            father_name = fname

    mother_name = ""
    mother_match = re.search(
        r"Mother'?s Name\s*:?\s*([A-Za-z\s]{4,40})",
        cleaned_text, re.IGNORECASE
    )
    if mother_match:
        mname = clean_person_name(mother_match.group(1))
        if len(mname) > 3:
            mother_name = mname

    # If we could not extract a usable name + at least one other field → abandon form mode
    if not candidate_name or (not exam_name and not dob and not father_name):
        return None, None

    # ---- Build natural, grammatically correct sentences only from real data ----
    sentences = []

    if exam_name:
        sentences.append(
            f"This document is the official application form submitted for the {exam_name}."
        )
    else:
        sentences.append("This document is a structured application form.")

    if candidate_name:
        if father_name and mother_name:
            sentences.append(
                f"The applicant, {candidate_name}, is the son/daughter of {father_name} and {mother_name}."
            )
        elif father_name:
            sentences.append(
                f"The applicant is {candidate_name}, son/daughter of {father_name}."
            )
        else:
            sentences.append(f"The applicant’s name is {candidate_name}.")

    if dob:
        sentences.append(f"Date of birth recorded on the form is {dob}.")

    summary_text = " ".join(sentences)
    summary_text = fix_grammar_and_homophones(summary_text)
    protected_entities = get_protected_entities(text)
    summary_text = correct_spelling(summary_text, protected_entities)

    # Ensure proper ending punctuation
    if summary_text and summary_text[-1] not in ".!?":
        summary_text += "."

    key_points = []
    if exam_name:
        key_points.append(f"Application submitted for: {exam_name}")
    if candidate_name:
        key_points.append(f"Candidate: {candidate_name}")
    if father_name or mother_name:
        key_points.append(f"Parents: {father_name or 'N/A'} / {mother_name or 'N/A'}")
    if dob:
        key_points.append(f"Date of Birth: {dob}")

    return summary_text, key_points


def robust_sentence_split(text: str) -> list[str]:
    """Split text into sentences using NLTK sentence tokenizer with regex fallback."""
    if not text:
        return []

    try:
        from nltk.tokenize import sent_tokenize
        sentences = sent_tokenize(text)
        if sentences and len(sentences) > 0:
            return sentences
    except Exception:
        pass

    abbrevs = ["e.g.", "i.e.", "Dr.", "Mr.", "Mrs.", "Ms.", "Prof.", "Sr.", "Jr.", "vs.", "U.S.", "U.K.", "Inc.", "Ltd."]
    protected_text = text
    for idx, abb in enumerate(abbrevs):
        protected_text = protected_text.replace(abb, f"__ABB_{idx}__")

    raw_sentences = re.split(r'(?<=[.!?])\s+(?=[A-Z0-9])', protected_text)

    sentences = []
    for s in raw_sentences:
        for idx, abb in enumerate(abbrevs):
            s = s.replace(f"__ABB_{idx}__", abb)
        s_clean = s.strip()
        if len(s_clean) >= 12:
            sentences.append(s_clean)

    return sentences if sentences else [text.strip()]


def local_textrank_summarize(text: str, length: str = "medium") -> tuple[str, list[str]]:
    """Extractive & Narrative summarization engine based on document structure & word-frequency scoring."""
    form_summary, form_key_points = detect_and_synthesize_form_document(text)
    if form_summary and form_key_points:
        return form_summary, form_key_points

    sentences = robust_sentence_split(text)
    if not sentences:
        return text, [text]

    if len(sentences) <= 2:
        return text, sentences

    target_count = 2 if length == "short" else 5 if length == "long" else 3
    target_count = min(target_count, len(sentences))

    words = re.findall(r'\b[a-zA-Z]{3,}\b', text.lower())
    stop_words = {
        "the", "and", "is", "of", "to", "a", "in", "that", "it", "with", "as", "for", "was",
        "on", "are", "by", "an", "be", "this", "which", "or", "from", "at", "your",
        "all", "have", "new", "more", "they", "we", "can", "us", "has", "been", "their"
    }
    filtered_words = [w for w in words if w not in stop_words]
    freq_dist = Counter(filtered_words)
    max_freq = max(freq_dist.values()) if freq_dist else 1

    scored_sentences = []
    for i, sent in enumerate(sentences):
        sent_words = re.findall(r'\b[a-zA-Z]{3,}\b', sent.lower())
        score = sum(freq_dist[w] / max_freq for w in sent_words if w in freq_dist)

        if i == 0:
            score *= 1.4
        elif i == len(sentences) - 1:
            score *= 1.2

        scored_sentences.append((score, i, sent))

    scored_sentences.sort(key=lambda x: x[0], reverse=True)
    top_sentences = scored_sentences[:target_count]
    top_sentences.sort(key=lambda x: x[1])

    selected_texts = [s[2] for s in top_sentences]
    summary_text = " ".join(selected_texts)

    # Compute protected entities once from the full source text (more
    # context for spaCy to work with than the short summary alone), then
    # reuse it for both the summary and each key point.
    protected_entities = get_protected_entities(text)

    # Final grammar polish
    summary_text = fix_grammar_and_homophones(summary_text)
    summary_text = correct_spelling(summary_text, protected_entities)
    if summary_text and summary_text[-1] not in ".!?":
        summary_text += "."

    key_points = [correct_spelling(s, protected_entities) for s in selected_texts]

    return summary_text, key_points
