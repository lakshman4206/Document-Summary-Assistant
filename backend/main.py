import os
import re
import asyncio
from typing import Literal, List
from concurrent.futures import ThreadPoolExecutor

import ftfy
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from huggingface_hub import InferenceClient
from pydantic import BaseModel, Field

from spell_cleaner import (
    robust_sentence_split,
    local_textrank_summarize
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

hf_token = os.getenv("HF_TOKEN")
client = InferenceClient(api_key=hf_token) if hf_token else None

SUMMARIZER_MODEL = "facebook/bart-large-cnn"
GRAMMAR_MODEL = "vennify/t5-base-grammar-correction"

executor = ThreadPoolExecutor(max_workers=4)

LENGTH_PRESETS = {
    "short": {"max_length": 80, "min_length": 30, "key_points_count": 2},
    "medium": {"max_length": 150, "min_length": 60, "key_points_count": 3},
    "long": {"max_length": 300, "min_length": 120, "key_points_count": 5},
}

# Common English acronyms/initialisms worth preserving in ALL CAPS.
# Anything ALL-CAPS that is NOT in this set is treated as a casing glitch,
# not a real acronym (the old `len(word) <= 4` rule wrongly kept junk like
# "THE", "AND", "FOR" just because they were short).
KNOWN_ACRONYMS = {
    "AI", "ML", "NLP", "API", "URL", "HTTP", "HTTPS", "PDF", "CSV", "JSON",
    "XML", "HTML", "CSS", "SQL", "CEO", "CFO", "CTO", "USA", "UK", "EU",
    "UN", "NASA", "FBI", "CIA", "FAQ", "ID", "IT", "OS", "CPU", "GPU",
    "RAM", "USB", "TV", "PC", "UI", "UX", "GDP", "WHO", "NATO", "IPO",
}

# Name/place prefixes where a lowercase->uppercase transition is legitimate
# and should NOT be split into two words (e.g. "McDonald", "O'Brien").
NAME_PREFIX_EXCEPTIONS = re.compile(
    r"\b(Mc|Mac|O'|De|Di|La|Le|Van|Von|Al|El)[A-Z][a-z]+\b"
)


def fix_encoding_artifacts(text: str) -> str:
    """
    Repairs mojibake / broken UTF-8 (e.g. 'â€™' -> ''', 'Ã©' -> 'é') and
    stray BPE/WordPiece leftovers using ftfy, which is purpose-built for
    this rather than a hand-rolled character-class regex (the previous
    regex `[ĠÂÃâ€™â€œâ€\\x80-\\xff]` was invalid: multi-byte sequences
    like 'â€™' inside a character class are treated as individual
    characters, so it silently failed to strip them).
    """
    if not text:
        return ""

    # ftfy handles the vast majority of encoding mojibake robustly.
    text = ftfy.fix_text(text)

    # Remove genuine leftover BPE markers (Ġ = GPT-2/RoBERTa space marker,
    # ▁ = SentencePiece space marker) and WordPiece continuation fragments.
    text = text.replace("Ġ", " ").replace("▁", " ")
    text = re.sub(r"\s?##\w+", "", text)  # WordPiece leftover fragments (attached or standalone)

    # Collapse any double spacing introduced above.
    text = re.sub(r"[ \t]+", " ", text)

    # Fix broken HTML entities.
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")

    # Join separated contractions (e.g. "don ' t" -> "don't").
    text = re.sub(r"(\w+)\s+'\s+(s|t|re|ve|m|ll|d)\b", r"\1'\2", text, flags=re.IGNORECASE)

    return text.strip()


def filter_meaningless_tokens(text: str) -> str:
    """
    Removes genuinely meaningless single-character noise tokens while
    preserving legitimate short tokens (numbers, currency, punctuation).
    The previous version dropped ANY single non-listed character,
    including things like "3", "$", "%", "&" — fragmenting real sentences.
    """
    if not text:
        return ""

    ALLOWED_SINGLE_CHARS = set("aAiI.,-:;!?$%&@")

    words = text.split()
    filtered = []
    for w in words:
        core = w.strip(".,!?;:'\"()")
        if len(core) == 1 and core.isalpha() and core not in ALLOWED_SINGLE_CHARS:
            # A lone stray letter like "x" or "q" floating alone is noise.
            continue
        filtered.append(w)

    return " ".join(filtered)


def normalize_capitalization_and_spacing(text: str) -> str:
    """
    Fixes random uppercase words (e.g. "The DOCTOR Went TO the Hospital")
    and enforces proper sentence-case formatting, without mangling real
    acronyms or names.
    """
    if not text:
        return ""

    # 1. Fix spacing around punctuation (e.g., "hello . World" -> "hello. World")
    text = re.sub(r"\s+([.,!?;:])", r"\1", text)
    text = re.sub(r"([.,!?;:])(?=[A-Za-z])", r"\1 ", text)

    # 2. Convert random ALL-CAPS words back to normal case, UNLESS they are
    # a recognized acronym. (Old rule: "keep if len<=4 and isupper()" wrongly
    # preserved short junk like "THE"/"AND" and had no real acronym check.)
    def replace_random_caps(match):
        word = match.group(0)
        if word in KNOWN_ACRONYMS:
            return word
        # Sentence-initial capitalization is applied separately in step 3
        # below, so here we just lowercase — capitalizing here would wrongly
        # title-case every de-capped word, not just the first in a sentence.
        return word.lower()

    text = re.sub(r"\b[A-Z]{2,}\b", replace_random_caps, text)

    # 3. Enforce Sentence Case after punctuation.
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

    # Fix broken lines & hyphenation across line breaks.
    text = re.sub(r"(\w+)-\s*\n\s*(\w+)", r"\1\2", text)
    text = re.sub(r"(?<!\n)\n(?!\n)", " ", text)

    # Split words that got glued together (e.g. "wordAnotherWord"), but
    # skip legitimate name patterns like "McDonald" or "O'Brien", and
    # require at least 2 lowercase letters on both sides so we don't
    # split things like initials ("eBay", "iPhone").
    def split_glued_words(match):
        full = match.group(0)
        if NAME_PREFIX_EXCEPTIONS.match(full):
            return full
        return f"{match.group(1)} {match.group(2)}"

    text = re.sub(r"\b([a-z]{2,})([A-Z][a-z]{2,})", split_glued_words, text)

    text = re.sub(r"\s+", " ", text)
    return text.strip()


class SummaryRequest(BaseModel):
    text: str = Field(..., min_length=15, description="Document text to summarize.")
    length: Literal["short", "medium", "long"] = "medium"


class SummaryResponse(BaseModel):
    summary: str
    key_points: List[str]


@app.get("/health", tags=["Health"])
async def health():
    return {"status": "ok", "hf_client_active": client is not None}


@app.post("/api/summarize", response_model=SummaryResponse, tags=["Summarization"])
async def summarize(request: SummaryRequest):
    raw_text = request.text.strip()
    if not raw_text:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No document text provided."
        )

    loop = asyncio.get_running_loop()

    # Step 1: Deep text repair on input
    cleaned_input = await loop.run_in_executor(executor, deep_text_repair, raw_text[:12000])
    length_cfg = LENGTH_PRESETS[request.length]

    # Step 2: Extractive filtering for large texts
    if len(cleaned_input.split()) > 350:
        filtered_input, _ = await loop.run_in_executor(
            executor, local_textrank_summarize, cleaned_input, request.length
        )
    else:
        filtered_input = cleaned_input

    raw_summary = ""

    # Step 3: BART Abstractive Summarization
    if client:
        try:
            res = await loop.run_in_executor(
                executor,
                lambda: client.summarization(
                    text=filtered_input,
                    model=SUMMARIZER_MODEL,
                    parameters={
                        "max_length": length_cfg["max_length"],
                        "min_length": length_cfg["min_length"],
                        "do_sample": False
                    }
                )
            )
            extracted = res.summary_text.strip() if hasattr(res, "summary_text") else str(res).strip()
            if len(extracted) > 20:
                raw_summary = extracted
        except Exception as err:
            print(f"[Warning] Summarizer fallback triggered: {err}")

    # Fallback to TextRank if BART fails
    if not raw_summary:
        raw_summary, _ = await loop.run_in_executor(
            executor, local_textrank_summarize, cleaned_input, request.length
        )

    # Step 4: Multi-pass Artifact Cleaning & Capitalization Normalization
    # 4a. Repair encoding/BPE artifacts (mojibake, tokenizer leftovers)
    clean_text = await loop.run_in_executor(executor, fix_encoding_artifacts, raw_summary)

    # 4b. Remove genuinely meaningless stray single-character tokens
    clean_text = await loop.run_in_executor(executor, filter_meaningless_tokens, clean_text)

    # 4c. Enforce clean sentence casing and fix random capitalized words
    polished_summary = await loop.run_in_executor(executor, normalize_capitalization_and_spacing, clean_text)

    # Step 5: Clean Key Points extraction
    raw_sentences = robust_sentence_split(polished_summary)

    # Filter out empty or broken sentence fragments
    valid_sentences = [
        s for s in raw_sentences
        if len(s.split()) >= 4 and not re.search(r"[^\w\s.,!\?'\-]", s)
    ]

    target_count = length_cfg["key_points_count"]
    key_points = valid_sentences[:target_count] if valid_sentences else [polished_summary]

    return SummaryResponse(
        summary=polished_summary,
        key_points=key_points
    )
