import os
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from huggingface_hub import InferenceClient
from pydantic import BaseModel

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

if not hf_token:
    raise RuntimeError(
        "HF_TOKEN is not configured."
    )

client = InferenceClient(
    api_key=hf_token
)

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

    if not request.text.strip():
        raise HTTPException(
            status_code=400,
            detail="No document text was provided."
        )

    clean_text = request.text.strip()[:4000]

    min_len = 25 if request.length == "short" else 90 if request.length == "long" else 40
    max_len = 75 if request.length == "short" else 260 if request.length == "long" else 140

    try:
        res = client.summarization(
            text=clean_text,
            model=MODEL
        )

        summary_text = res.summary_text.strip() if hasattr(res, "summary_text") else str(res).strip()

        # Split into key points
        import re
        sentences = [s.strip() for s in re.split(r'(?<=[.!?])\s+', summary_text) if len(s.strip()) > 15]
        key_points = sentences[:2 if request.length == "short" else 6 if request.length == "long" else 4]
        if not key_points:
            key_points = [summary_text]

        return SummaryResponse(
            summary=summary_text,
            key_points=key_points
        )

    except Exception as error:
        print("HUGGING FACE ERROR:", repr(error))
        raise HTTPException(
            status_code=500,
            detail=str(error)
        )