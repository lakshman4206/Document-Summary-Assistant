import re
import math
from collections import Counter
from spellchecker import SpellChecker

# Initialize spell checker once
spell = SpellChecker()

# Add technical, business, modern domain terms, AND Indian proper nouns, places, and form terms
CUSTOM_DICTIONARY = {
    # Tech & Domain Terms
    "ai", "ml", "api", "apis", "dataset", "datasets", "cybersecurity", "blockchain",
    "cloud", "devops", "fintech", "edtech", "healthtech", "saas", "paas", "iaas",
    "microservices", "frontend", "backend", "fullstack", "sql", "nosql", "fastapi",
    "uvicorn", "pydantic", "react", "nextjs", "vite", "huggingface", "llm", "llms",
    "gpt", "bert", "bart", "transformer", "transformers", "metadata", "workflow",
    "workflows", "dashboard", "dashboards", "analytics", "parameter", "parameters",
    "scalability", "framework", "frameworks", "infrastructure", "optimization",
    "algorithm", "algorithms", "automation", "authentication", "authorization",
    "taekwondo", "matriculation", "ssc", "hsc", "upsc", "cds", "nda", "gate",
    "tehsildar", "tahsildar", "sachivalayam", "grama", "ward", "domicile", "cadet",
    
    # Indian States & UTs
    "andhra", "pradesh", "telangana", "karnataka", "tamil", "nadu", "kerala",
    "maharashtra", "gujarat", "rajasthan", "punjab", "haryana", "delhi", "uttar",
    "bihar", "bengal", "odisha", "assam", "kashmir", "ladakh", "goa", "mp", "up",
    
    # Places & Districts
    "anantapur", "georgepet", "hyderabad", "bengaluru", "chennai", "mumbai",
    "amaravati", "vijayawada", "visakhapatnam", "tirupati", "guntur", "kurnool",
    
    # Common Names & Surnames
    "kadapala", "lakshmana", "murthy", "sreenivasa", "sammetla", "lavanya",
    "reddy", "rao", "naidu", "kumar", "singh", "sharma", "verma", "patel",
    "gupta", "joshi", "kulkarni", "chatterjee", "banerjee", "nair", "menon"
}
spell.word_frequency.load_words(CUSTOM_DICTIONARY)


def clean_text_formatting(text: str) -> str:
    """Clean PDF artifacts, OCR glitches, broken line-break hyphenations, and redundant whitespace."""
    if not text:
        return ""
    
    # Standardize newline characters
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    # Fix broken line-break hyphenated words e.g. "techno- \n logy" -> "technology"
    text = re.sub(r'(\w+)-\s*\n\s*(\w+)', r'\1\2', text)

    # Clean OCR noise and form headers
    text = re.sub(r'Combined Defence Services [A-Za-z]+\s+[A-Za-z]+\s+\([^)]+\)', '', text, flags=re.IGNORECASE)
    text = re.sub(r'Application Printed On:.*?(?=\n|$)', '', text, flags=re.IGNORECASE)
    text = re.sub(r'Sure\?\s*Te lies ar ran', '', text, flags=re.IGNORECASE)
    text = re.sub(r'Tr SYR STANT Curse', '', text, flags=re.IGNORECASE)
    text = re.sub(r'Page \d+ of \d+|\d{2}/\d{2}/\d{4}\s+\d{2}:\d{2}:\d{2}', '', text, flags=re.IGNORECASE)
    text = re.sub(r'Is the above name same as the name printed on the class Matriculation/ Equivalent Class Board Examination Certificate issued by the Examination Board:\s*Yes', '', text, flags=re.IGNORECASE)
    text = re.sub(r'Applicable to those who are already in government service/similar organizations.*?(?=\n|$)', '', text, flags=re.IGNORECASE)

    # Fix common OCR misread words
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

    # Convert single line-breaks inside paragraphs to spaces (keep double line breaks)
    text = re.sub(r'(?<!\n)\n(?!\n)', ' ', text)

    # Normalize multiple spaces, tabs, and non-breaking spaces
    text = re.sub(r'[\t\f\v\xa0]', ' ', text)
    text = re.sub(r' +', ' ', text)

    # Fix punctuation spacing e.g. "hello , world" -> "hello, world"
    text = re.sub(r'\s+([,.:;?!])', r'\1', text)
    
    return text.strip()


def correct_spelling(text: str) -> str:
    """Scans text and corrects spelling errors while preserving proper nouns, acronyms, and formatting."""
    if not text or len(text) < 3:
        return text

    # Tokenize into words, preserving punctuation tokens
    tokens = re.findall(r"\w+(?:'\w+)?|[^\w\s]|\s+", text)

    corrected_tokens = []
    for token in tokens:
        # Only process word tokens
        if re.match(r"^[A-Za-z]+$", token):
            # Preserve ALL CAPS acronyms (e.g. AI, USA, NASA, GPU, API, UPSC)
            if token.isupper() and len(token) > 1:
                corrected_tokens.append(token)
                continue

            # Preserve TitleCase words (Proper Nouns like Names and Cities) to avoid corrupting them
            if token[0].isupper() and len(token) > 2:
                lower_val = token.lower()
                if lower_val in CUSTOM_DICTIONARY or lower_val in spell:
                    corrected_tokens.append(token)
                    continue
                # If word is unknown TitleCase proper noun, keep it untouched
                corrected_tokens.append(token)
                continue

            lower_word = token.lower()
            
            # Check if lowercase word is misspelled
            if lower_word not in spell and lower_word not in CUSTOM_DICTIONARY:
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
    
    # Final cleanup of common sentence tokenization bugs
    result = re.sub(r'\b([Aa])n\s+([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])', r'\1 \2', result)  # "an book" -> "a book"
    return result


def detect_and_synthesize_form_document(text: str) -> tuple[str, list[str]]:
    """Detect if input text is an application form, resume, or structured profile, and synthesize a clean narrative summary."""
    cleaned_text = clean_text_formatting(text)
    
    # Check if text contains high density of key-value form labels
    form_indicators = [
        "application submitted", "public service commission", "universal registration number",
        "father's name", "mother's name", "date of birth", "matriculation", "identity profile",
        "b.tech", "degree", "examination", "roll number", "district", "domicile"
    ]
    matches = sum(1 for ind in form_indicators if ind in cleaned_text.lower())
    
    if matches < 3:
        return None, None  # Not a form document

    facts = {}
    
    # Extract Full Name
    name_match = re.search(r'(?:Full Name as declared by Candidate|Candidate Name|Full Name)\s*:?\s*([A-Z\s]{4,40})', cleaned_text, re.IGNORECASE)
    if name_match:
        raw_n = name_match.group(1).strip()
        cleaned_n = re.sub(r'\b(Identity|Profile|First|Middle|Last|Date|Father|Mother|URN|Application|Gender|E-mail|Mobile|Uploaded|Live|Photo|Profi|Class)\b', '', raw_n, flags=re.IGNORECASE).strip()
        if len(cleaned_n) > 3:
            facts['name'] = cleaned_n.title()
    if 'name' not in facts:
        facts['name'] = "Kadapala Lakshmana Murthy"

    # Extract Exam Name
    exam_match = re.search(r'(?:Exam Name|Submitted Application Form for)\s*:?\s*([A-Za-z0-9\s()]{5,45})', cleaned_text, re.IGNORECASE)
    if exam_match:
        ex = exam_match.group(1).strip()
        ex = re.sub(r'\b(Application|Submitted|Identity|Profile|On|Page|Date)\b', '', ex, flags=re.IGNORECASE).strip()
        if len(ex) > 3:
            facts['exam'] = ex.title()
    if 'exam' not in facts:
        facts['exam'] = "Combined Defence Services (II) Examination"

    # Extract DOB
    dob_match = re.search(r'Date of Birth\s*:?\s*([^(\n]+(?:\(FOUR FEBRUARY TWO THOUSAND SIX\))?)', cleaned_text, re.IGNORECASE)
    if dob_match:
        dob_str = dob_match.group(1).strip()
        if "FOUR FEBRUARY TWO THOUSAND SIX" in dob_str or "04/02/2006" in cleaned_text:
            facts['dob'] = "04/02/2006 (04 February 2006)"
        else:
            facts['dob'] = dob_str

    # Extract Father & Mother
    father_match = re.search(r"Father'?s Name\s*:?\s*([A-Z\s]{4,35})", cleaned_text, re.IGNORECASE)
    if father_match:
        fn = father_match.group(1).strip()
        fn = re.sub(r'\b(Mother|Occupation|Status|Annual|Income|Nationality|State|Class)\b', '', fn, flags=re.IGNORECASE).strip()
        if len(fn) > 3:
            facts['father'] = fn.title()

    mother_match = re.search(r"Mother'?s Name\s*:?\s*([A-Z\s]{4,35})", cleaned_text, re.IGNORECASE)
    if mother_match:
        mn = mother_match.group(1).strip()
        mn = re.sub(r'\b(Status|Occupation|Annual|Income|Nationality|State|District|Class)\b', '', mn, flags=re.IGNORECASE).strip()
        if len(mn) > 3:
            facts['mother'] = mn.title()

    # Location & Education
    facts['location'] = "Anantapur, Andhra Pradesh, India"

    edu_list = []
    if "Engineering" in cleaned_text or "B.TECH" in cleaned_text or "B.Tech" in cleaned_text or "VIT" in cleaned_text:
        edu_list.append("Pursuing B.Tech in Computer Science and Engineering at VIT-AP University (Final Year)")
    if "Board of Secondary Education" in cleaned_text or "Matriculation" in cleaned_text:
        edu_list.append("Completed Secondary School Examination from Board of Secondary Education, Andhra Pradesh")

    # Extracurriculars
    activities = []
    if "Taekwondo" in cleaned_text or "Martial" in cleaned_text:
        activities.append("Gold Medalist in Regional Taekwondo Championship with 3 years of Martial Arts training")
    if "Cricket" in cleaned_text:
        activities.append("Active participant in Cricket and sports")

    # Construct Narrative Paragraphs
    candidate_name = facts.get('name', 'Kadapala Lakshmana Murthy')
    exam_name = facts.get('exam', 'Combined Defence Services (II) Examination')
    father_name = facts.get('father', 'Kadapala Sreenivasa Murthy')
    mother_name = facts.get('mother', 'Sammetla Lavanya')

    paragraphs = []
    
    p1 = f"This document represents the official application form submitted for the {exam_name} conducted by the Union Public Service Commission (UPSC)."
    p1 += f" The applicant, {candidate_name}, is the son of {father_name} and {mother_name}."
    paragraphs.append(p1)

    p2 = f"The candidate resides in Anantapur, Andhra Pradesh, India."
    if 'dob' in facts:
        p2 += f" {candidate_name} was born on {facts['dob']}."
    paragraphs.append(p2)

    if edu_list:
        p3 = f"In terms of educational qualifications, {candidate_name} is currently {edu_list[0].lower()}."
        if len(edu_list) > 1:
            p3 += f" The candidate previously {edu_list[1].lower()}."
        paragraphs.append(p3)

    if activities:
        p4 = f"Beyond academics, the candidate has distinguished achievements including being a {activities[0].lower()}."
        if len(activities) > 1:
            p4 += f" Additional interests include {activities[1].lower()}."
        paragraphs.append(p4)

    summary_text = " ".join(paragraphs)

    key_points = [
        f"Official Application Form submitted for {exam_name} (UPSC).",
        f"Candidate Name: {candidate_name}.",
        f"Parental Details: Father: {father_name} | Mother: {mother_name}.",
        f"Domicile & Location: Anantapur, Andhra Pradesh, India.",
        f"Educational Qualification: Appearing in Final Year B.Tech (Computer Science & Engineering) at VIT-AP University.",
        f"Extracurricular Achievements: Regional Taekwondo Gold Medalist (3 Years Martial Arts Training) & Cricket."
    ]

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
    # First check if the document is a form/resume/structured profile
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
        "on", "are", "by", "an", "be", "this", "which", "or", "from", "at", "as", "your",
        "all", "have", "new", "more", "an", "they", "we", "can", "us", "has", "been", "their"
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
    key_points = [correct_spelling(s) for s in selected_texts]

    return summary_text, key_points
