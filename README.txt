================================================================================
                            EAGLE WEB IDE (Python + JavaScript)
================================================================================

A browser-based IDE with real-time code execution for Python and JavaScript,
AI-powered features, assignment management, and interactive challenges for
educational environments.

================================================================================
                              TABLE OF CONTENTS
================================================================================

1. System Requirements
2. Installation
3. Configuration
4. Running the Application
5. Using the IDE
6. AI Features
7. Assignment System
8. Admin Panel
9. File Structure
10. Important Notes
11. Troubleshooting
12. Network Deployment

================================================================================
                           1. SYSTEM REQUIREMENTS
================================================================================

Required:
- Python 3.8 or higher
- Node.js 18 or higher (for JavaScript execution)
- Modern web browser (Chrome, Firefox, Edge, Safari)
- Internet connection (for CDN resources)

Optional (for AI features):
- Ollama installed and running (https://ollama.ai)
- Compatible AI model (default: gemma3:4b)

--------------------------------------------------
INSTALLING NODE.JS
--------------------------------------------------
Node.js is required for JavaScript (.js) file execution.

  Ubuntu/Debian:
    sudo apt install nodejs

  Fedora/RHEL:
    sudo dnf install nodejs

  macOS (with Homebrew):
    brew install node

  Windows:
    Download installer from https://nodejs.org/

Verify installation:
  node --version    # should print v18 or higher

================================================================================
                              2. INSTALLATION
================================================================================

Step 1: Clone or download the repository
  git clone https://github.com/bkgodwin/EagleIDE.git
  cd EagleIDE

Step 2: Install Python dependencies
  pip install -r requirements.txt

Step 3: Verify installation
  python app.py

The server should start on http://0.0.0.0:8000

================================================================================
                             3. CONFIGURATION
================================================================================

Configuration is managed through config.py. Key settings include:

--------------------------------------------------
ADMIN PASSWORD (CRITICAL - CHANGE THIS!)
--------------------------------------------------
DEFAULT_ADMIN_PASSWORD = "password"

⚠️ WARNING: Change this immediately before deployment!
This password protects admin functions including:
- Assignment management
- Configuration changes
- Student submission access

--------------------------------------------------
AI/OLLAMA CONFIGURATION
--------------------------------------------------
"ai_explainer_enabled": True          # Master toggle for all AI features
"ai_ollama_url": "http://192.168.0.105:11434"  # Ollama server URL
"ai_model": "gemma3:4b"              # AI model name

Ollama URL Examples:
- Local installation: "http://127.0.0.1:11434" or "http://localhost:11434"
- Network server: "http://192.168.0.105:11434"
- Remote server: "http://your-server-ip:11434"

To disable AI features: Set "ai_explainer_enabled": False

--------------------------------------------------
LESSON CONFIGURATION
--------------------------------------------------
"lesson_url": "https://..."          # External lesson URL
"lesson_use_local": False            # Use local HTML instead of URL
"lesson_html": "&lt;p&gt;...&lt;/p&gt;"           # Local lesson content (if enabled)

--------------------------------------------------
PAGE CUSTOMIZATION
--------------------------------------------------
"page_title": "Eagle IDE (Python)"
"topbar_color": "linear-gradient(90deg,#a5c8f0,#7fb2eb)"
"notes_html": "&lt;h2&gt;Welcome&lt;/h2&gt;..."       # Notes panel content

--------------------------------------------------
AI ASSISTANT BEHAVIOR
--------------------------------------------------
"ai_assistant_preprompt": "..."      # System prompt for AI tutor
Customize how the AI assistant responds to students.

--------------------------------------------------
ENVIRONMENT VARIABLES (Optional)
--------------------------------------------------
You can also use environment variables:
- ADMIN_PASSWORD: Override default admin password
- HOST: Server host (default: 0.0.0.0)
- PORT: Server port (default: 8000)

Example:
  export ADMIN_PASSWORD="MySecurePassword123"
  export PORT=5000
  python app.py

================================================================================
                        4. RUNNING THE APPLICATION
================================================================================

--------------------------------------------------
BASIC USAGE
--------------------------------------------------
python app.py

The server will start at: http://0.0.0.0:8000

--------------------------------------------------
CUSTOM HOST/PORT
--------------------------------------------------
HOST=127.0.0.1 PORT=5000 python app.py

--------------------------------------------------
PRODUCTION DEPLOYMENT
--------------------------------------------------
For production use, consider:
1. Using a production WSGI server (gunicorn, waitress)
2. Setting up reverse proxy (nginx, Apache)
3. Enabling HTTPS
4. Changing the admin password
5. Restricting network access as needed

================================================================================
                            5. USING THE IDE
================================================================================

Students can:
1. Write Python or JavaScript code in the editor
2. Run code with the "Run ▶" button
3. Stop execution with "Stop ⏹"
4. Create, save, and run .py and .js files
5. Import/export .py, .js, or .txt files
6. Adjust font size with the slider
7. View output in the terminal panel
8. Provide input when programs use input()
9. View lessons and notes in the sidebar

Features:
- Syntax highlighting for Python and JavaScript
- Auto-indentation
- Line numbers
- Error highlighting
- Real-time code execution (30 second timeout)
- Interactive input support (input() works in both Python and JavaScript)

--------------------------------------------------
JAVASCRIPT SUPPORT
--------------------------------------------------
- Create .js files in the file browser
- The editor switches to JavaScript syntax highlighting automatically
- A synchronous input() function is available in JavaScript files:
    let name = input("Enter your name: ");
    console.log("Hello, " + name + "!");
- Output (console.log, console.error, etc.) appears in the shell
- All shell input features work the same as with Python
- JavaScript files are identified by the ⚡ icon in the file browser
- The "JS" badge in the top bar confirms JavaScript compatibility

================================================================================
                            6. AI FEATURES
================================================================================

Requires Ollama to be running with a compatible model.

--------------------------------------------------
CODE EXPLAINER
--------------------------------------------------
- Click "Explain Code" button
- AI analyzes your code and provides feedback
- Identifies errors and suggests fixes
- 30-90 second cooldown between requests

--------------------------------------------------
CODING CHALLENGES
--------------------------------------------------
- Select difficulty level (1-5)
- Get random challenge from challenges.csv
- Submit solution for AI grading while signed in
- Each account keeps one latest score per challenge
- Leaderboard totals all challenge scores for every account (including 0-point accounts)

--------------------------------------------------
AI ASSISTANT (TUTOR)
--------------------------------------------------
- Chat-based help for Python questions
- Provides hints, not complete solutions
- 15 second cooldown per message
- Guided learning approach

================================================================================
                          7. ASSIGNMENT SYSTEM
================================================================================

--------------------------------------------------
FOR STUDENTS
--------------------------------------------------
1. View active assignments in Assignments tab
2. Click assignment to view details
3. Sign in with your student account
4. Choose one of your saved files to submit
5. The selected file is copied to the admin account's assignment folder and renamed to the student's name, with a submission comment at the top that includes student name and timestamp
6. Resubmissions replace your previous file for that assignment

--------------------------------------------------
FOR TEACHERS/ADMINS
--------------------------------------------------
1. Login to admin panel
2. Create new assignments with:
   - Assignment name
   - Task description
   - Maximum score
3. Lock/unlock assignments
4. Edit or delete assignments from the assignment manager
5. Open submitted files directly from the admin workspace
6. Grade from the left sidebar with auto-saving score changes or AI grading
7. Review alphabetized score tables and download scores as CSV

================================================================================
                            8. ADMIN PANEL
================================================================================

Access: Click "Admin" button, login with password

--------------------------------------------------
CAPABILITIES
--------------------------------------------------
- Edit notes and lesson content
- Configure AI settings
- Customize page appearance
- Create/manage assignments
- View all submissions
- Grade student work
- Export grades to CSV
- Manage challenges
- View student account last sign-in timestamps

--------------------------------------------------
IMPORTANT
--------------------------------------------------
Admin sessions are temporary and cleared on server restart.
Always keep your admin password secure.

================================================================================
                          9. FILE STRUCTURE
================================================================================

Core Files:
  app.py              - Main Flask application server
  config.py           - Configuration settings
  index.html          - Single-page web interface
  challenges.csv      - Coding challenge bank
  requirements.txt    - Python dependencies
  README.txt          - This file

Auto-Generated Directories:
  sandboxes/          - Temporary code execution folders
  assignments/        - Assignment JSON files  
  
Auto-Generated Files:
  config.txt          - Runtime configuration (persisted)
  users.json          - Student account records
  challenge_scores.json - Per-account challenge score tracker

================================================================================
                          10. IMPORTANT NOTES
================================================================================

⚠️ SECURITY
--------------------------------------------------
- Change DEFAULT_ADMIN_PASSWORD before deployment
- Server executes arbitrary Python and JavaScript code - use in trusted environments
- Python code runs in a sandboxed subprocess with import and filesystem restrictions
- JavaScript code runs via Node.js; it has access to the Node.js standard library
  (consider network isolation for student use)
- 30 second execution timeout prevents infinite loops
- Consider network isolation for student use

⚠️ OLLAMA CONFIGURATION
--------------------------------------------------
If Ollama is on the SAME machine:
  "ai_ollama_url": "http://127.0.0.1:11434"

If Ollama is on a DIFFERENT machine:
  "ai_ollama_url": "http://&lt;ollama-server-ip&gt;:11434"
  Example: "http://192.168.0.105:11434"

Make sure Ollama is running and the model is downloaded:
  ollama serve
  ollama pull gemma3:4b

⚠️ CHALLENGES.CSV FORMAT
--------------------------------------------------
File must have columns: difficulty,points,text
Example:
  difficulty,points,text
  1,5,Write a function that adds two numbers
  2,10,Create a loop that prints even numbers from 1 to 20

================================================================================
                          11. TROUBLESHOOTING
================================================================================

Problem: JavaScript files won't run
Solution:
- Verify Node.js is installed: node --version
- Ensure version is 18 or higher
- Check that the file has a .js extension
- Check browser console for errors

Problem: input() not working in JavaScript
Solution:
- The input() function is provided automatically for .js files
- Wait for [[_IDE_INPUT_]] token to appear in the shell
- Type your input and press Send or Enter
- Do NOT use readline or process.stdin directly; use input() instead

Problem: Server won't start
Solution: Check if port 8000 is already in use, try different port

Problem: AI features not working
Solution: 
- Verify Ollama is running: ollama serve
- Check Ollama URL in config.py
- Verify model is installed: ollama list
- Check ai_explainer_enabled is True

Problem: Code won't execute
Solution:
- Check browser console for errors
- Verify Python is installed
- Check file permissions on sandboxes/ directory

Problem: Can't login to admin
Solution:
- Verify password in config.py
- Check for typos
- Server restart clears admin tokens

Problem: Input() not working
Solution:
- Wait for [[_IDE_INPUT_]] token to appear
- Type input and press Send or Enter
- Check terminal panel is visible

================================================================================
                        12. NETWORK DEPLOYMENT
================================================================================

For classroom or multi-user deployment:

1. Find server IP address:
   - Windows: ipconfig
   - Mac/Linux: ifconfig or ip addr

2. Start server on all interfaces:
   HOST=0.0.0.0 PORT=8000 python app.py

3. Students access via:
   http://&lt;server-ip&gt;:8000
   Example: http://192.168.1.100:8000

4. Configure firewall to allow port 8000

5. If using Ollama on a different machine:
   - Update ai_ollama_url in config.py
   - Ensure Ollama server is accessible on network

================================================================================

For support or issues: https://github.com/bkgodwin/EagleIDE

Last Updated: 2026-05-13
