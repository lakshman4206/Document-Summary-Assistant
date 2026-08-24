import os
import re
import asyncio
from typing import Literal, List

import ftfy
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from pydantic import BaseModel, Field

from spell_cleaner import (
    robust_sentence_split,
    local_textrank_summarize,
    correct_spelling,
    get_protected_entities
)

load_dotenv()

app = FastAPI(
    title="Document Summary Assistant API",
    version="4.1.0",
    description="Production API with strict BPE artifact removal and case normalization."
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"]
)

# Initialize the Gemini Gen AI Client natively
# The client automatically picks up the 'GEMINI_API_KEY' environment variable.
try:
    gemini_client = genai.Client()
except Exception as init_err:
    gemini_client = None
    print(f"Gemini initialization warning: {init_err}")

# Using gemini-2.5-flash which is free, incredibly fast, and handles high-context text
GEMINI_MODEL = "gemini-2.5-flash"

LENGTH_PRESETS = {
    "short": {"max_length": 80, "min_length": 30, "key_points_count": 2},
    "medium": {"max_length": 150, "min_length": 60, "key_points_count": 3},
    "long": {"max_length": 300, "min_length": 120, "key_points_count": 5},
}

# Common English acronyms/initialisms worth preserving in ALL CAPS.
KNOWN_ACRONYMS = {
    "AI", "ML", "NLP", "API", "URL", "HTTP", "HTTPS", "PDF", "CSV", "JSON",
    "XML", "HTML", "CSS", "SQL", "CEO", "CFO", "CTO", "USA", "UK", "EU",
    "UN", "NASA", "FBI", "CIA", "FAQ", "ID", "IT", "OS", "CPU", "GPU",
    "RAM", "USB", "TV", "PC", "UI", "UX", "GDP", "WHO", "NATO", "IPO",
    "SSC", "HSC", "UPSC", "CDS", "NDA", "GATE",
}

# Name/place prefixes where a lowercase->uppercase transition is legitimate
NAME_PREFIX_EXCEPTIONS = re.compile(
    r"\b(Mc|Mac|O'|De|Di|La|Le|Van|Von|Al|El)[A-Z][a-z]+\b"
)


def fix_encoding_artifacts(text: str) -> str:
    """Repairs mojibake / broken UTF-8 and stray BPE/WordPiece leftovers."""
    if not text:
        return ""

    text = ftfy.fix_text(text)
    text = text.replace("Ġ", " ").replace("▁", " ")
    text = re.sub(r"\s?##\w+", "", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    text = re.sub(r"(\w+)\s+'\s+(s|t|re|ve|m|ll|d)\b", r"\1'\2", text, flags=re.IGNORECASE)
    return text.strip()


def filter_meaningless_tokens(text: str) -> str:
    """Removes genuinely meaningless single-character noise tokens."""
    if not text:
        return ""

    ALLOWED_SINGLE_CHARS = set("aAiI.,-:;!?$%&@")
    words = text.split()
    filtered = []
    for w in words:
        core = w.strip(".,!?;:'\"()")
        if len(core) == 1 and core.isalpha() and core not in ALLOWED_SINGLE_CHARS:
            continue
        filtered.append(w)

    return " ".join(filtered)


def normalize_capitalization_and_spacing(text: str) -> str:
    """Fixes random uppercase words and enforces sentence-case formatting."""
    if not text:
        return ""

    text = re.sub(r"\s+([.,!?;:])", r"\1", text)
    text = re.sub(r"([.,!?;:])(?=[A-Za-z])", r"\1 ", text)
    text = re.sub(r"([.!?]\s+)([a-z])", lambda m: m.group(1) + m.group(2).upper(), text)

    def replace_random_caps(match):
        word = match.group(0)
        if word in KNOWN_ACRONYMS:
            return word
        return word.lower()

    text = re.sub(r"\b[A-Z]{2,}\b", replace_random_caps, text)

    sentences = robust_sentence_split(text)
    fixed_sentences = []
    for s in sentences:
        s = s.strip()
        if not s:
            continue
        first_char = s[0].upper()
        rest = s[1:]
        s_clean = first_char + rest
        if not s_clean.endswith((".", "!", "?")):
            s_clean += "."
        fixed_sentences.append(s_clean)

    return " ".join(fixed_sentences)


def deep_text_repair(text: str) -> str:
    """Pre-cleans raw document text before feeding it to models."""
    if not text:
        return ""

    text = re.sub(r"(\w+)-\s*\n\s*(\w+)", r"\1\2", text)
    text = re.sub(r"(?<!\n)\n(?!\n)", " ", text)

    def split_glued_words(match):
        full = match.group(0)
        if NAME_PREFIX_EXCEPTIONS.match(full):
            return full
        return f"{match.group(1)} {match.group(2)}"

    text = re.sub(r"\b([a-z]{2,})([A-Z][a-z]{2,})", split_glued_words, text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


async def apply_ai_grammar_polish(text: str) -> str:
    """
    Sends cleaned text blocks to Google Gemini API using native non-blocking 
    async call logic (`client.aio`) for grammar and syntax correction.
    """
    if not text or not text.strip():
        return ""

    if not gemini_client:
        # Fallback safety layer if environment variables fail
        return text

    try:
        # Utilizing client.aio ensures complete asynchronous handling natively
        response = await gemini_client.aio.models.generate_content(
            model=GEMINI_MODEL,
            contents=(
                "Fix any remaining grammatical mistakes, punctuation errors, or awkward phrasing "
                "in the following text. Do NOT change the original facts or add extra interpretations. "
                "Return only the corrected text content, nothing else:\n\n"
                f"{text}"
            )
        )
        if response and response.text:
            return response.text.strip()
        return text

    except Exception as gemini_err:
        # Catch and print connection/quota errors; fall back to original text safely
        print(f"Gemini API Grammar Polish Error: {gemini_err}")
        return text
