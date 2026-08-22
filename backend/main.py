import os
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from huggingface_hub import InferenceClient
from pydantic import BaseModel

from spell_cleaner import (
    clean_text_formatting,
    correct_spelling,
    robust_sentence_split,
    local_textrank_summarize,
    fix_grammar_and_homophones
)

load_dotenv()

app = FastAPI(
    title="Document Summary Assistant API"
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


class SummaryRequest(BaseModel):
    text: str
    length: Literal["short", "medium", "long"] = "medium"


class SummaryResponse(BaseModel):
    summary: str
    key_points: list[str]


@app.get("/")
def root():
    return {
        "message": "Document Summary Assistant API is running"
    }


@app.get("/health")
def health():
    return {
        "status": "ok"
    }


@app.post(
    "/api/summarize",
    response_model=SummaryResponse
)
def summarize(request: SummaryRequest):
    if not request.text or not request.text.strip():
        raise HTTPException(
            status_code=400,
            detail="No document text was provided."
        )

    # 1. Clean formatting, broken hyphens, & OCR artifacts generically
    cleaned_input = clean_text_formatting(request.text.strip()[:8000])

    summary_text = ""

    # 2. Attempt Hugging Face neural summarization if client is available
    if client:
        try:
            res = client.summarization(
                text=cleaned_input,
                model=MODEL
            )
            raw_summary = res.summary_text.strip() if hasattr(res, "summary_text") else str(res).strip()
            if raw_summary and len(raw_summary) > 20:
                summary_text = raw_summary
        except Exception as error:
            print("Hugging Face API unavailable or returned error:", repr(error))

    # 3. If HF API was unavailable, missing token, or failed, use smart local NLP summarizer
    if not summary_text:
        summary_text, _ = local_textrank_summarize(cleaned_input, length=request.length)

    # 4. Apply spell and grammar corrections to ensure pristine fluency and sentence formation
    summary_text = correct_spelling(summary_text)
    summary_text = fix_grammar_and_homophones(summary_text)

    # 5. Extract bullet points cleanly using robust sentence boundary splitting
    sentences = robust_sentence_split(summary_text)
    
    target_count = 2 if request.length == "short" else 5 if request.length == "long" else 3
    key_points = [fix_grammar_and_homophones(correct_spelling(s)) for s in sentences[:target_count]]
    
    if not key_points:
        key_points = [summary_text]

    return SummaryResponse(
        summary=summary_text,
        key_points=key_points
    )