# BirdBox

Over 250 million people worldwide live with visual impairment, yet most assistive navigation tools are either expensive, bulky, or require specialized hardware. We wanted to build something that anyone could use right now, with just the phone already in their pocket. BirdBox was born from a simple question: what if your phone could be your eyes?

---

## What it does

BirdBox is a real-time AI-powered navigation assistant for visually impaired users. You hold your phone in front of you and it continuously analyzes your surroundings through the camera. If it spots a hazard, a step, a door, or a person in your path, it speaks a warning aloud and vibrates with a distinct haptic pattern so you always know the severity.

Beyond obstacle detection, BirdBox includes full voice-controlled navigation. Say "Hey BirdBox, take me to the nearest Burger King," and it searches nearby, reads out your options, and guides you turn by turn with spoken directions and haptic cues at every step.

A companion web dashboard lets a caregiver, family member, or support worker watch the user's live location on a map, see every hazard the AI detects in real time, and track the full movement history, all streamed the moment something is detected.

---

## How it works

**Frontend**
A web app that runs entirely in the browser with no install required. It captures camera frames, handles voice detection via the Web Speech API, and drives haptic feedback.

**AI Vision**
Each camera frame is sent to the Anthropic Claude API, which analyzes the scene and returns a hazard level (safe, warning, or urgent) along with a short description that is spoken aloud.

**Voice**
ElevenLabs provides natural, human-sounding voice output for a more calming and intelligible experience than browser text-to-speech alone.

**Navigation**
Google Maps Places and Directions APIs power the location search and turn-by-turn directions, delivered entirely through voice and haptics.

**Backend**
A FastAPI server handles all API orchestration and reverse geocoding, with a WebSocket endpoint that streams live location and hazard data to the dashboard.

**Data**
Snowflake stores the event log, including every scan result, location update, and hazard detection, giving a queryable history of each session.

**Dashboard**
A standalone HTML page connects via WebSocket and displays the user's live position on a dark-mode Google Maps interface alongside a real-time obstacle log.

---

## Stack

- Anthropic Claude API
- ElevenLabs
- Google Maps (Places + Directions)
- FastAPI
- Snowflake
- Web Speech API
- HTML / CSS / JavaScript

---

## Getting started

### Prerequisites

- Python 3.10 or higher
- A modern browser (Chrome recommended for Web Speech API support)
- API keys for Anthropic, ElevenLabs, Google Maps, and Snowflake

### Setup

1. Clone the repository

```bash
git clone https://github.com/your-username/birdbox.git
cd birdbox
```

2. Install backend dependencies

```bash
cd backend
pip install -r requirements.txt
```

3. Create a `.env` file inside the `backend/` folder with your API keys

```
ANTHROPIC_API_KEY=your_key
ELEVENLABS_API_KEY=your_key
GOOGLE_MAPS_API_KEY=your_key
SNOWFLAKE_ACCOUNT=your_account
SNOWFLAKE_USER=your_user
SNOWFLAKE_PASSWORD=your_password
SNOWFLAKE_WAREHOUSE=COMPUTE_WH
SNOWFLAKE_DATABASE=SMARTCANE_DB
SNOWFLAKE_SCHEMA=PUBLIC
```

4. Start the backend server

```bash
uvicorn main:app --reload
```

5. Expose the server with ngrok

```bash
ngrok http 8000
```

6. Open `frontend/index.html` in your browser to use the phone app, or `frontend/dashboard.html` for the live dashboard. Update the backend URL in both files to match your ngrok URL.

---

## Project structure

```
birdbox/
├── backend/
│   ├── main.py
│   ├── requirements.txt
│   └── .env
├── frontend/
│   ├── index.html
│   ├── index.css
│   ├── index.js
│   ├── dashboard.html
│   ├── dashboard.css
│   └── dashboard.js
├── .gitignore
└── README.md
```

---

## What we learned

Designing for users who cannot look at a screen forces you to rethink every assumption about UI. Every piece of information has to be communicated through voice, timing, or touch, which made us much more deliberate about what the AI says, when it says it, and how long it takes. Balancing multiple AI APIs in real time, where a slow call can mean a missed hazard warning, required careful async handling and fallback logic throughout the backend.

---

## What is next

We plan to make the hazard detection smarter, with better distinction between hazard types and distance estimation. Longer term, we want to add user profiles in Snowflake so the system can learn frequently visited routes over time.
