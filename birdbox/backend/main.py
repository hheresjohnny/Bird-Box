from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
import httpx, os
from dotenv import load_dotenv
 
load_dotenv()
 
app = FastAPI()
MAPS_KEY = os.getenv("GOOGLE_MAPS_API_KEY")
 
# Allow your index.html (any origin) to call this during dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
 
# ── 1. Reverse geocode: coords → human-readable address ──────
@app.get("/location/address")
async def get_address(lat: float, lng: float):
    async with httpx.AsyncClient() as client:
        r = await client.get(
            "https://maps.googleapis.com/maps/api/geocode/json",
            params={"latlng": f"{lat},{lng}", "key": MAPS_KEY}
        )
    data = r.json()
    if data["status"] == "OK":
        return {"address": data["results"][0]["formatted_address"]}
    return {"address": "Unknown location", "error": data["status"]}
 
 
# ── 2. Nearby places search: "Starbucks near me" ─────────────
@app.get("/places/nearby")
async def nearby_places(
    lat: float,
    lng: float,
    query: str = Query(..., description="e.g. Starbucks, pharmacy, hospital")
):
    async with httpx.AsyncClient() as client:
        r = await client.get(
            "https://maps.googleapis.com/maps/api/place/textsearch/json",
            params={
                "query": query,
                "location": f"{lat},{lng}",
                "radius": 2000,        # 2km radius
                "key": MAPS_KEY
            }
        )
    data = r.json()
    results = []
    for p in data.get("results", [])[:3]:   # top 3 only
        loc = p["geometry"]["location"]
        results.append({
            "name":     p["name"],
            "address":  p.get("vicinity") or p.get("formatted_address", ""),
            "lat":      loc["lat"],
            "lng":      loc["lng"],
            "place_id": p["place_id"],
        })
    return {"places": results}
 
 
# ── 3. Directions: step-by-step walking directions ────────────
@app.get("/directions")
async def get_directions(
    origin_lat: float,
    origin_lng: float,
    dest_lat:   float,
    dest_lng:   float,
):
    async with httpx.AsyncClient() as client:
        r = await client.get(
            "https://maps.googleapis.com/maps/api/directions/json",
            params={
                "origin":      f"{origin_lat},{origin_lng}",
                "destination": f"{dest_lat},{dest_lng}",
                "mode":        "walking",
                "key":         MAPS_KEY
            }
        )
    data = r.json()
    if data["status"] != "OK":
        return {"steps": [], "error": data["status"]}
 
    leg = data["routes"][0]["legs"][0]
    steps = []
    for s in leg["steps"]:
        # strip HTML tags from instructions
        import re
        instruction = re.sub(r"<[^>]+>", "", s["html_instructions"])
        steps.append({
            "instruction": instruction,
            "distance":    s["distance"]["text"],
            "duration":    s["duration"]["text"],
        })
    return {
        "total_distance": leg["distance"]["text"],
        "total_duration": leg["duration"]["text"],
        "steps": steps
    }
 