import re
import math
from collections import Counter
from spellchecker import SpellChecker

# Initialize spell checker once
spell = SpellChecker()

# Add technical, business, and modern domain terms to custom dictionary to prevent false correction
CUSTOM_DICTIONARY = {
    "ai", "ml", "api", "apis", "dataset", "datasets", "cybersecurity", "blockchain",
    "cloud", "devops", "fintech", "edtech", "healthtech", "saas", "paas", "iaas",
    "microservices", "frontend", "backend", "fullstack", "sql", "nosql", "fastapi",
    "uvicorn", "pydantic", "react", "nextjs", "vite", "huggingface", "llm", "llms",
    "gpt", "bert", "bart", "transformer", "transformers", "metadata", "workflow",
    "workflows", "dashboard", "dashboards", "analytics", "parameter", "parameters",
    "scalability", "framework", "frameworks", "infrastructure", "optimization",
    "algorithm", "algorithms", "automation", "authentication", "authorization"
}
spell.word_frequency.load_words(CUSTOM_DICTIONARY)


def clean_text_formatting(text: str) -> str:
    """Clean PDF artifacts, broken line-break hyphenations, and redundant whitespace."""
    if not text:
        return ""
    
    # Standardize newline characters
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    # Fix broken line-break hyphenated words e.g. "techno- \n logy" -> "technology"
    text = re.sub(r'(\w+)-\s*\n\s*(\w+)', r'\1\2', text)

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
            # Preserve ALL CAPS acronyms (e.g. AI, USA, NASA, GPU, API)
            if token.isupper() and len(token) > 1:
                corrected_tokens.append(token)
                continue

            # Preserve camelCase or mixed case tokens
            if any(c.isupper() for c in token[1:]):
                corrected_tokens.append(token)
                continue

            lower_word = token.lower()
            
            # Check if word is misspelled
            if lower_word not in spell:
                correction = spell.correction(lower_word)
                if correction and correction != lower_word:
                    # Maintain original capitalization (TitleCase vs lowercase)
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

    # Safe regex fallback: protect common abbreviations before sentence splitting
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
    """Local extractive summarization fallback based on word-frequency and position scoring."""
    sentences = robust_sentence_split(text)
    if not sentences:
        return text, [text]
    
    if len(sentences) <= 2:
        return text, sentences

    # Target sentence count based on requested length
    target_count = 2 if length == "short" else 5 if length == "long" else 3
    target_count = min(target_count, len(sentences))

    # Tokenize words for term frequency calculation
    words = re.findall(r'\b[a-zA-Z]{3,}\b', text.lower())
    stop_words = {
        "the", "and", "is", "of", "to", "a", "in", "that", "it", "with", "as", "for", "was",
        "on", "are", "by", "an", "be", "this", "which", "or", "from", "at", "as", "your",
        "all", "have", "new", "more", "an", "they", "we", "can", "us", "has", "been", "their"
    }
    filtered_words = [w for w in words if w not in stop_words]
    freq_dist = Counter(filtered_words)
    max_freq = max(freq_dist.values()) if freq_dist else 1

    # Score sentences based on term frequency & sentence position
    scored_sentences = []
    for i, sent in enumerate(sentences):
        sent_words = re.findall(r'\b[a-zA-Z]{3,}\b', sent.lower())
        score = sum(freq_dist[w] / max_freq for w in sent_words if w in freq_dist)
        
        # Position boost for lead and closing sentences
        if i == 0:
            score *= 1.4
        elif i == len(sentences) - 1:
            score *= 1.2

        scored_sentences.append((score, i, sent))

    # Pick top N sentences by score
    scored_sentences.sort(key=lambda x: x[0], reverse=True)
    top_sentences = scored_sentences[:target_count]
    
    # Sort selected sentences back to original chronological order
    top_sentences.sort(key=lambda x: x[1])

    selected_texts = [s[2] for s in top_sentences]
    summary_text = " ".join(selected_texts)
    
    # Key points: bullet list of selected sentences
    key_points = [correct_spelling(s) for s in selected_texts]

    return summary_text, key_points
