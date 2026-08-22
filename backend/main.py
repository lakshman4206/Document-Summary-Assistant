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
    detect_and_synthesize_form_document
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

    # 1. Clean formatting & OCR artifacts
    cleaned_input = clean_text_formatting(request.text.strip()[:8000])

    # 2. Check if text is a form/resume/structured application profile
    form_summary, form_key_points = detect_and_synthesize_form_document(cleaned_input)
    if form_summary and form_key_points:
        return SummaryResponse(
            summary=form_summary,
            key_points=form_key_points
        )

    summary_text = ""

    # 3. Attempt Hugging Face summarization if client is available
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

    # 4. If HF API was unavailable, missing token, or failed, use local NLP summarizer
    if not summary_text:
        summary_text, _ = local_textrank_summarize(cleaned_input, length=request.length)

    # 5. Apply spell correction to eliminate typos and tokenization glitches
    summary_text = correct_spelling(summary_text)

    # 6. Extract bullet points cleanly using NLTK robust sentence boundary splitting
    sentences = robust_sentence_split(summary_text)
    
    # Filter and format key points based on length preference
    target_count = 2 if request.length == "short" else 5 if request.length == "long" else 3
    key_points = [correct_spelling(s) for s in sentences[:target_count]]
    
    if not key_points:
        key_points = [summary_text]

    return SummaryResponse(
        summary=summary_text,
        key_points=key_points
    )