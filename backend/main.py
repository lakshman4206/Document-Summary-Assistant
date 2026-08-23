import os
import asyncio
from typing import Literal, List
from concurrent.futures import ThreadPoolExecutor

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from huggingface_hub import InferenceClient
from pydantic import BaseModel, Field

from spell_cleaner import (
    clean_text_formatting,
    correct_spelling,
    robust_sentence_split,
    local_textrank_summarize,
    fix_grammar_and_homophones
)

load_dotenv()

app = FastAPI(
    title="Document Summary Assistant API",
    version="2.0.0",
    description="High-performance hybrid document summarization engine."
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
MODEL = "facebook/bart-large-cnn"

# Thread pool executor for offloading synchronous CPU-bound NLP processing
executor = ThreadPoolExecutor(max_workers=4)

# Length configuration mappings for BART API
LENGTH_PRESETS = {
    "short": {"max_length": 80, "min_length": 30, "key_points_count": 2},
    "medium": {"max_length": 150, "min_length": 60, "key_points_count": 3},
    "long": {"max_length": 300, "min_length": 120, "key_points_count": 5},
}


class SummaryRequest(BaseModel):
    text: str = Field(..., min_length=10, description="Source document text to summarize.")
    length: Literal["short", "medium", "long"] = "medium"


class SummaryResponse(BaseModel):
    summary: str
    key_points: List[str]


def _sync_post_process(text: str) -> str:
    """Helper to apply grammar and spell correction in a single pass."""
    text = correct_spelling(text)
    text = fix_grammar_and_homophones(text)
    return text.strip()


@app.get("/", tags=["Health"])
async def root():
    return {"message": "Document Summary Assistant API v2.0 is running"}


@app.get("/health", tags=["Health"])
async def health():
    return {"status": "ok", "hf_client_active": client is not None}


@app.post(
    "/api/summarize",
    response_model=SummaryResponse,
    status_code=status.HTTP_200_OK,
    tags=["Summarization"]
)
async def summarize(request: SummaryRequest):
    raw_text = request.text.strip()
    if not raw_text:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No document text was provided."
        )

    # 1. Cleaning and normalization
    cleaned_input = clean_text_formatting(raw_text[:12000])
    length_cfg = LENGTH_PRESETS[request.length]
    summary_text = ""

    # 2. Hybrid Extractive Reduction (Prepare chunk if text is long)
    # Offload local TextRank to thread pool so it doesn't block FastAPI event loop
    loop = asyncio.get_running_loop()
    
    if len(cleaned_input.split()) > 400:
        # Pre-extract most important content to fit transformer context window efficiently
        pre_filtered_input, _ = await loop.run_in_executor(
            executor, 
            local_textrank_summarize, 
            cleaned_input, 
            request.length
        )
    else:
        pre_filtered_input = cleaned_input

    # 3. Attempt Neural Summarization (Inference Client)
    if client:
        try:
            # Run blocking HF call in thread executor to keep API responsive
            res = await loop.run_in_executor(
                executor,
                lambda: client.summarization(
                    text=pre_filtered_input,
                    model=MODEL,
                    parameters={
                        "max_length": length_cfg["max_length"],
                        "min_length": length_cfg["min_length"],
                        "do_sample": False
                    }
                )
            )
            raw_summary = res.summary_text.strip() if hasattr(res, "summary_text") else str(res).strip()
            if raw_summary and len(raw_summary) > 20:
                summary_text = raw_summary
        except Exception as error:
            print(f"[Warning] Hugging Face API fallback triggered: {error}")

    # 4. Fallback to Local TextRank if HF API is unconfigured/fails
    if not summary_text:
        summary_text, _ = await loop.run_in_executor(
            executor, 
            local_textrank_summarize, 
            cleaned_input, 
            request.length
        )

    # 5. Non-blocking single-pass Post-Processing
    polished_summary = await loop.run_in_executor(
        executor, 
        _sync_post_process, 
        summary_text
    )

    # 6. Extract Key Points efficiently from the polished summary
    sentences = robust_sentence_split(polished_summary)
    target_count = length_cfg["key_points_count"]
    
    key_points = sentences[:target_count] if sentences else [polished_summary]

    return SummaryResponse(
        summary=polished_summary,
        key_points=key_points
    )
