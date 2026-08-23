import os
import re
import asyncio
from typing import Literal, List
from concurrent.futures import ThreadPoolExecutor

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
    version="3.0.0",
    description="Production-grade document summarization with neural grammar restoration."
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
GRAMMAR_MODEL = "vennify/t5-base-grammar-correction"  # Neural model specifically trained for sentence repair

executor = ThreadPoolExecutor(max_workers=4)

LENGTH_PRESETS = {
    "short": {"max_length": 90, "min_length": 35, "key_points_count": 2},
    "medium": {"max_length": 160, "min_length": 65, "key_points_count": 3},
    "long": {"max_length": 320, "min_length": 130, "key_points_count": 5},
}


class SummaryRequest(BaseModel):
    text: str = Field(..., min_length=15, description="Document text to summarize.")
    length: Literal["short", "medium", "long"] = "medium"


class SummaryResponse(BaseModel):
    summary: str
    key_points: List[str]


def deep_text_repair(text: str) -> str:
    """
    Advanced preprocessing to fix broken OCR artifacts, word collisions,
    and orphan line breaks before feeding text to AI models.
    """
    if not text:
        return ""

    # 1. Join words broken across lines with hyphens (e.g., "docu-\nment" -> "document")
    text = re.sub(r'(\w+)-\s*\n\s*(\w+)', r'\1\2', text)
    
    # 2. Convert orphan line breaks within sentences into single spaces
    text = re.sub(r'(?<!\n)\n(?!\n)', ' ', text)
    
    # 3. Fix glued words missing spaces after punctuation (e.g., "end.Start" -> "end. Start")
    text = re.sub(r'([a-z>])([A-Z])', r'\1 \2', text)
    text = re.sub(r'([.!?])([A-Za-z])', r'\1 \2', text)

    # 4. Normalize multiple whitespaces and control characters
    text = re.sub(r'\s+', ' ', text)
    
    return text.strip()


def sanitize_sentence(sentence: str) -> str:
    """
    Ensures generated sentences are grammatically complete and properly capitalized.
    """
    sentence = sentence.strip()
    if not sentence:
        return ""

    # Capitalize first letter
    sentence = sentence[0].upper() + sentence[1:]

    # Ensure valid ending punctuation
    if not sentence.endswith(('.', '!', '?')):
        sentence += '.'

    return sentence


def run_neural_grammar_fix(client_instance: InferenceClient, text: str) -> str:
    """
    Uses a dedicated Neural Transformer to fix broken syntax, agreement errors,
    and improper word order.
    """
    if not client_instance or len(text.strip()) < 10:
        return text

    try:
        # Prompt T5 to fix grammar explicitly
        prompt = f"grammar: {text}"
        res = client_instance.text_generation(
            prompt,
            model=GRAMMAR_MODEL,
            max_new_tokens=256
        )
        corrected = res.strip() if isinstance(res, str) else str(res).strip()
        return corrected if len(corrected) > 10 else text
    except Exception:
        # Graceful fallback to original text if grammar API fails
        return text


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

    # Step 1: Deep Text Cleaning & Word Collision Repair
    cleaned_input = await loop.run_in_executor(executor, deep_text_repair, raw_text[:12000])
    length_cfg = LENGTH_PRESETS[request.length]

    # Step 2: Extractive Noise Reduction for long texts
    if len(cleaned_input.split()) > 350:
        filtered_input, _ = await loop.run_in_executor(
            executor, local_textrank_summarize, cleaned_input, request.length
        )
    else:
        filtered_input = cleaned_input

    raw_summary = ""

    # Step 3: Neural Abstractive Summarization via BART
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
            print(f"[Warning] Neural Summarizer fallback triggered: {err}")

    # Fallback to local TextRank if HF API fails
    if not raw_summary:
        raw_summary, _ = await loop.run_in_executor(
            executor, local_textrank_summarize, cleaned_input, request.length
        )

    # Step 4: Neural Sentence & Grammar Correction Pass
    # Offloads grammar restructuring to a secondary neural model
    if client:
        polished_summary = await loop.run_in_executor(
            executor, run_neural_grammar_fix, client, raw_summary
        )
    else:
        polished_summary = raw_summary

    polished_summary = sanitize_sentence(polished_summary)

    # Step 5: Sentence Boundary Splitting & Bullet Point Validation
    raw_sentences = robust_sentence_split(polished_summary)
    
    # Filter out fragmented or incomplete sentences (under 4 words)
    valid_sentences = [
        sanitize_sentence(s) for s in raw_sentences 
        if len(s.split()) >= 4
    ]

    target_count = length_cfg["key_points_count"]
    key_points = valid_sentences[:target_count] if valid_sentences else [polished_summary]

    return SummaryResponse(
        summary=polished_summary,
        key_points=key_points
    )
