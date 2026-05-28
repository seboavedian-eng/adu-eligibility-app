from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.schemas.eligibility import EligibilityRequest, EligibilityResponse
from app.services.eligibility_engine import check_eligibility

app = FastAPI(title="ADU Feasibility API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/check-eligibility", response_model=EligibilityResponse)
def run_eligibility_check(payload: EligibilityRequest) -> EligibilityResponse:
    return check_eligibility(payload)
