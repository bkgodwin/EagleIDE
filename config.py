# Default admin credentials
DEFAULT_ADMIN_PASSWORD = "password"
ADMIN_EMAIL = "admin@eagleide.local"

# Server port
SERVER_PORT = 8000

# Debug mode: set True to show full Flask/werkzeug request logs,
# False to only show startup status and errors.
DEBUG_MODE = False

# File storage limit per user
USER_STORAGE_LIMIT_MB = 250

# Server UI defaults and AI settings
DEFAULT_CONFIG = {
    # Notes / lesson
    "notes_html": "<h2>Welcome</h2><p>Edit me in Admin.</p>",
    "lesson_url": "https://publish.obsidian.md/mrgodwinsclassroom/Coding/Coding+1/2.+Python+Basics/1.+What+Is+Python",
    "lesson_use_local": False,
    "lesson_html": "<p>(No local lesson yet)</p>",

    # AI master toggle + model/endpoint (used by Explain, Challenge, and Assistant)
    "ai_explainer_enabled": True,
    "ai_ollama_url": "http://192.168.0.105:11434",
    "ai_model": "gemma3:4b",

    # NEW: AI Assistant preprompt (editable in Admin)
    "ai_assistant_preprompt": (
        "You are a helpful Python tutor for high-school students. "
        "Only answer questions about programming and debugging code. "
        "Keep responses brief (2-3 sentences max). "
        "Never write complete solutions - guide students with hints and questions. "
        "If a question is not about coding, politely decline and redirect to Python topics."
    ),
    
    # Page customization settings
    "page_title": "Eagle IDE (Python)",
    "topbar_color": "linear-gradient(90deg,#a5c8f0,#7fb2eb)",

    # Registration toggle
    "registration_enabled": True,
}
