# Default admin password
DEFAULT_ADMIN_PASSWORD = "password"

# Server UI defaults and AI settings
DEFAULT_CONFIG = {
    # Notes / lesson
    "notes_html": "<h2>Welcome</h2><p>Edit me in Admin.</p>",
    "lesson_url": "https://publish.obsidian.md/mrgodwinsclassroom/Coding/Coding+1/2.+Python+Basics/1.+What+Is+Python",
    "lesson_use_local": False,
    "lesson_html": "<p>(No local lesson yet)</p>",

    # AI master toggle + model/endpoint (used by Explain, Challenge, and Assistant)
    "ai_explainer_enabled": True,
    "ai_ollama_url": "http://127.0.0.1:11434",
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
    "page_title": "Eagles Web IDE (Python)",
    "topbar_color": "linear-gradient(90deg,#a5c8f0,#7fb2eb)",
}
