# ADU Feasibility Starter

Modern starter app for an Arlington, VA ADU feasibility checker.

## Run the backend

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload
```

The API will run at `http://127.0.0.1:8000`.

## Run the frontend

Open `frontend/index.html` in a browser. The frontend uses ArcGIS directly and calls the local FastAPI backend for eligibility checks.

## Current scope

- Arlington GIS map and parcel lookup remain in browser JavaScript.
- Eligibility rules are implemented in Python using the newer product specification.
- The UI uses a left-side step wizard with address/contact, core eligibility, ADU type, project details, parking, and occupancy/result steps.
- For detached ADUs, the frontend computes and draws a preliminary buildable envelope from GIS geometry when possible.
- Email capture is included in the request payload but not stored yet.
- Database, paid reports, LLM calls, and partner routing are intentionally deferred.
